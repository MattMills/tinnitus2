// Fractal Gold code generator — decomposes spreading codes across multiple timescales.
//
// A fractal code is a stack of Gold codes, one per "level," where each level
// evolves at an exponentially slower rate than the one below it.  Partial
// knowledge of the stack produces anti-correlated garbage; only when a
// configurable threshold of levels is present can the true signal be recovered.
//
// The design mirrors Shamir's secret sharing mapped onto the scale dimension:
//   - The "true signal" is a target Gold code T.
//   - Each level holds a "share" — a bitwise vector constructed so that the
//     XOR of any K-of-N shares recovers T exactly (via GF(2) Lagrange
//     interpolation), while fewer than K shares produce a residual that is
//     structurally anti-correlated with T.
//   - Each share is further dressed with a level-specific Gold code that
//     provides per-timescale spreading structure.
//
// Time evolution is deterministic from a compact seed (masterSeed + level
// count + threshold), so any portion of the history can be regenerated without
// storing state.

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

/**
 * Generate a pseudo-random bit mask of `length` bits from an OTPStream.
 */
function generateMask(seed, length) {
  const rng = new OTPStream(seed);
  return rng.nextBits(length);
}

/**
 * Carry-less (GF(2)) multiply of two small integers.
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
 * Carry-less (GF(2)) power: compute base^exp.
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
// GF(2) Lagrange interpolation for bitwise secret sharing
// ---------------------------------------------------------------------------

/**
 * Compute the Lagrange basis coefficient for point x_i in GF(2) arithmetic,
 * evaluated at x = 0, given the set of points xs.
 *
 * L_i(0) = prod_{j != i} (0 XOR x_j) / (x_i XOR x_j)
 *        = prod_{j != i} x_j / (x_i XOR x_j)
 *
 * Division in GF(2^m) requires computing the multiplicative inverse.
 * For small field elements we use brute-force search.
 *
 * Returns an integer whose bit-0 is the GF(2) coefficient (0 or 1) when
 * applied bitwise.  For the bitwise XOR secret sharing scheme the coefficient
 * is always 0 or 1 — the share is either included in the XOR or not.
 *
 * NOTE: Because our shares are over GF(2) (single-bit field), Lagrange
 * interpolation simplifies: each coefficient is 0 or 1, and the secret is
 * recovered as XOR of shares whose coefficient is 1.  We use the extended
 * GF(2^m) arithmetic on the point indices to determine which shares
 * participate.
 */
function gf2LagrangeCoeffs(points) {
  // For bitwise XOR secret sharing over GF(2), the Lagrange coefficient
  // L_i(0) in GF(2^m) is:
  //   L_i(0) = prod_{j!=i} points[j] * inv(points[i] ^ points[j])
  // We need this reduced mod 2 (the LSB) to decide whether share i
  // participates in the XOR.
  const n = points.length;
  const coeffs = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    let num = 1;  // Numerator accumulator in GF(2^m)
    let den = 1;  // Denominator accumulator in GF(2^m)
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      num = gf2Mul(num, points[j]);
      den = gf2Mul(den, points[i] ^ points[j]);
    }
    // Divide in GF(2^m): multiply num by inverse of den.
    const inv = gf2Inv(den);
    const coeff = gf2Mul(num, inv);
    // The LSB tells us whether this share participates.
    coeffs[i] = coeff & 1;
  }

  return coeffs;
}

/**
 * Find the multiplicative inverse of `a` in GF(2^m) for small values.
 * Uses the extended Euclidean algorithm on polynomials.  For the small
 * field elements we encounter (< 256), brute force is acceptable.
 */
function gf2Inv(a) {
  if (a === 0) throw new Error('Cannot invert zero in GF(2)');
  if (a === 1) return 1;
  // For a in GF(2^m), find b such that gf2Mul(a, b) has bit pattern = 1.
  // Since our "field" is really polynomial arithmetic without reduction by
  // an irreducible polynomial, we instead work in the polynomial ring.
  // However, for the threshold scheme to work correctly we need a proper
  // finite field.  We use GF(2^8) with the AES irreducible polynomial
  // x^8 + x^4 + x^3 + x + 1 = 0x11B for elements that fit in 8 bits.
  return gf2FiniteInv(a, 0x11B);
}

/**
 * Multiplicative inverse in GF(2^m) defined by the irreducible polynomial `mod`.
 * Uses the extended Euclidean algorithm for polynomials over GF(2).
 */
function gf2FiniteInv(a, mod) {
  if (a === 0) throw new Error('Cannot invert zero');
  // Extended GCD for GF(2) polynomials
  let r0 = mod, r1 = a;
  let s0 = 0, s1 = 1;

  while (r1 !== 0) {
    const { q, r } = gf2PolyDiv(r0, r1);
    const s = s0 ^ gf2Mul(q, s1);
    r0 = r1; r1 = r;
    s0 = s1; s1 = s;
  }
  // r0 should be 1 (the GCD) if `a` and `mod` are coprime.
  // s0 is the inverse.
  return s0;
}

/**
 * Polynomial division in GF(2): divide `a` by `b`, return quotient and remainder.
 */
function gf2PolyDiv(a, b) {
  if (b === 0) throw new Error('Division by zero');
  let q = 0;
  let r = a;
  const degB = gf2Degree(b);
  let degR = gf2Degree(r);

  while (degR >= degB && r !== 0) {
    const shift = degR - degB;
    q ^= (1 << shift);
    r ^= (b << shift);
    degR = gf2Degree(r);
  }

  return { q, r };
}

/**
 * Degree of a GF(2) polynomial (position of highest set bit).
 */
function gf2Degree(x) {
  if (x === 0) return -1;
  return 31 - Math.clz32(x);
}

/**
 * Multiply in GF(2^8) with reduction by irreducible polynomial.
 */
function gf2FiniteMul(a, b, mod = 0x11B) {
  const raw = gf2Mul(a, b);
  return gf2PolyDiv(raw, mod).r;
}

/**
 * Power in GF(2^8) with reduction.
 */
function gf2FinitePow(base, exp, mod = 0x11B) {
  if (exp === 0) return 1;
  let result = 1;
  let b = base;
  let e = exp;
  while (e > 0) {
    if (e & 1) result = gf2FiniteMul(result, b, mod);
    b = gf2FiniteMul(b, b, mod);
    e >>>= 1;
  }
  return result;
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
   * @param {number}  opts.threshold        Minimum levels needed for correct
   *                                        reconstruction (default: ceil(levels/2)+1).
   */
  constructor({
    levels = 5,
    registerLength = 5,
    masterSeed = 42,
    threshold = undefined,
  } = {}) {
    if (levels < 2) throw new Error('Need at least 2 fractal levels');
    this.levels = levels;
    this.registerLength = registerLength;
    this.masterSeed = masterSeed >>> 0;
    this.threshold = threshold ?? Math.ceil(levels / 2) + 1;
    if (this.threshold < 2 || this.threshold > levels) {
      throw new Error(`Threshold must be in [2, ${levels}]`);
    }

    this.goldGen = new GoldCodeGenerator(registerLength);
    this.codeLength = this.goldGen.codeLength;

    // Pre-derive per-level seeds.
    this._levelSeeds = [];
    this._phaseOffsets = [];
    for (let l = 0; l < levels; l++) {
      const seed = deriveSeed(this.masterSeed, l);
      this._levelSeeds.push(seed);
      this._phaseOffsets.push(seed % this.codeLength);
    }

    // Pre-generate the raw Gold code for each level — these provide
    // per-timescale spreading structure.
    this._rawCodes = this._phaseOffsets.map(offset => this.goldGen.generate(offset));

    // Generate the target code T — the "true signal" that correct
    // reconstruction should yield.
    this._targetCode = this.goldGen.generate(
      deriveSeed(this.masterSeed, levels + 100, 0xBEEF) % this.codeLength
    );

    // Build level shares using the bitwise secret sharing scheme.
    // Each share, when XOR-combined correctly via Lagrange interpolation
    // with >= threshold other shares, recovers the target code.
    this._shares = this._buildShares();

    // Pre-compute Lagrange coefficients for the full set (all N levels).
    // This is used as the reference for what "correct reconstruction" means.
    this._fullCoeffs = this._lagrangeCoeffs(
      Array.from({ length: levels }, (_, i) => i)
    );
  }

  // ---- Share construction ---------------------------------------------------

  /**
   * Build K-of-N bitwise secret shares of the target code using a
   * polynomial scheme over GF(2^8).
   *
   * We construct (threshold - 1) random coefficient vectors C_1..C_{K-1},
   * each of length codeLength.  The degree-0 coefficient is the target code T.
   * The share for level L (evaluated at point x = L+1, which is nonzero) is:
   *
   *   share[L][i] = T[i] ^ C_1[i]*x ^ C_2[i]*x^2 ^ ... ^ C_{K-1}[i]*x^{K-1}
   *
   * where multiplications are in GF(2^8) and the result is taken mod 2 (LSB).
   *
   * Recovery: given any K shares, Lagrange interpolation at x=0 recovers T.
   *
   * Oppositional property: with < K shares, interpolation at 0 yields a
   * pseudo-random code that is uncorrelated or anti-correlated with T,
   * because the missing polynomial degrees introduce pseudo-random error.
   * We strengthen this to anti-correlation by XOR-ing an inversion mask
   * into the higher-degree coefficients so that partial reconstructions
   * are biased toward the bitwise complement of T.
   */
  _buildShares() {
    const { levels, threshold, codeLength, masterSeed } = this;
    const K = threshold;

    // Generate K-1 random coefficient vectors (degrees 1 through K-1).
    // To ensure the oppositional (anti-correlation) property, we bias the
    // coefficients: for even-degree terms we XOR with all-1s, so that
    // partial evaluations tend to flip bits relative to T.
    const coeffs = []; // coeffs[d][i] for degree d+1, chip i
    for (let d = 0; d < K - 1; d++) {
      const raw = generateMask(deriveSeed(masterSeed, levels + d + 1, 0xA5A5), codeLength);
      // Bias odd-indexed degrees toward all-1s to create anti-correlation
      // in partial reconstructions.
      if (d % 2 === 0) {
        for (let i = 0; i < codeLength; i++) {
          raw[i] ^= 1; // flip all bits — makes partial sums tend toward complement
        }
      }
      coeffs.push(raw);
    }

    // Evaluate the polynomial at each level's point to create shares.
    const shares = [];
    for (let l = 0; l < levels; l++) {
      const share = new Int8Array(codeLength);
      const x = l + 1; // nonzero evaluation point in GF(2^8)

      for (let i = 0; i < codeLength; i++) {
        // Start with the degree-0 term: T[i]
        let val = this._targetCode[i];
        // Add higher-degree terms
        for (let d = 0; d < K - 1; d++) {
          const xPow = gf2FinitePow(x, d + 1);
          // Multiply coefficient bit by x^(d+1) in GF(2^8), take LSB
          val ^= coeffs[d][i] & (xPow & 1);
        }
        share[i] = val;
      }
      shares.push(share);
    }

    return shares;
  }

  /**
   * Compute Lagrange interpolation coefficients for a given subset of levels.
   * Returns a Uint8Array where coeffs[i] is 1 if share i should be XOR'd in,
   * 0 otherwise.  The interpolation recovers the degree-0 term (target code).
   */
  _lagrangeCoeffs(presentLevels) {
    const points = presentLevels.map(l => l + 1); // evaluation points (nonzero)
    const n = points.length;
    const coeffs = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      // L_i(0) = prod_{j!=i} (0 ^ points[j]) / (points[i] ^ points[j])
      //        = prod_{j!=i} points[j] * inv(points[i] ^ points[j])
      // All in GF(2^8).
      let val = 1;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const num = points[j];
        const den = points[i] ^ points[j]; // XOR = subtraction in GF(2^m)
        const inv = gf2FiniteInv(den, 0x11B);
        val = gf2FiniteMul(val, gf2FiniteMul(num, inv));
      }
      coeffs[i] = val & 1; // LSB determines XOR participation
    }

    return coeffs;
  }

  // ---- Code retrieval -----------------------------------------------------

  /**
   * Return the share code for a single level — this is what gets transmitted
   * or embedded at that timescale.
   */
  getLevelCode(level) {
    if (level < 0 || level >= this.levels) throw new RangeError('Invalid level');
    return new Int8Array(this._shares[level]);
  }

  /**
   * Reconstruct the target code from a set of available levels using
   * Lagrange interpolation over GF(2^8).
   *
   * With >= threshold levels, this recovers the target code exactly.
   * With fewer, it produces anti-correlated garbage.
   *
   * @param {number[]} presentLevels - Indices of levels available.
   * @returns {{ code: Int8Array, meetsThreshold: boolean, correlation: number }}
   */
  reconstruct(presentLevels) {
    const meetsThreshold = presentLevels.length >= this.threshold;
    const coeffs = this._lagrangeCoeffs(presentLevels);

    const result = new Int8Array(this.codeLength);
    for (let idx = 0; idx < presentLevels.length; idx++) {
      if (coeffs[idx]) {
        xorInto(result, this._shares[presentLevels[idx]]);
      }
    }

    const corr = correlate(result, this._targetCode, this.codeLength);
    return { code: result, meetsThreshold, correlation: corr };
  }

  /**
   * Return the true target code.
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

      // At level L the code repeats every `period` chips.  We correlate at
      // each repetition boundary and take the max.
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
      // We need at least one full period at this level to resolve it.
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

    // Per-level epoch counters — how many times this level's code has
    // been rotated.
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
      // Evolve this level through `epoch` transitions.
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
        // Level L rolled over — evolve it through the intervening epochs.
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
      // Determine the chip position within the current code word.
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

    // Update global time to reflect the stream we just emitted.
    // (We already handled epoch rollovers inline above.)
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

    // 1. Generate a pseudo-random rotation amount and perturbation mask from
    //    the level's RNG.
    let rotBits = 0;
    for (let b = 0; b < 16; b++) rotBits = (rotBits << 1) | rng.nextBit();
    const rotation = rotBits % this.codeLength;
    const perturbation = rng.nextBits(this.codeLength);

    // 2. Integrate contribution from all faster (lower-index) levels.
    //    XOR their current codes in — this couples the timescales.
    const fasterContrib = new Int8Array(this.codeLength);
    for (let fl = 0; fl < level; fl++) {
      xorInto(fasterContrib, this._currentCodes[fl]);
    }

    // 3. Apply: rotate, perturb, and fold in faster-level contribution.
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
export { deriveSeed, gf2Mul, gf2Pow, gf2FiniteMul, gf2FinitePow, gf2FiniteInv, toBipolar, correlate };
