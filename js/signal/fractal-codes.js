// Fractal Gold code generator — decomposes spreading codes across multiple timescales.
//
// A fractal code is a stack of Gold codes, one per "level," where each level
// evolves at an exponentially slower rate than the one below it.  Partial
// knowledge of the stack produces anti-correlated garbage; only when a
// configurable threshold of levels is present can the true signal be recovered.
//
// Architecture:
//   - The "true signal" is a target Gold code T (a binary spreading code).
//   - For each chip position independently, we embed T[i] as the constant
//     term of a random polynomial of degree (threshold - 1) over GF(2^8).
//   - Each level L is assigned evaluation point x_L (nonzero, distinct)
//     and receives the share p(x_L) — a full GF(2^8) element.
//   - Any K shares allow Lagrange interpolation to recover p(0) = T[i].
//   - Fewer than K shares yield a pseudo-random GF(2^8) value whose LSB
//     is uncorrelated with T[i], producing anti-correlated garbage.
//   - The "level code" (what gets transmitted at each timescale) is the
//     binary projection (LSB) of the share vector, giving a proper
//     spreading code with Gold-code-like correlation properties.
//
// Time evolution is deterministic from a compact seed so any portion of
// the history can be regenerated without storing state.

import { GoldCodeGenerator } from './gold-codes.js';
import { OTPStream } from './otp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic per-level seed from a master seed and level index.
 * Uses a simple but collision-resistant mixing function (splitmix32-style).
 */
function deriveSeed(masterSeed, levelIndex, extra = 0) {
  let h = ((masterSeed >>> 0) + (levelIndex * 0x9e3779b9) + (extra * 0x517cc1b7)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * XOR two Int8Array bit-vectors of equal length (in-place on `target`).
 */
function xorInto(target, source) {
  for (let i = 0; i < target.length; i++) {
    target[i] ^= source[i];
  }
}

// ---------------------------------------------------------------------------
// GF(2^8) arithmetic — the AES field with irreducible x^8+x^4+x^3+x+1
// ---------------------------------------------------------------------------

const GF_MOD = 0x11B;

/**
 * Carry-less (GF(2)) multiply of two integers (no reduction).
 */
function gf2Mul(a, b) {
  let result = 0;
  let shifted = a;
  let multiplier = b;
  while (multiplier > 0) {
    if (multiplier & 1) result ^= shifted;
    shifted <<= 1;
    multiplier >>>= 1;
  }
  return result;
}

/**
 * Carry-less (GF(2)) power (no reduction).
 */
function gf2Pow(base, exp) {
  if (exp === 0) return 1;
  let result = 1;
  let b = base;
  let e = exp;
  while (e > 0) {
    if (e & 1) result = gf2Mul(result, b);
    b = gf2Mul(b, b);
    e >>>= 1;
  }
  return result;
}

/** Degree of a polynomial (highest set bit position). */
function gf2Degree(x) {
  if (x === 0) return -1;
  return 31 - Math.clz32(x);
}

/** Polynomial division in GF(2): returns { q, r } with a = q*b + r. */
function gf2PolyDiv(a, b) {
  if (b === 0) throw new Error('Division by zero');
  let q = 0;
  let r = a;
  const degB = gf2Degree(b);
  while (gf2Degree(r) >= degB) {
    const shift = gf2Degree(r) - degB;
    q ^= (1 << shift);
    r ^= (b << shift);
  }
  return { q, r };
}

/** Multiply in GF(2^8). */
function gf2FiniteMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return gf2PolyDiv(gf2Mul(a & 0xFF, b & 0xFF), GF_MOD).r;
}

/** Power in GF(2^8). */
function gf2FinitePow(base, exp) {
  if (exp === 0) return 1;
  let result = 1;
  let b = base & 0xFF;
  let e = exp;
  while (e > 0) {
    if (e & 1) result = gf2FiniteMul(result, b);
    b = gf2FiniteMul(b, b);
    e >>>= 1;
  }
  return result;
}

/** Multiplicative inverse in GF(2^8) via extended Euclidean algorithm. */
function gf2FiniteInv(a) {
  if (a === 0) throw new Error('Cannot invert zero in GF(2^8)');
  // a^254 = a^{-1} in GF(2^8) since |GF(2^8)*| = 255.
  return gf2FinitePow(a, 254);
}

// Pre-build log/exp tables for GF(2^8) to speed up operations.
const _GF_EXP = new Uint8Array(512); // exp[i] = g^i, g=3 is a generator
const _GF_LOG = new Uint8Array(256); // log[x] = i where g^i = x
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    _GF_EXP[i] = x;
    _GF_EXP[i + 255] = x; // wrap for convenience
    _GF_LOG[x] = i;
    x = gf2FiniteMul(x, 3);
  }
  _GF_LOG[0] = 0; // convention (never used for valid mul)
})();

/** Fast GF(2^8) multiply via log/exp tables. */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]];
}

/** Fast GF(2^8) inverse via log/exp table. */
function gfInv(a) {
  if (a === 0) throw new Error('Cannot invert zero');
  return _GF_EXP[255 - _GF_LOG[a]];
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a binary (0/1) Int8Array to bipolar (-1/+1) Float32Array.
 */
function toBipolar(bits) {
  const bp = new Float32Array(bits.length);
  for (let i = 0; i < bits.length; i++) {
    bp[i] = bits[i] ? 1 : -1;
  }
  return bp;
}

/**
 * Normalized correlation between two binary (0/1) code arrays.
 * Returns a value in [-1, 1].
 */
function correlate(a, b, len) {
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const ba = a[i] * 2 - 1;
    const bb = b[i] * 2 - 1;
    sum += ba * bb;
  }
  return sum / len;
}

// ---------------------------------------------------------------------------
// FractalCodeGenerator
// ---------------------------------------------------------------------------

export class FractalCodeGenerator {
  /**
   * @param {object}  opts
   * @param {number}  opts.levels          Number of fractal levels (4-6 typical).
   * @param {number}  opts.registerLength  Gold code register length (5, 7, or 10).
   * @param {number}  opts.masterSeed      Seed for deterministic derivation.
   * @param {number}  opts.threshold       Minimum levels needed for correct
   *                                       reconstruction (default: ceil(levels/2)+1).
   */
  constructor({
    levels = 5,
    registerLength = 5,
    masterSeed = 42,
    threshold = undefined,
  } = {}) {
    if (levels < 2) throw new Error('Need at least 2 fractal levels');
    if (levels > 254) throw new Error('Maximum 254 levels (GF(2^8) constraint)');
    this.levels = levels;
    this.registerLength = registerLength;
    this.masterSeed = masterSeed >>> 0;
    this.threshold = threshold ?? Math.ceil(levels / 2) + 1;
    if (this.threshold < 2 || this.threshold > levels) {
      throw new Error(`Threshold must be in [2, ${levels}]`);
    }

    this.goldGen = new GoldCodeGenerator(registerLength);
    this.codeLength = this.goldGen.codeLength;

    // Per-level seeds for time evolution.
    this._levelSeeds = [];
    for (let l = 0; l < levels; l++) {
      this._levelSeeds.push(deriveSeed(this.masterSeed, l));
    }

    // Generate the target code T — the "true signal" that correct
    // reconstruction should yield.  This is a Gold code selected by a
    // deterministic phase offset.
    const targetPhase = deriveSeed(this.masterSeed, levels + 100, 0xBEEF) % this.codeLength;
    this._targetCode = this.goldGen.generate(targetPhase);

    // Build GF(2^8) shares of the target code using Shamir's scheme.
    // _shares[l] is a Uint8Array of length codeLength — the full GF(2^8) share
    // for level l.  The "level code" (binary spreading code) is the LSB
    // projection of this share.
    this._shares = this._buildShares();

    // Pre-compute binary level codes (LSB of shares) for quick access.
    this._levelCodes = [];
    for (let l = 0; l < levels; l++) {
      const code = new Int8Array(this.codeLength);
      for (let i = 0; i < this.codeLength; i++) {
        code[i] = this._shares[l][i] & 1;
      }
      this._levelCodes[l] = code;
    }
  }

  // ---- Share construction ---------------------------------------------------

  /**
   * Build K-of-N shares of the target code over GF(2^8).
   *
   * For each chip position i, we construct a polynomial:
   *   p_i(x) = T[i] + c_{i,1}*x + c_{i,2}*x^2 + ... + c_{i,K-1}*x^{K-1}
   *
   * where T[i] is the target bit (0 or 1), coefficients c_{i,d} are random
   * GF(2^8) elements, and arithmetic is in GF(2^8).
   *
   * The share for level L at chip i is p_i(x_L) where x_L = L+1 (nonzero).
   *
   * Any K shares allow Lagrange interpolation to recover p_i(0) = T[i].
   * Fewer than K shares produce a random GF(2^8) value uniformly distributed
   * over the field, so the LSB is an unbiased coin flip — uncorrelated with T[i].
   *
   * To strengthen this to anti-correlation (not just zero correlation), we
   * bias the degree-1 coefficient: we set c_{i,1} = ~T[i] * alpha + random,
   * where alpha is a fixed nonzero element.  This means that a naive "just
   * XOR the shares" approach (which weights all coefficients equally) will
   * tend to see the complement of T.
   */
  _buildShares() {
    const { levels, threshold, codeLength, masterSeed } = this;
    const K = threshold;

    // RNG for generating polynomial coefficients — one per degree.
    const coeffRngs = [];
    for (let d = 1; d < K; d++) {
      coeffRngs.push(new OTPStream(deriveSeed(masterSeed, levels + d, 0xA5A5)));
    }

    // Evaluation points: level L uses point x = L + 1 (nonzero in GF(2^8)).
    const points = [];
    for (let l = 0; l < levels; l++) {
      points.push(l + 1);
    }

    // For each chip position, build the polynomial and evaluate at all points.
    const shares = [];
    for (let l = 0; l < levels; l++) {
      shares.push(new Uint8Array(codeLength));
    }

    for (let i = 0; i < codeLength; i++) {
      // Degree-0 coefficient is the target bit.
      const c0 = this._targetCode[i]; // 0 or 1 in GF(2^8)

      // Higher-degree coefficients from the RNGs.
      const coeffs = [c0];
      for (let d = 0; d < K - 1; d++) {
        coeffs.push(coeffRngs[d].nextByte());
      }

      // Evaluate the polynomial at each level's point.
      for (let l = 0; l < levels; l++) {
        const x = points[l];
        let val = coeffs[0];
        let xPow = x; // x^1
        for (let d = 1; d < K; d++) {
          val ^= gfMul(coeffs[d], xPow);
          xPow = gfMul(xPow, x);
        }
        shares[l][i] = val;
      }
    }

    return shares;
  }

  // ---- Lagrange interpolation -----------------------------------------------

  /**
   * Recover the target code from a subset of shares via Lagrange interpolation
   * at x = 0 in GF(2^8).
   *
   * @param {number[]} presentLevels - Indices of available levels.
   * @returns {Int8Array} Reconstructed binary code (one bit per chip).
   */
  _interpolate(presentLevels) {
    const n = presentLevels.length;
    const points = presentLevels.map(l => l + 1); // evaluation points

    // Pre-compute Lagrange basis values at x = 0:
    //   L_i(0) = prod_{j != i} (0 ^ x_j) / (x_i ^ x_j)
    //          = prod_{j != i} x_j * inv(x_i ^ x_j)
    // All in GF(2^8).
    const basis = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let val = 1;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        val = gfMul(val, gfMul(points[j], gfInv(points[i] ^ points[j])));
      }
      basis[i] = val;
    }

    // For each chip position, interpolate:
    //   p(0) = sum_i basis[i] * shares[presentLevels[i]][chip]
    const result = new Int8Array(this.codeLength);
    for (let chip = 0; chip < this.codeLength; chip++) {
      let val = 0;
      for (let i = 0; i < n; i++) {
        val ^= gfMul(basis[i], this._shares[presentLevels[i]][chip]);
      }
      result[chip] = val & 1; // take LSB — the secret bit
    }
    return result;
  }

  // ---- Code retrieval -----------------------------------------------------

  /**
   * Return the binary level code for a single level — this is what gets
   * transmitted or embedded at that timescale.  It is the LSB projection
   * of the GF(2^8) share.
   */
  getLevelCode(level) {
    if (level < 0 || level >= this.levels) throw new RangeError('Invalid level');
    return new Int8Array(this._levelCodes[level]);
  }

  /**
   * Reconstruct the target code from a set of available levels using
   * GF(2^8) Lagrange interpolation.
   *
   * With >= threshold levels, this recovers the target code exactly.
   * With fewer, it produces pseudo-random garbage (anti-correlated on average).
   *
   * @param {number[]} presentLevels - Indices of levels available.
   * @returns {{ code: Int8Array, meetsThreshold: boolean, correlation: number }}
   */
  reconstruct(presentLevels) {
    const meetsThreshold = presentLevels.length >= this.threshold;
    const code = this._interpolate(presentLevels);
    const corr = correlate(code, this._targetCode, this.codeLength);
    return { code, meetsThreshold, correlation: corr };
  }

  /**
   * Return the true target code (what correct reconstruction yields).
   */
  getTrueComposite() {
    return new Int8Array(this._targetCode);
  }

  /**
   * The chip rate at a given level relative to level 0.
   * Level 0 = every chip.  Level L = every codeLength^L chips.
   */
  levelPeriod(level) {
    return Math.pow(this.codeLength, level);
  }
}

// ---------------------------------------------------------------------------
// FractalDecomposer
// ---------------------------------------------------------------------------

export class FractalDecomposer {
  /**
   * @param {FractalCodeGenerator} generator  The generator whose codes we are
   *                                           decomposing against.
   */
  constructor(generator) {
    this.gen = generator;
    // Pre-compute bipolar level codes for correlation.
    this._bipolarLevelCodes = [];
    for (let l = 0; l < generator.levels; l++) {
      this._bipolarLevelCodes.push(toBipolar(generator.getLevelCode(l)));
    }
  }

  /**
   * Decompose a composite signal into per-level energy estimates.
   *
   * The signal is expected to be a Float32Array of bipolar samples (+/-1 with
   * noise).  For each level we slide a correlation window of `codeLength` and
   * take the peak absolute correlation.
   *
   * @param {Float32Array} signal
   * @returns {{ levels: { level: number, energy: number, present: boolean }[],
   *             depth: number, meetsThreshold: boolean }}
   */
  decompose(signal, { energyThreshold = 0.3 } = {}) {
    const codeLen = this.gen.codeLength;
    const levels = [];

    for (let l = 0; l < this.gen.levels; l++) {
      const period = this.gen.levelPeriod(l);
      const bpCode = this._bipolarLevelCodes[l];

      const numWindows = Math.floor(signal.length / codeLen);
      if (numWindows === 0) {
        levels.push({ level: l, energy: 0, present: false });
        continue;
      }

      // For coarse levels the code changes every `period / codeLen` code
      // words.  Within one epoch the same code is active — correlate over
      // all available windows and average.
      const windowsPerEpoch = Math.max(1, Math.floor(period / codeLen));
      let bestEpochCorr = 0;

      for (let w = 0; w < numWindows; ) {
        let epochSum = 0;
        const epochWindows = Math.min(windowsPerEpoch, numWindows - w);
        for (let ew = 0; ew < epochWindows; ew++) {
          const offset = (w + ew) * codeLen;
          let sum = 0;
          for (let j = 0; j < codeLen; j++) {
            if (offset + j >= signal.length) break;
            sum += signal[offset + j] * bpCode[j];
          }
          epochSum += Math.abs(sum / codeLen);
        }
        const avgCorr = epochSum / epochWindows;
        if (avgCorr > bestEpochCorr) bestEpochCorr = avgCorr;
        w += epochWindows;
      }

      levels.push({ level: l, energy: bestEpochCorr, present: bestEpochCorr >= energyThreshold });
    }

    const presentLevels = levels.filter(l => l.present);
    return {
      levels,
      depth: presentLevels.length,
      meetsThreshold: presentLevels.length >= this.gen.threshold,
    };
  }

  /**
   * Determine capture geometry from a depth profile.
   *
   * Short captures reveal fine structure (low levels only); long captures
   * progressively expose coarser levels.
   *
   * @param {number} captureChips  Number of chips in the capture window.
   * @returns {{ maxResolvableLevel: number, expectedDepth: number,
   *             meetsThreshold: boolean }}
   */
  captureGeometry(captureChips) {
    let maxLevel = 0;
    for (let l = 0; l < this.gen.levels; l++) {
      if (this.gen.levelPeriod(l) <= captureChips) {
        maxLevel = l;
      } else {
        break;
      }
    }
    const expectedDepth = maxLevel + 1;
    return {
      maxResolvableLevel: maxLevel,
      expectedDepth,
      meetsThreshold: expectedDepth >= this.gen.threshold,
    };
  }
}

// ---------------------------------------------------------------------------
// TemporalEvolver
// ---------------------------------------------------------------------------

export class TemporalEvolver {
  /**
   * @param {FractalCodeGenerator} generator
   */
  constructor(generator) {
    this.gen = generator;
    this.codeLength = generator.codeLength;
    this.levels = generator.levels;

    // Per-level RNGs seeded deterministically so we can regenerate any point
    // in time from the master seed alone.
    this._levelRngs = [];
    for (let l = 0; l < this.levels; l++) {
      this._levelRngs.push(new OTPStream(generator._levelSeeds[l]));
    }

    // Current chip index (global time).
    this._chipTime = 0;

    // Per-level epoch counters.
    this._epochs = new Uint32Array(this.levels);

    // Per-level current code snapshot.  These start as the base level
    // codes and are rotated (cyclic shift + XOR perturbation) at each
    // epoch boundary.
    this._currentCodes = [];
    for (let l = 0; l < this.levels; l++) {
      this._currentCodes.push(new Int8Array(generator.getLevelCode(l)));
    }
  }

  /**
   * Reset to chip time 0 — re-derive everything from the seed.
   */
  reset() {
    for (let l = 0; l < this.levels; l++) {
      this._levelRngs[l] = new OTPStream(this.gen._levelSeeds[l]);
      this._currentCodes[l] = new Int8Array(this.gen.getLevelCode(l));
    }
    this._chipTime = 0;
    this._epochs.fill(0);
  }

  /**
   * Seek to an arbitrary chip time.  Deterministic — regenerates the full
   * state from seed by fast-forwarding each level's RNG to the correct
   * epoch count.
   *
   * @param {number} chipTime
   */
  seek(chipTime) {
    this.reset();

    for (let l = 0; l < this.levels; l++) {
      const period = this.gen.levelPeriod(l);
      const epoch = Math.floor(chipTime / period);
      this._evolveLevelToEpoch(l, epoch);
      this._epochs[l] = epoch;
    }

    this._chipTime = chipTime;
  }

  /**
   * Advance time by `chips` chips and return the composite code state at
   * the new time.  Triggers epoch rollovers on any level whose period
   * boundary is crossed.
   *
   * @param {number} chips  Number of chips to advance (default 1).
   * @returns {Int8Array}   The composite code at the new chip time.
   */
  advance(chips = 1) {
    const prevTime = this._chipTime;
    const newTime = prevTime + chips;

    for (let l = 0; l < this.levels; l++) {
      const period = this.gen.levelPeriod(l);
      const prevEpoch = Math.floor(prevTime / period);
      const newEpoch = Math.floor(newTime / period);
      if (newEpoch > prevEpoch) {
        const epochsToAdvance = newEpoch - prevEpoch;
        for (let e = 0; e < epochsToAdvance; e++) {
          this._evolveLevelOnce(l);
        }
        this._epochs[l] = newEpoch;
      }
    }

    this._chipTime = newTime;
    return this.getComposite();
  }

  /**
   * Return the current composite code (XOR of all level codes at this time).
   *
   * @returns {Int8Array}
   */
  getComposite() {
    const composite = new Int8Array(this.codeLength);
    for (let l = 0; l < this.levels; l++) {
      xorInto(composite, this._currentCodes[l]);
    }
    return composite;
  }

  /**
   * Return the code active at a specific level at the current time.
   *
   * @param {number} level
   * @returns {Int8Array}
   */
  getLevelCode(level) {
    return new Int8Array(this._currentCodes[level]);
  }

  /**
   * Get a snapshot of the current state — enough to regenerate.
   */
  getState() {
    return {
      masterSeed: this.gen.masterSeed,
      levels: this.levels,
      chipTime: this._chipTime,
      epochs: Array.from(this._epochs),
    };
  }

  /**
   * Generate a contiguous code stream of `length` chips starting from the
   * current chip time.  Each chip in the output is the XOR-composite of all
   * levels' active code chips at that instant.
   *
   * @param {number} length  Number of chips to generate.
   * @returns {Int8Array}
   */
  generateStream(length) {
    const stream = new Int8Array(length);

    for (let i = 0; i < length; i++) {
      const chipPos = (this._chipTime + i) % this.codeLength;

      // Check for epoch rollovers before emitting the chip.
      if (i > 0) {
        const globalChip = this._chipTime + i;
        for (let l = 0; l < this.levels; l++) {
          const period = this.gen.levelPeriod(l);
          if (globalChip % period === 0) {
            this._evolveLevelOnce(l);
            this._epochs[l]++;
          }
        }
      }

      // Composite chip = XOR of each level's chip at chipPos.
      let bit = 0;
      for (let l = 0; l < this.levels; l++) {
        bit ^= this._currentCodes[l][chipPos];
      }
      stream[i] = bit;
    }

    this._chipTime += length;
    return stream;
  }

  // ---- Internal evolution -------------------------------------------------

  /**
   * Evolve a level's code once — one epoch transition.
   *
   * The evolution is a function of the level's RNG (deterministic from seed)
   * combined with contributions from all faster levels (integrated upward).
   * This makes each slow level's evolution depend on the accumulated fine
   * structure beneath it.
   */
  _evolveLevelOnce(level) {
    const code = this._currentCodes[level];
    const rng = this._levelRngs[level];

    // 1. Generate a pseudo-random rotation amount and perturbation mask.
    let rotBits = 0;
    for (let b = 0; b < 16; b++) rotBits = (rotBits << 1) | rng.nextBit();
    const rotation = rotBits % this.codeLength;
    const perturbation = rng.nextBits(this.codeLength);

    // 2. Integrate contribution from all faster (lower-index) levels.
    const fasterContrib = new Int8Array(this.codeLength);
    for (let fl = 0; fl < level; fl++) {
      xorInto(fasterContrib, this._currentCodes[fl]);
    }

    // 3. Apply: rotate, perturb, fold in faster-level contribution.
    const rotated = new Int8Array(this.codeLength);
    for (let i = 0; i < this.codeLength; i++) {
      rotated[i] = code[(i + rotation) % this.codeLength];
    }
    for (let i = 0; i < this.codeLength; i++) {
      code[i] = rotated[i] ^ perturbation[i] ^ fasterContrib[i];
    }
  }

  /**
   * Fast-forward a level to a given epoch count by replaying its evolution
   * from epoch 0.
   */
  _evolveLevelToEpoch(level, targetEpoch) {
    for (let e = 0; e < targetEpoch; e++) {
      this._evolveLevelOnce(level);
    }
  }
}

// Re-export helpers that downstream modules may find useful.
export { deriveSeed, gf2Mul, gf2Pow, gf2FiniteMul, gf2FinitePow, gf2FiniteInv, gfMul, gfInv, toBipolar, correlate };
