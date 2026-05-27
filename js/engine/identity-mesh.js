// Holographic Identity Mesh
//
// Two data sources create identity:
//   1. Shared non-entropic: deterministic rules both parties know (seeds, code structure)
//   2. Non-shared entropic: private randomness each party accretes over time
//
// Identity = demonstrating that your local worldpath is consistent with
// the shared rules AND your accumulated private entropy.
//
// Seed exchanges between parties create a second-order network where
// the exchange pattern itself becomes the identity proof, strengthening
// over time.  Each exchange is a mutual entropy commitment — both parties
// contribute private entropy to a shared pool, creating a bond that can
// only be verified by the two participants.
//
// The holographic property: any sufficient slice of the worldpath contains
// enough information to regenerate the identity, because the fold structure
// at coarse grain encodes the fine-grain rules.

import { RNGManifold } from '../signal/rng-manifold.js';
import { AntiEntropyEngine } from '../signal/entropy-engine.js';
import { OTPStream } from '../signal/otp.js';
import { GoldCodeGenerator } from '../signal/gold-codes.js';

function splitmix(seed, salt = 0) {
  let h = ((seed >>> 0) + (salt * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// A single identity instance — one participant in the mesh
export class Identity {
  constructor({
    sharedSeed,          // the non-entropic shared rules
    privateSeed = null,  // initial private entropy (null = generate)
    dimensions = 8,      // RNG manifold dimensions
    label = '',
  } = {}) {
    this.label = label;
    this.sharedSeed = sharedSeed;
    this.privateSeed = privateSeed || (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF));

    // Shared deterministic manifold (both parties can compute this)
    this.sharedManifold = new RNGManifold({
      dimensions,
      masterSeed: sharedSeed,
    });

    // Private manifold (only this identity can compute)
    this.privateManifold = new RNGManifold({
      dimensions,
      masterSeed: this.privateSeed,
    });

    // Anti-entropy engine for verifying entropy quality of accretions
    this.entropyEngine = new AntiEntropyEngine({
      numLayers: 4,
      masterSeed: splitmix(sharedSeed, this.privateSeed),
    });

    // Accretion log: accumulated private entropy commitments
    this._accretions = [];

    // Exchange log: record of seed exchanges with other identities
    this._exchanges = [];

    // Worldpath checkpoints
    this._checkpoints = [];

    // Gold code for this identity's signature
    this._goldGen = new GoldCodeGenerator(5);
    this._signatureCode = this._goldGen.generate(sharedSeed % 31);

    // Step counter
    this.step = 0;
  }

  // Advance both manifolds one step, coupling them
  advance() {
    const sharedProjection = this.sharedManifold.advance();
    const privateProjection = this.privateManifold.advance();

    // Cross-couple: shared output feeds into private state
    // This binds the identity to the shared rules
    const sharedFolded = sharedProjection.reduce((a, b) => (a ^ b) >>> 0, 0);
    this.privateManifold.nodes[0].state[2] ^= sharedFolded;

    this.step++;

    // Periodic topology twist
    if (this.step % 256 === 0) {
      this.sharedManifold.twist();
      this.privateManifold.twist();
    }

    // Periodic checkpoint
    if (this.step % 1024 === 0) {
      this._checkpoint();
    }

    return {
      shared: sharedProjection,
      private: privateProjection,
      combined: this._combine(sharedProjection, privateProjection),
    };
  }

  _combine(shared, priv) {
    const out = new Uint32Array(shared.length);
    for (let i = 0; i < shared.length; i++) {
      out[i] = (shared[i] ^ priv[i]) >>> 0;
    }
    return out;
  }

  // Accrete new private entropy (strengthens identity over time)
  accrete(entropyBits) {
    // Verify the entropy is actually entropic
    const cleaned = this.entropyEngine.process(entropyBits);

    // Fold into private manifold state
    const words = Math.floor(cleaned.length / 32);
    for (let w = 0; w < words; w++) {
      let val = 0;
      for (let b = 0; b < 32; b++) {
        val = (val << 1) | (cleaned[w * 32 + b] & 1);
      }
      const nodeIdx = w % this.privateManifold.dimensions;
      this.privateManifold.nodes[nodeIdx].state[w % 4] ^= val;
    }

    // Log the accretion
    const accretion = {
      step: this.step,
      timestamp: Date.now(),
      hash: this._hashBits(cleaned),
      size: entropyBits.length,
      entropyReport: this.entropyEngine.lastReport,
    };
    this._accretions.push(accretion);

    return accretion;
  }

  // Exchange entropy with another identity (mutual commitment)
  exchange(otherIdentity) {
    // Generate exchange entropy from both private manifolds
    const myContribution = this.privateManifold.nextBits(256);
    const theirContribution = otherIdentity.privateManifold.nextBits(256);

    // Both parties XOR contributions into their shared manifold
    const combined = new Int8Array(256);
    for (let i = 0; i < 256; i++) {
      combined[i] = myContribution[i] ^ theirContribution[i];
    }

    // Fold combined entropy into both parties' private manifolds
    this.accrete(combined);
    otherIdentity.accrete(combined);

    // Record the exchange
    const exchangeRecord = {
      step: this.step,
      timestamp: Date.now(),
      myHash: this._hashBits(myContribution),
      theirHash: this._hashBits(theirContribution),
      combinedHash: this._hashBits(combined),
      peerLabel: otherIdentity.label,
    };

    this._exchanges.push(exchangeRecord);
    otherIdentity._exchanges.push({
      step: otherIdentity.step,
      timestamp: Date.now(),
      myHash: this._hashBits(theirContribution),
      theirHash: this._hashBits(myContribution),
      combinedHash: this._hashBits(combined),
      peerLabel: this.label,
    });

    return exchangeRecord;
  }

  // Generate a proof of identity at the current state
  // This is what you'd send to prove you are who you claim
  generateProof() {
    // The proof includes:
    // 1. Current shared manifold state (verifiable by anyone with sharedSeed)
    // 2. Hash of private manifold state (verifiable only by self)
    // 3. Recent worldpath (shows continuity)
    // 4. Accretion and exchange history hashes
    const sharedState = this.sharedManifold.getFoldState();
    const privateHash = this._hashFoldState(this.privateManifold.getFoldState());

    // Generate Gold code signature from current combined state
    const combined = this._combine(
      new Uint32Array(sharedState.map(s => s[0])),
      new Uint32Array(this.privateManifold.getFoldState().map(s => s[0]))
    );

    return {
      label: this.label,
      step: this.step,
      timestamp: Date.now(),
      sharedStateHash: this._hashFoldState(sharedState),
      privateStateHash: privateHash,
      worldpath: this._checkpoints.slice(-16),
      accretionCount: this._accretions.length,
      exchangeCount: this._exchanges.length,
      recentExchanges: this._exchanges.slice(-8).map(e => ({
        hash: e.combinedHash,
        peer: e.peerLabel,
      })),
      signatureCode: Array.from(this._signatureCode),
      combinedProjection: Array.from(combined),
    };
  }

  // Verify that a proof is consistent with shared rules
  static verifyProof(proof, sharedSeed) {
    // Rebuild shared manifold to the claimed step
    const verifier = new RNGManifold({
      dimensions: proof.combinedProjection.length,
      masterSeed: sharedSeed,
    });

    for (let i = 0; i < proof.step; i++) {
      verifier.advance();
      if (i % 256 === 255) verifier.twist();
    }

    const verifierState = verifier.getFoldState();
    const verifierHash = Identity.prototype._hashFoldState(verifierState);

    return {
      sharedStateMatch: verifierHash === proof.sharedStateHash,
      worldpathContinuous: Identity._checkWorldpathContinuity(proof.worldpath),
      step: proof.step,
      accretionDepth: proof.accretionCount,
      exchangeDepth: proof.exchangeCount,
    };
  }

  static _checkWorldpathContinuity(worldpath) {
    if (worldpath.length < 2) return true;
    for (let i = 1; i < worldpath.length; i++) {
      if (worldpath[i].step <= worldpath[i - 1].step) return false;
    }
    return true;
  }

  _checkpoint() {
    const shared = this.sharedManifold.getFoldState();
    const priv = this.privateManifold.getFoldState();
    this._checkpoints.push({
      step: this.step,
      timestamp: Date.now(),
      sharedHash: this._hashFoldState(shared),
      privateHash: this._hashFoldState(priv),
    });
    if (this._checkpoints.length > 256) {
      this._checkpoints.shift();
    }
  }

  _hashBits(bits) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bits.length; i++) {
      h ^= bits[i] & 1;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  _hashFoldState(foldState) {
    let h = 0x811c9dc5;
    for (const nodeState of foldState) {
      for (let i = 0; i < nodeState.length; i++) {
        h ^= nodeState[i];
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return h >>> 0;
  }

  // Compact representation for serialization
  serialize() {
    return {
      label: this.label,
      sharedSeed: this.sharedSeed,
      privateSeed: this.privateSeed,
      step: this.step,
      sharedManifoldState: this.sharedManifold.getFoldState(),
      privateManifoldState: this.privateManifold.getFoldState(),
      accretions: this._accretions,
      exchanges: this._exchanges,
      checkpoints: this._checkpoints,
    };
  }

  // Restore from serialized state
  static deserialize(data) {
    const identity = new Identity({
      sharedSeed: data.sharedSeed,
      privateSeed: data.privateSeed,
      label: data.label,
    });
    identity.step = data.step;
    identity.sharedManifold.setFoldState(data.sharedManifoldState);
    identity.privateManifold.setFoldState(data.privateManifoldState);
    identity._accretions = data.accretions || [];
    identity._exchanges = data.exchanges || [];
    identity._checkpoints = data.checkpoints || [];
    return identity;
  }
}

// The mesh: a network of identities that exchange entropy
export class IdentityMesh {
  constructor(sharedSeed) {
    this.sharedSeed = sharedSeed;
    this.identities = new Map();
  }

  createIdentity(label, privateSeed = null) {
    const identity = new Identity({
      sharedSeed: this.sharedSeed,
      privateSeed,
      label,
    });
    this.identities.set(label, identity);
    return identity;
  }

  getIdentity(label) {
    return this.identities.get(label);
  }

  // Advance all identities in the mesh
  advanceAll() {
    for (const identity of this.identities.values()) {
      identity.advance();
    }
  }

  // Perform a round of exchanges between all pairs
  exchangeRound() {
    const labels = Array.from(this.identities.keys());
    const exchanges = [];
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = this.identities.get(labels[i]);
        const b = this.identities.get(labels[j]);
        const record = a.exchange(b);
        exchanges.push({ from: labels[i], to: labels[j], ...record });
      }
    }
    return exchanges;
  }

  // Verify an identity's proof against the mesh
  verifyProof(proof) {
    return Identity.verifyProof(proof, this.sharedSeed);
  }
}
