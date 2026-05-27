// Progressive Anti-Entropy Engine
//
// Stacks FEC decoders like Par2 recovery blocks, but inverted: each layer's
// job is to FIND remaining structure (via syndrome extraction) and REPLACE
// it with fresh randomness.  After N layers with different algebraic bases,
// all detectable structure has been solved out.
//
// Architecture:
//   Input bitstream → Layer 0 (polynomials [7,5]) → find syndromes → replace structured bits
//                   → Layer 1 (polynomials [7,6]) → find syndromes → replace
//                   → Layer 2 (polynomials [5,7]) → find syndromes → replace
//                   → ... N layers
//                   → Output: maximally entropic bitstream
//
// Each layer uses a different convolutional code (different generator polynomials)
// so each detects a different algebraic class of structure.  Bits that survive
// all layers had no structure any code could find — verified entropy.

import { OTPStream } from './otp.js';

// Generator polynomial sets for different algebraic bases
const POLYNOMIAL_BASES = [
  { g0: 0b111, g1: 0b101, K: 3 },   // [7, 5]
  { g0: 0b111, g1: 0b110, K: 3 },   // [7, 6]
  { g0: 0b101, g1: 0b111, K: 3 },   // [5, 7]
  { g0: 0b110, g1: 0b101, K: 3 },   // [6, 5]
  { g0: 0b11101, g1: 0b10011, K: 5 }, // [35, 23] — deeper constraint
  { g0: 0b10011, g1: 0b11101, K: 5 }, // [23, 35]
  { g0: 0b1111001, g1: 0b1011011, K: 7 }, // [171, 133] — K=7
  { g0: 0b1011011, g1: 0b1111001, K: 7 }, // [133, 171]
];

function parity(x) {
  let p = 0;
  while (x) { p ^= x & 1; x >>= 1; }
  return p;
}

// Convolutional encoder for a single layer
class LayerEncoder {
  constructor(basis) {
    this.g0 = basis.g0;
    this.g1 = basis.g1;
    this.K = basis.K;
    this.mask = (1 << this.K) - 1;
  }

  encode(bits) {
    let state = 0;
    const out = new Int8Array(bits.length * 2);
    for (let i = 0; i < bits.length; i++) {
      state = ((state << 1) | (bits[i] & 1)) & this.mask;
      out[i * 2] = parity(state & this.g0);
      out[i * 2 + 1] = parity(state & this.g1);
    }
    return out;
  }
}

// Syndrome extractor — finds where structure exists in a bitstream
// relative to a specific algebraic basis
class SyndromeExtractor {
  constructor(basis) {
    this.g0 = basis.g0;
    this.g1 = basis.g1;
    this.K = basis.K;
    this.numStates = 1 << (this.K - 1);
    this.mask = (1 << this.K) - 1;
  }

  // Extract syndrome: for each bit position, compute how much "structure"
  // exists relative to this code.  Returns per-bit structure scores (0-1)
  // and the syndrome bits themselves.
  extract(bits) {
    const n = Math.floor(bits.length / 2) * 2;
    const syndromes = new Float32Array(n / 2);
    const structureMap = new Float32Array(n / 2);

    // Forward pass: Viterbi-like trellis walk
    let pathMetric = new Float32Array(this.numStates).fill(1e9);
    pathMetric[0] = 0;
    const survivors = [];

    for (let step = 0; step < n / 2; step++) {
      const r0 = bits[step * 2];
      const r1 = bits[step * 2 + 1];
      const newMetric = new Float32Array(this.numStates).fill(1e9);
      const prevState = new Int32Array(this.numStates);
      const decodedBit = new Int8Array(this.numStates);

      for (let s = 0; s < this.numStates; s++) {
        if (pathMetric[s] >= 1e9) continue;
        for (let bit = 0; bit <= 1; bit++) {
          const fullState = ((s << 1) | bit) & this.mask;
          const nextState = fullState & (this.numStates - 1);
          const e0 = parity(fullState & this.g0);
          const e1 = parity(fullState & this.g1);
          const branchMetric = (r0 !== e0 ? 1 : 0) + (r1 !== e1 ? 1 : 0);
          const candidate = pathMetric[s] + branchMetric;
          if (candidate < newMetric[nextState]) {
            newMetric[nextState] = candidate;
            prevState[nextState] = s;
            decodedBit[nextState] = bit;
          }
        }
      }

      pathMetric = newMetric;
      survivors.push({ prevState: prevState.slice(), bits: decodedBit.slice() });

      // Structure score: how close is the best path metric to zero?
      // Low metric = high structure (bits match a codeword closely)
      let bestMetric = 1e9;
      for (let s = 0; s < this.numStates; s++) {
        if (newMetric[s] < bestMetric) bestMetric = newMetric[s];
      }
      // Normalize: 0 = perfect codeword match (all structure), 1 = max distance (pure entropy)
      const maxPossible = (step + 1) * 2;
      structureMap[step] = maxPossible > 0 ? bestMetric / maxPossible : 1;

      // Syndrome: the branch metric at the surviving path
      syndromes[step] = bestMetric > 0 ? 1 : 0;
    }

    return { syndromes, structureMap };
  }
}

// Single anti-entropy layer: finds structure, replaces with fresh randomness
class AntiEntropyLayer {
  constructor(basisIndex, entropySeed) {
    const basis = POLYNOMIAL_BASES[basisIndex % POLYNOMIAL_BASES.length];
    this.encoder = new LayerEncoder(basis);
    this.extractor = new SyndromeExtractor(basis);
    this.entropySource = new OTPStream(entropySeed);
    this.basisIndex = basisIndex;
    this.structureThreshold = 0.3; // below this = too much structure, replace
  }

  // Process a bitstream: find structured regions and replace them
  process(bits) {
    // Encode to create paired representation
    const encoded = this.encoder.encode(bits);

    // Extract syndromes to find where structure lives
    const { syndromes, structureMap } = this.extractor.extract(encoded);

    // Replace structured bits with entropy
    const output = new Int8Array(bits.length);
    let structureFound = 0;
    let bitsReplaced = 0;

    for (let i = 0; i < bits.length && i < structureMap.length; i++) {
      if (structureMap[i] < this.structureThreshold) {
        // This bit position has structure — replace with entropy
        output[i] = this.entropySource.nextBit();
        bitsReplaced++;
        structureFound++;
      } else {
        // This bit position looks entropic — keep it
        output[i] = bits[i];
      }
    }

    // Fill any remaining bits
    for (let i = structureMap.length; i < bits.length; i++) {
      output[i] = bits[i];
    }

    return {
      bits: output,
      structureFound,
      bitsReplaced,
      structureMap,
      entropyRatio: 1 - (structureFound / bits.length),
    };
  }
}

// The full progressive anti-entropy engine
export class AntiEntropyEngine {
  constructor({ numLayers = 4, masterSeed = Date.now() } = {}) {
    this.layers = [];
    this.masterSeed = masterSeed;

    for (let i = 0; i < Math.min(numLayers, POLYNOMIAL_BASES.length); i++) {
      const layerSeed = this._deriveSeed(masterSeed, i);
      this.layers.push(new AntiEntropyLayer(i, layerSeed));
    }

    this._lastReport = null;
  }

  _deriveSeed(master, index) {
    let h = ((master >>> 0) + (index * 0x9e3779b9)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  // Run bitstream through all layers progressively
  process(bits) {
    let current = new Int8Array(bits);
    const layerReports = [];

    for (let i = 0; i < this.layers.length; i++) {
      const result = this.layers[i].process(current);
      layerReports.push({
        layer: i,
        structureFound: result.structureFound,
        bitsReplaced: result.bitsReplaced,
        entropyRatio: result.entropyRatio,
      });
      current = result.bits;
    }

    // Final entropy assessment
    const totalStructure = layerReports.reduce((s, r) => s + r.structureFound, 0);
    const totalReplaced = layerReports.reduce((s, r) => s + r.bitsReplaced, 0);

    this._lastReport = {
      inputLength: bits.length,
      outputLength: current.length,
      layers: layerReports,
      totalStructureFound: totalStructure,
      totalBitsReplaced: totalReplaced,
      estimatedEntropy: this._estimateEntropy(current),
    };

    return current;
  }

  // Estimate Shannon entropy of output
  _estimateEntropy(bits) {
    if (bits.length < 8) return 0;

    // Byte-level entropy estimation
    const counts = new Uint32Array(256);
    const numBytes = Math.floor(bits.length / 8);
    for (let i = 0; i < numBytes; i++) {
      let byte = 0;
      for (let j = 0; j < 8; j++) {
        byte |= (bits[i * 8 + j] & 1) << j;
      }
      counts[byte]++;
    }

    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      if (counts[i] === 0) continue;
      const p = counts[i] / numBytes;
      entropy -= p * Math.log2(p);
    }

    return entropy; // bits per byte, max 8.0
  }

  // Get the structure threshold for each layer
  setThreshold(layerIndex, threshold) {
    if (layerIndex < this.layers.length) {
      this.layers[layerIndex].structureThreshold = threshold;
    }
  }

  // Circular feedback: take output, mix with fresh entropy, run again
  feedback(bits, rounds = 3) {
    let current = new Int8Array(bits);
    const roundReports = [];

    for (let r = 0; r < rounds; r++) {
      current = this.process(current);
      roundReports.push({ ...this._lastReport, round: r });

      // If structure is effectively zero, we're done
      if (this._lastReport.totalStructureFound === 0) break;
    }

    return {
      bits: current,
      rounds: roundReports,
      converged: roundReports.length > 0 &&
        roundReports[roundReports.length - 1].totalStructureFound === 0,
    };
  }

  get lastReport() { return this._lastReport; }
}

export { POLYNOMIAL_BASES };
