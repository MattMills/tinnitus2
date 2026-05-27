// Self-Interacting RNG Manifold
//
// N RNG streams where each one's output feeds into K others' state evolution.
// The interaction topology is itself RNG-driven.  The trajectory through
// N-dimensional state space is the "origami fold" — deterministic from seeds
// but computationally irreducible (must run it, no shortcut).
//
// The operative output is a PROJECTION from the high-D fold structure,
// never the full bulk.  The fold structure at the coarsest grain IS the
// worldpath.
//
// Each RNG has:
//   - Its own seed and tap rules (LFSR-based for determinism)
//   - A coupling map: which other RNGs feed into its state
//   - A coupling function: how the foreign bits modify local state
//   - A projection rule: which bits of local state contribute to output

import { OTPStream } from './otp.js';

function splitmix(seed, salt = 0) {
  let h = ((seed >>> 0) + (salt * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Single RNG node in the manifold
class ManifoldNode {
  constructor(seed, dimension, stateWidth = 32) {
    this.dimension = dimension;
    this.stateWidth = stateWidth;
    this.state = new Uint32Array(4);
    this.couplings = [];       // [{sourceIndex, weight, xorMask}]
    this.projectionMask = 0;   // which bits of state[0] project to output
    this._initState(seed);
  }

  _initState(seed) {
    for (let i = 0; i < 4; i++) {
      this.state[i] = splitmix(seed, i);
    }
  }

  // xoshiro128** core
  _step() {
    const s = this.state;
    const result = Math.imul(((s[1] * 5) << 7) | ((s[1] * 5) >>> 25), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = ((s[3] << 11) | (s[3] >>> 21)) >>> 0;
    return result;
  }

  // Inject foreign state (coupling from another node)
  inject(foreignState, coupling) {
    const mixed = (foreignState ^ coupling.xorMask) >>> 0;
    const scaled = Math.imul(mixed, coupling.weight) >>> 0;
    // Fold into local state without destroying it
    this.state[coupling.targetRegister || 0] ^= scaled;
  }

  // Advance one step and return projected output
  advance() {
    const raw = this._step();
    return (raw & this.projectionMask) >>> 0;
  }

  // Get full state snapshot (for worldpath recording)
  getState() {
    return new Uint32Array(this.state);
  }

  // Restore from snapshot
  setState(snapshot) {
    this.state.set(snapshot);
  }
}

// The full N-dimensional RNG manifold
export class RNGManifold {
  constructor({
    dimensions = 8,          // number of RNG nodes
    couplingDensity = 3,     // how many other nodes each node couples to
    masterSeed = Date.now(),
    stateWidth = 32,
  } = {}) {
    this.dimensions = dimensions;
    this.masterSeed = masterSeed;
    this.nodes = [];
    this.step = 0;
    this._worldpath = [];
    this._maxWorldpath = 1024;
    this._topologyRng = new OTPStream(splitmix(masterSeed, 0xDEAD));

    // Create nodes
    for (let i = 0; i < dimensions; i++) {
      const nodeSeed = splitmix(masterSeed, i + 1);
      this.nodes.push(new ManifoldNode(nodeSeed, i, stateWidth));
    }

    // Build coupling topology
    this._buildTopology(couplingDensity);

    // Set projection masks (each node projects different bits)
    for (let i = 0; i < dimensions; i++) {
      this.nodes[i].projectionMask = splitmix(masterSeed, i + dimensions + 1);
    }
  }

  _buildTopology(density) {
    const topoSeed = splitmix(this.masterSeed, 0xF00D);
    const rng = new OTPStream(topoSeed);

    for (let i = 0; i < this.dimensions; i++) {
      const node = this.nodes[i];
      node.couplings = [];

      // Select which other nodes couple into this one
      const candidates = [];
      for (let j = 0; j < this.dimensions; j++) {
        if (j !== i) candidates.push(j);
      }

      // Deterministic shuffle of candidates
      for (let j = candidates.length - 1; j > 0; j--) {
        let rval = 0;
        for (let b = 0; b < 8; b++) rval = (rval << 1) | rng.nextBit();
        const k = rval % (j + 1);
        [candidates[j], candidates[k]] = [candidates[k], candidates[j]];
      }

      const numCouplings = Math.min(density, candidates.length);
      for (let c = 0; c < numCouplings; c++) {
        let weight = 1;
        for (let b = 0; b < 16; b++) weight = (weight << 1) | rng.nextBit();

        let xorMask = 0;
        for (let b = 0; b < 32; b++) xorMask = (xorMask << 1) | rng.nextBit();

        node.couplings.push({
          sourceIndex: candidates[c],
          weight: weight >>> 0,
          xorMask: xorMask >>> 0,
          targetRegister: rng.nextBit() + rng.nextBit(), // 0-2
        });
      }
    }
  }

  // Advance the entire manifold one step
  advance() {
    // Phase 1: each node reads current state of its coupled sources
    const injections = [];
    for (let i = 0; i < this.dimensions; i++) {
      const node = this.nodes[i];
      const nodeInjections = [];
      for (const coupling of node.couplings) {
        const sourceState = this.nodes[coupling.sourceIndex].state[0];
        nodeInjections.push({ foreignState: sourceState, coupling });
      }
      injections.push(nodeInjections);
    }

    // Phase 2: apply injections (uses state from BEFORE this step)
    for (let i = 0; i < this.dimensions; i++) {
      for (const inj of injections[i]) {
        this.nodes[i].inject(inj.foreignState, inj.coupling);
      }
    }

    // Phase 3: advance each node and collect projected outputs
    const projections = new Uint32Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      projections[i] = this.nodes[i].advance();
    }

    this.step++;

    // Record worldpath (coarse grain: hash of full state)
    if (this.step % 64 === 0) {
      this._recordWorldpath();
    }

    return projections;
  }

  // Get a single projected output bit (folds all dimensions)
  nextBit() {
    const projections = this.advance();
    let folded = 0;
    for (let i = 0; i < this.dimensions; i++) {
      folded ^= projections[i];
    }
    return folded & 1;
  }

  // Get N projected output bits
  nextBits(count) {
    const bits = new Int8Array(count);
    for (let i = 0; i < count; i++) {
      bits[i] = this.nextBit();
    }
    return bits;
  }

  // Get a projected output byte
  nextByte() {
    let byte = 0;
    for (let i = 0; i < 8; i++) {
      byte |= this.nextBit() << i;
    }
    return byte;
  }

  // Get the full N-dimensional state vector (the "fold point")
  getFoldState() {
    const state = [];
    for (const node of this.nodes) {
      state.push(node.getState());
    }
    return state;
  }

  // Restore from a fold state
  setFoldState(state) {
    for (let i = 0; i < Math.min(state.length, this.nodes.length); i++) {
      this.nodes[i].setState(state[i]);
    }
  }

  // Get the coarse-grain worldpath
  getWorldpath() {
    return this._worldpath.slice();
  }

  _recordWorldpath() {
    // Hash the full state into a compact fingerprint
    let h = 0;
    for (const node of this.nodes) {
      for (let i = 0; i < 4; i++) {
        h = (Math.imul(h ^ node.state[i], 0x85ebca6b) >>> 0);
      }
    }
    this._worldpath.push({ step: this.step, hash: h >>> 0 });
    if (this._worldpath.length > this._maxWorldpath) {
      this._worldpath.shift();
    }
  }

  // Evolve the coupling topology (the "twist")
  // This makes the interaction structure itself change over time
  twist() {
    let rval = 0;
    for (let b = 0; b < 32; b++) rval = (rval << 1) | this._topologyRng.nextBit();

    // Rotate one coupling per node
    for (const node of this.nodes) {
      if (node.couplings.length === 0) continue;
      const idx = (rval >>> 0) % node.couplings.length;
      const coupling = node.couplings[idx];

      // Evolve the coupling parameters
      coupling.xorMask = (coupling.xorMask ^ rval) >>> 0;
      coupling.weight = Math.imul(coupling.weight, 0x9e3779b9) >>> 0;

      // Possibly retarget to a different source
      let newSource = 0;
      for (let b = 0; b < 8; b++) newSource = (newSource << 1) | this._topologyRng.nextBit();
      newSource = newSource % this.dimensions;
      if (newSource !== node.dimension) {
        coupling.sourceIndex = newSource;
      }

      rval = splitmix(rval, this.step);
    }
  }

  // Compact seed representation — can regenerate entire history
  getSeedHierarchy() {
    return {
      masterSeed: this.masterSeed,
      dimensions: this.dimensions,
      step: this.step,
    };
  }

  // Regenerate from seed (expensive: must replay all steps)
  static fromSeed(config) {
    const manifold = new RNGManifold({
      dimensions: config.dimensions,
      masterSeed: config.masterSeed,
    });
    for (let i = 0; i < config.step; i++) {
      manifold.advance();
      if (i % 256 === 255) manifold.twist();
    }
    return manifold;
  }
}
