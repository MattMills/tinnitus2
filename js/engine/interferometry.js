// Multi-point interferometry simulation engine
// Simulates N broadcast sources in a spatial field where superimposed signals
// encode receiver position into the effective Gold code configuration.
//
// Physics model:
//   Each source emits: A * code[chipIndex] * cos(2*pi*f*(t - delay) + phaseOffset)
//   At receiver:  received(t) = Sum_i  A_i/r_i^2 * code_i[(chip - delayChips_i) % L] * cos(...)
//   With >= 3 non-collinear sources in 2D (>= 4 non-coplanar in 3D), position is
//   uniquely determined by the relative chip alignments.

import { GoldCodeGenerator } from '../signal/gold-codes.js';

// ─── Propagation Model ─────────────────────────────────────────────────────────

export class PropagationModel {
  /**
   * Models signal propagation with inverse-square attenuation and optional
   * frequency-dependent absorption.
   *
   * @param {number} speed        propagation speed in m/s (default 343 for sound in air)
   * @param {number} sampleRate   samples per second for delay calculation
   * @param {number} absorption   frequency-dependent absorption coefficient (Np/m), 0 = none
   * @param {number} frequency    carrier frequency in Hz for absorption calculation
   */
  constructor({ speed = 343, sampleRate = 44100, absorption = 0, frequency = 1000 } = {}) {
    this.speed = speed;
    this.sampleRate = sampleRate;
    this.absorption = absorption;
    this.frequency = frequency;
  }

  /**
   * Returns attenuated amplitude using inverse-square law plus optional
   * frequency-dependent exponential absorption.
   *
   *   A_out = A_in / r^2 * exp(-alpha * r)
   *
   * Clamps minimum distance to avoid singularity at r = 0.
   *
   * @param  {number} amplitude  source amplitude
   * @param  {number} distance   distance from source in metres
   * @returns {number} attenuated amplitude
   */
  attenuate(amplitude, distance) {
    const r = Math.max(distance, 1e-6);
    let a = amplitude / (r * r);
    if (this.absorption > 0) {
      a *= Math.exp(-this.absorption * r);
    }
    return a;
  }

  /**
   * Returns propagation delay in samples for a given distance.
   *
   * @param  {number} distance  distance in metres
   * @returns {number} delay in samples (fractional)
   */
  delay(distance) {
    return (distance / this.speed) * this.sampleRate;
  }

  /**
   * Returns propagation delay in seconds for a given distance.
   *
   * @param  {number} distance  distance in metres
   * @returns {number} delay in seconds
   */
  delaySeconds(distance) {
    return distance / this.speed;
  }
}

// ─── Source ─────────────────────────────────────────────────────────────────────

export class Source {
  /**
   * A broadcast point in the interferometry field.
   *
   * @param {Object}  position     {x, y, z} coordinates in metres
   * @param {number}  phaseOffset  carrier phase offset in radians relative to master clock
   * @param {number}  codeOffset   phase offset for the Gold code generator (integer)
   * @param {number}  amplitude    transmission amplitude (linear scale)
   * @param {boolean} active       whether this source is currently broadcasting
   */
  constructor(position, phaseOffset = 0, codeOffset = 0, amplitude = 1.0, active = true) {
    this.position = { x: position.x || 0, y: position.y || 0, z: position.z || 0 };
    this.phaseOffset = phaseOffset;
    this.codeOffset = codeOffset;
    this.amplitude = amplitude;
    this.active = active;
  }
}

// ─── Interferometry Field ───────────────────────────────────────────────────────

export class InterferometryField {
  /**
   * Simulates a spatial field produced by multiple broadcast sources, each
   * emitting a DSSS signal with a Gold code.  At any point the signals
   * superimpose, and the interference pattern creates a unique effective
   * Gold code configuration that encodes the receiver's spatial position.
   *
   * @param {Source[]} sources            array of Source objects
   * @param {number}   propagationSpeed   m/s (default 343 for sound in air)
   * @param {Object}   options
   * @param {number}   options.carrierFrequency  Hz (default 1000)
   * @param {number}   options.chipRate          chips/second (default 1000)
   * @param {number}   options.registerLength    Gold code register length (default 5)
   * @param {number}   options.sampleRate        samples/second (default 44100)
   */
  constructor(sources = [], propagationSpeed = 343, {
    carrierFrequency = 1000,
    chipRate = 1000,
    registerLength = 5,
    sampleRate = 44100,
  } = {}) {
    this.sources = sources.slice();
    this.carrierFrequency = carrierFrequency;
    this.chipRate = chipRate;
    this.sampleRate = sampleRate;

    this.propagation = new PropagationModel({
      speed: propagationSpeed,
      sampleRate,
      frequency: carrierFrequency,
    });

    this.goldGen = new GoldCodeGenerator(registerLength);
    this.codeLength = this.goldGen.codeLength;

    // Pre-generate Gold codes for each source based on its codeOffset
    this._codes = [];
    this._buildCodes();

    // Spatial bounding box for grid scans, auto-sized from source positions
    this._bounds = null;
    this._updateBounds();
  }

  // ── Source management ──────────────────────────────────────────────────────

  /**
   * Add a broadcast source to the field.
   *
   * @param  {{x,y,z}} position     source position in metres
   * @param  {number}  phaseOffset  carrier phase offset in radians
   * @param  {number}  codeOffset   Gold code generator phase offset
   * @param  {number}  amplitude    transmission amplitude
   * @returns {number} index of the newly added source
   */
  addSource(position, phaseOffset = 0, codeOffset = 0, amplitude = 1.0) {
    const src = new Source(position, phaseOffset, codeOffset, amplitude);
    this.sources.push(src);
    this._codes.push(this.goldGen.generate(codeOffset));
    this._updateBounds();
    return this.sources.length - 1;
  }

  /**
   * Remove a source by index.
   *
   * @param {number} index  index of the source to remove
   */
  removeSource(index) {
    if (index < 0 || index >= this.sources.length) return;
    this.sources.splice(index, 1);
    this._codes.splice(index, 1);
    this._updateBounds();
  }

  // ── Core computation ───────────────────────────────────────────────────────

  /**
   * Compute the superimposed signal value at a spatial position and time.
   *
   * Each active source contributes:
   *   A_i / r_i^2 * code_i[chipIndex] * cos(2*pi*f*(t - delay_i) + phi_i)
   *
   * where chipIndex accounts for the propagation delay in chip periods so
   * that the chip the receiver "hears" is the one that was emitted at the
   * retarded time.
   *
   * @param  {{x,y,z}} position  receiver position in metres
   * @param  {number}  time      time in seconds from master clock epoch
   * @returns {number} composite signal value (sum of all source contributions)
   */
  computeAt(position, time) {
    const TWO_PI = 2 * Math.PI;
    const f = this.carrierFrequency;
    const chipPeriod = 1 / this.chipRate;
    let sum = 0;

    for (let i = 0; i < this.sources.length; i++) {
      const src = this.sources[i];
      if (!src.active) continue;

      const dist = _distance(src.position, position);
      const delay = dist / this.propagation.speed;         // propagation delay in seconds
      const localTime = time - delay;                      // retarded time at source
      if (localTime < 0) continue;                         // signal has not arrived yet

      // Attenuated amplitude (inverse-square + optional absorption)
      const amp = this.propagation.attenuate(src.amplitude, dist);

      // Determine which chip is playing at the receiver right now.
      // The chip index is based on the retarded time so that propagation
      // delay naturally shifts which chip is "heard" at this position.
      const chipIndexRaw = Math.floor(localTime / chipPeriod);
      const chipIndex = ((chipIndexRaw % this.codeLength) + this.codeLength) % this.codeLength;
      const chipValue = this._codes[i][chipIndex] * 2 - 1; // map {0,1} to {-1,+1}

      // Carrier with per-source phase offset
      const carrier = Math.cos(TWO_PI * f * localTime + src.phaseOffset);

      sum += amp * chipValue * carrier;
    }

    return sum;
  }

  /**
   * Compute a 2D grid of interference pattern intensities at a fixed z-slice.
   *
   * The grid spans the bounding box of all sources (with padding) unless
   * explicit bounds are provided.  Useful for visualization.
   *
   * @param  {number}  gridResolution  number of points per axis
   * @param  {number}  time            snapshot time in seconds
   * @param  {number}  zSlice          z-coordinate of the slice (default 0)
   * @param  {{xMin,xMax,yMin,yMax}} bounds  optional explicit spatial bounds
   * @returns {Object} { data: Float32Array, width, height, xMin, xMax, yMin, yMax }
   */
  computeField(gridResolution, time, zSlice = 0, bounds = null) {
    const b = bounds || this._bounds;
    const width = gridResolution;
    const height = gridResolution;
    const data = new Float32Array(width * height);

    const dx = (b.xMax - b.xMin) / (width - 1 || 1);
    const dy = (b.yMax - b.yMin) / (height - 1 || 1);

    for (let row = 0; row < height; row++) {
      const y = b.yMin + row * dy;
      for (let col = 0; col < width; col++) {
        const x = b.xMin + col * dx;
        data[row * width + col] = this.computeAt({ x, y, z: zSlice }, time);
      }
    }

    return {
      data,
      width,
      height,
      xMin: b.xMin,
      xMax: b.xMax,
      yMin: b.yMin,
      yMax: b.yMax,
    };
  }

  /**
   * Compute the effective Gold code as received at a spatial position by
   * sampling the field over time and making hard decisions on each chip.
   *
   * For each chip slot we integrate the composite field value over the
   * chip duration using multiple sub-samples, then apply a hard decision
   * (positive -> 1, non-positive -> 0).  The sampling starts late enough
   * that all sources have had time to propagate to the receiver.
   *
   * @param  {{x,y,z}} position    receiver position
   * @param  {number}  codeLength  number of chips to capture (default: this.codeLength)
   * @param  {number}  numChips    sub-samples per chip for integration (default 8)
   * @returns {Int8Array} received chip values after hard decision (0 or 1)
   */
  computeCodeAt(position, codeLength = this.codeLength, numChips = 8) {
    const chipPeriod = 1 / this.chipRate;
    const subStep = chipPeriod / numChips;
    const code = new Int8Array(codeLength);

    // Start time: wait for propagation from all sources plus one chip of margin
    const maxDelay = this._maxPropagationDelay(position);
    const t0 = maxDelay + chipPeriod;

    for (let c = 0; c < codeLength; c++) {
      let accum = 0;
      const chipStart = t0 + c * chipPeriod;
      for (let s = 0; s < numChips; s++) {
        accum += this.computeAt(position, chipStart + s * subStep);
      }
      code[c] = accum > 0 ? 1 : 0;
    }

    return code;
  }

  /**
   * Given a captured signal, scan a spatial grid and find the position whose
   * effective code has the highest correlation with the captured signal.
   *
   * The algorithm performs a coarse grid search over the bounding box of the
   * sources, then refines around the best candidate with a smaller grid.
   *
   * @param  {Int8Array|Float32Array} capturedSignal  received chip values
   * @param  {number} codeLength      Gold code length to use
   * @param  {number} gridResolution  points per axis in the search grid
   * @param  {number} zSlice          z-coordinate for 2D search (default 0)
   * @param  {{xMin,xMax,yMin,yMax}} bounds  optional explicit spatial bounds
   * @returns {{x, y, z, correlation, confidence}}
   */
  localize(capturedSignal, codeLength = this.codeLength, gridResolution = 32, zSlice = 0, bounds = null) {
    const b = bounds || this._bounds;
    const dx = (b.xMax - b.xMin) / (gridResolution - 1 || 1);
    const dy = (b.yMax - b.yMin) / (gridResolution - 1 || 1);

    // Convert captured signal to bipolar {-1, +1} for correlation
    const capBipolar = new Float32Array(codeLength);
    for (let i = 0; i < codeLength; i++) {
      capBipolar[i] = (capturedSignal[i] || 0) * 2 - 1;
    }

    let bestCorr = -Infinity;
    let bestPos = { x: 0, y: 0, z: zSlice };
    let secondBestCorr = -Infinity;

    // --- Coarse grid search ---
    for (let row = 0; row < gridResolution; row++) {
      const y = b.yMin + row * dy;
      for (let col = 0; col < gridResolution; col++) {
        const x = b.xMin + col * dx;
        const pos = { x, y, z: zSlice };
        const localCode = this.computeCodeAt(pos, codeLength);

        // Normalized correlation
        let corr = 0;
        for (let i = 0; i < codeLength; i++) {
          corr += capBipolar[i] * (localCode[i] * 2 - 1);
        }
        corr /= codeLength;

        if (corr > bestCorr) {
          secondBestCorr = bestCorr;
          bestCorr = corr;
          bestPos = pos;
        } else if (corr > secondBestCorr) {
          secondBestCorr = corr;
        }
      }
    }

    // --- Refinement around the best candidate ---
    const refinePad = Math.max(dx, dy) * 1.5;
    const refineRes = 8;
    const rDx = (2 * refinePad) / (refineRes - 1 || 1);
    const rDy = (2 * refinePad) / (refineRes - 1 || 1);

    for (let row = 0; row < refineRes; row++) {
      const y = bestPos.y - refinePad + row * rDy;
      for (let col = 0; col < refineRes; col++) {
        const x = bestPos.x - refinePad + col * rDx;
        const pos = { x, y, z: zSlice };
        const localCode = this.computeCodeAt(pos, codeLength);

        let corr = 0;
        for (let i = 0; i < codeLength; i++) {
          corr += capBipolar[i] * (localCode[i] * 2 - 1);
        }
        corr /= codeLength;

        if (corr > bestCorr) {
          secondBestCorr = bestCorr;
          bestCorr = corr;
          bestPos = pos;
        }
      }
    }

    // Confidence: how far the best peak stands above the second-best
    const confidence = secondBestCorr > -Infinity
      ? Math.max(0, Math.min(1, (bestCorr - secondBestCorr) / (1 - secondBestCorr + 1e-12)))
      : 1;

    return {
      x: bestPos.x,
      y: bestPos.y,
      z: bestPos.z,
      correlation: bestCorr,
      confidence,
    };
  }

  /**
   * Extract a spatial-temporal fingerprint (provenance signature) from a
   * captured signal.
   *
   * Steps:
   *   1. Average over code periods for noise reduction
   *   2. Hard-decision code extraction
   *   3. Cross-correlation against each source's known Gold code to estimate
   *      per-source delays (time-difference-of-arrival)
   *   4. TDOA-based position estimate when enough sources are detected
   *   5. Signal quality metrics
   *
   * @param  {Float32Array|Int8Array} capturedSignal  raw or hard-decision samples
   * @param  {number} codeLength  number of chips per code period
   * @returns {Object} provenance signature with fields:
   *   - estimatedPosition: {x, y, z, approximate?} or null
   *   - sourceDelays: per-source delay/correlation info
   *   - capturedCode: Int8Array hard-decision code
   *   - captureDuration: seconds
   *   - numPeriodsAveraged: number of code periods used
   *   - sensorCharacteristics: quality metrics
   */
  computeProvenanceSignature(capturedSignal, codeLength = this.codeLength) {
    const numPeriods = Math.floor(capturedSignal.length / codeLength);
    const effectivePeriods = Math.max(numPeriods, 1);

    // Average over code periods for noise reduction
    const averaged = new Float32Array(codeLength);
    for (let p = 0; p < effectivePeriods; p++) {
      for (let i = 0; i < codeLength; i++) {
        const idx = p * codeLength + i;
        if (idx < capturedSignal.length) {
          averaged[i] += capturedSignal[idx];
        }
      }
    }
    for (let i = 0; i < codeLength; i++) {
      averaged[i] /= effectivePeriods;
    }

    // Hard decision on the averaged signal
    const hardCode = new Int8Array(codeLength);
    for (let i = 0; i < codeLength; i++) {
      hardCode[i] = averaged[i] > 0 ? 1 : 0;
    }

    // Cross-correlate with each active source's code to estimate per-source delay
    const sourceDelays = [];
    for (let s = 0; s < this.sources.length; s++) {
      if (!this.sources[s].active) continue;
      const srcCode = this._codes[s];

      let bestLag = 0;
      let bestCorr = -Infinity;
      for (let lag = 0; lag < codeLength; lag++) {
        let corr = 0;
        for (let i = 0; i < codeLength; i++) {
          const a = averaged[i];
          const b = srcCode[(i + lag) % codeLength] * 2 - 1;
          corr += a * b;
        }
        corr /= codeLength;
        if (corr > bestCorr) {
          bestCorr = corr;
          bestLag = lag;
        }
      }

      sourceDelays.push({
        sourceIndex: s,
        lag: bestLag,
        correlation: bestCorr,
        estimatedDistance: (bestLag / this.chipRate) * this.propagation.speed,
      });
    }

    // Sort by correlation strength (strongest first)
    sourceDelays.sort((a, b) => b.correlation - a.correlation);

    // TDOA position estimate when enough sources have decent correlation
    let estimatedPosition = null;
    const strongSources = sourceDelays.filter(d => d.correlation > 0.1);
    if (strongSources.length >= 3) {
      estimatedPosition = this._tdoaEstimate(strongSources);
    } else if (strongSources.length > 0) {
      // Rough estimate: use the strongest source's own position as a fallback
      const best = strongSources[0];
      const src = this.sources[best.sourceIndex];
      estimatedPosition = {
        x: src.position.x,
        y: src.position.y,
        z: src.position.z,
        approximate: true,
      };
    }

    // Signal quality metrics
    const peakCorrelation = sourceDelays.length > 0 ? sourceDelays[0].correlation : 0;
    const noiseFloor = this._estimateNoiseFloor(averaged, codeLength);
    const snrEstimate = noiseFloor > 0 ? peakCorrelation / noiseFloor : Infinity;

    return {
      estimatedPosition,
      sourceDelays,
      capturedCode: hardCode,
      captureDuration: capturedSignal.length / this.chipRate,
      numPeriodsAveraged: effectivePeriods,
      sensorCharacteristics: {
        peakCorrelation,
        noiseFloor,
        snrEstimate,
        numSourcesDetected: strongSources.length,
        codeLength,
      },
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Rebuild the pre-generated code table from current sources.
   * Called on construction and could be called after bulk source changes.
   */
  _buildCodes() {
    this._codes = this.sources.map(src => this.goldGen.generate(src.codeOffset));
  }

  /**
   * Update the spatial bounding box from source positions, with 20% padding.
   * Falls back to a default +/-10 m box if no sources are present.
   */
  _updateBounds() {
    if (this.sources.length === 0) {
      this._bounds = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
      return;
    }

    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;

    for (const src of this.sources) {
      xMin = Math.min(xMin, src.position.x);
      xMax = Math.max(xMax, src.position.x);
      yMin = Math.min(yMin, src.position.y);
      yMax = Math.max(yMax, src.position.y);
    }

    // If all sources are at the same point, create a default span
    const spanX = xMax - xMin || 20;
    const spanY = yMax - yMin || 20;
    const pad = 0.2;

    this._bounds = {
      xMin: xMin - spanX * pad,
      xMax: xMax + spanX * pad,
      yMin: yMin - spanY * pad,
      yMax: yMax + spanY * pad,
    };
  }

  /**
   * Compute the maximum propagation delay from any active source to a
   * receiver position.
   */
  _maxPropagationDelay(position) {
    let maxDelay = 0;
    for (const src of this.sources) {
      if (!src.active) continue;
      const dist = _distance(src.position, position);
      maxDelay = Math.max(maxDelay, dist / this.propagation.speed);
    }
    return maxDelay;
  }

  /**
   * Estimate the noise floor from an averaged signal by measuring the
   * median of the lower 80% of absolute correlation values against the
   * first source code.
   */
  _estimateNoiseFloor(averaged, codeLength) {
    if (this._codes.length === 0) return 0;
    const refCode = this._codes[0];

    const correlations = [];
    for (let lag = 0; lag < codeLength; lag++) {
      let corr = 0;
      for (let i = 0; i < codeLength; i++) {
        corr += averaged[i] * (refCode[(i + lag) % codeLength] * 2 - 1);
      }
      correlations.push(Math.abs(corr / codeLength));
    }

    // Sort ascending and average the lower 80% as the noise floor estimate
    correlations.sort((a, b) => a - b);
    const cutoff = Math.floor(correlations.length * 0.8);
    let sum = 0;
    for (let i = 0; i < cutoff; i++) {
      sum += correlations[i];
    }
    return cutoff > 0 ? sum / cutoff : 0;
  }

  /**
   * Time-difference-of-arrival position estimate using iterative Gauss-Newton
   * least-squares linearization.
   *
   * Given N source delays, we form N-1 TDOA equations relative to the
   * strongest source (reference) and iteratively solve for the position
   * that best explains the observed delay differences.
   */
  _tdoaEstimate(sourceDelays) {
    const ref = sourceDelays[0];
    const refSrc = this.sources[ref.sourceIndex];
    const refDist = ref.estimatedDistance;

    if (sourceDelays.length < 3) {
      return {
        x: refSrc.position.x,
        y: refSrc.position.y,
        z: refSrc.position.z,
        approximate: true,
      };
    }

    // Initial guess: centroid of sources weighted by inverse estimated distance
    let cx = 0, cy = 0, cz = 0, wSum = 0;
    for (const sd of sourceDelays) {
      const src = this.sources[sd.sourceIndex];
      const w = 1 / (sd.estimatedDistance + 1e-6);
      cx += src.position.x * w;
      cy += src.position.y * w;
      cz += src.position.z * w;
      wSum += w;
    }
    let pos = { x: cx / wSum, y: cy / wSum, z: cz / wSum };

    // Gauss-Newton iterations
    const maxIter = 20;
    for (let iter = 0; iter < maxIter; iter++) {
      const A = [];
      const b = [];

      const dRef = _distance(pos, refSrc.position);

      for (let k = 1; k < sourceDelays.length; k++) {
        const sd = sourceDelays[k];
        const src = this.sources[sd.sourceIndex];
        const dK = _distance(pos, src.position);

        // TDOA measurement: difference of estimated distances
        const tdoaMeasured = sd.estimatedDistance - refDist;
        // TDOA predicted from current position estimate
        const tdoaPredicted = dK - dRef;
        // Residual
        const residual = tdoaMeasured - tdoaPredicted;
        b.push(residual);

        // Jacobian row: partial derivatives of (dK - dRef) w.r.t. (x, y, z)
        const dKdx = dK > 1e-9 ? (pos.x - src.position.x) / dK : 0;
        const dKdy = dK > 1e-9 ? (pos.y - src.position.y) / dK : 0;
        const dKdz = dK > 1e-9 ? (pos.z - src.position.z) / dK : 0;

        const dRdx = dRef > 1e-9 ? (pos.x - refSrc.position.x) / dRef : 0;
        const dRdy = dRef > 1e-9 ? (pos.y - refSrc.position.y) / dRef : 0;
        const dRdz = dRef > 1e-9 ? (pos.z - refSrc.position.z) / dRef : 0;

        A.push([dKdx - dRdx, dKdy - dRdy, dKdz - dRdz]);
      }

      // Solve 3x3 normal equations: (A^T A) delta = A^T b
      const delta = _solveNormalEquations(A, b);
      if (!delta) break;

      pos = {
        x: pos.x + delta[0],
        y: pos.y + delta[1],
        z: pos.z + delta[2],
      };

      // Convergence check
      const step = Math.sqrt(delta[0] ** 2 + delta[1] ** 2 + delta[2] ** 2);
      if (step < 1e-6) break;
    }

    return {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      approximate: false,
    };
  }
}

// ─── Utility functions (module-private) ─────────────────────────────────────────

/**
 * Euclidean distance between two 3D points.
 */
function _distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Solve the 3x3 normal equations A^T A x = A^T b using Cramer's rule.
 *
 * @param  {number[][]} A  Nx3 Jacobian matrix
 * @param  {number[]}   b  Nx1 residual vector
 * @returns {number[]|null} [dx, dy, dz] or null if the system is singular
 */
function _solveNormalEquations(A, b) {
  const n = A.length;
  if (n < 2) return null;

  // Build 3x3 A^T A and 3x1 A^T b
  const ATA = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const ATb = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    for (let r = 0; r < 3; r++) {
      ATb[r] += A[i][r] * b[i];
      for (let c = 0; c < 3; c++) {
        ATA[r][c] += A[i][r] * A[i][c];
      }
    }
  }

  // Cramer's rule on the 3x3 system
  const det = _det3(ATA);
  if (Math.abs(det) < 1e-15) return null;

  const result = new Array(3);
  for (let col = 0; col < 3; col++) {
    const M = ATA.map(row => row.slice());
    for (let r = 0; r < 3; r++) {
      M[r][col] = ATb[r];
    }
    result[col] = _det3(M) / det;
  }

  return result;
}

/**
 * Determinant of a 3x3 matrix (row-major array of arrays).
 */
function _det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}
