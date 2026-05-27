// Meta-layer configuration hopper
// Drives Gold code parameters through configuration space using layered RNG seeds

import { OTPStream } from './otp.js';

/**
 * Defines the valid ranges and operations for the configuration parameter space.
 * Each parameter has a min, max, and type (continuous or discrete).
 */
export class ConfigurationSpace {
  constructor(registerLength = 5) {
    const codeLength = (1 << registerLength) - 1;
    this.registerLength = registerLength;

    this.parameters = {
      goldCodeOffset: { min: 0, max: codeLength - 1, type: 'discrete' },
      chipRate:       { min: 100, max: 48000, type: 'continuous' },
      phaseShift:     { min: 0, max: 2 * Math.PI, type: 'continuous' },
      fecRate:        { min: 0, max: 3, type: 'discrete' },   // index into rate table
      otpSeed:        { min: 0, max: 0xFFFFFFFF, type: 'discrete' },
    };

    this.fecRateTable = [0.5, 0.667, 0.75, 1.0]; // rate-1/2, 2/3, 3/4, uncoded
  }

  /**
   * Sample a configuration point from an RNG stream.
   * Consumes 5 x 32 bits from the stream.
   */
  sample(rngStream) {
    const config = {};
    for (const [name, spec] of Object.entries(this.parameters)) {
      const raw = this._read32(rngStream);
      if (spec.type === 'discrete') {
        const range = spec.max - spec.min + 1;
        config[name] = spec.min + (raw % range);
      } else {
        config[name] = spec.min + (raw / 0x100000000) * (spec.max - spec.min);
      }
    }
    return config;
  }

  /**
   * Compute Euclidean distance in normalized configuration space.
   * Each dimension is normalized to [0, 1] before distance computation.
   */
  distance(configA, configB) {
    let sumSq = 0;
    for (const [name, spec] of Object.entries(this.parameters)) {
      const range = spec.max - spec.min || 1;
      const nA = (configA[name] - spec.min) / range;
      const nB = (configB[name] - spec.min) / range;

      if (name === 'phaseShift') {
        // Circular distance for phase
        const diff = Math.abs(nA - nB);
        const circDiff = Math.min(diff, 1 - diff);
        sumSq += circDiff * circDiff;
      } else {
        const diff = nA - nB;
        sumSq += diff * diff;
      }
    }
    return Math.sqrt(sumSq);
  }

  /**
   * Smooth interpolation between two configurations.
   * @param {Object} configA - start config
   * @param {Object} configB - end config
   * @param {number} t - interpolation factor in [0, 1]
   * @returns {Object} interpolated configuration
   */
  interpolate(configA, configB, t) {
    const clamped = Math.max(0, Math.min(1, t));
    const result = {};
    for (const [name, spec] of Object.entries(this.parameters)) {
      const a = configA[name];
      const b = configB[name];

      if (name === 'phaseShift') {
        // Shortest-arc interpolation on the circle
        let diff = b - a;
        const fullRange = spec.max - spec.min;
        if (diff > fullRange / 2) diff -= fullRange;
        if (diff < -fullRange / 2) diff += fullRange;
        let val = a + diff * clamped;
        if (val < spec.min) val += fullRange;
        if (val >= spec.max) val -= fullRange;
        result[name] = val;
      } else if (spec.type === 'discrete') {
        result[name] = Math.round(a + (b - a) * clamped);
      } else {
        result[name] = a + (b - a) * clamped;
      }
    }
    return result;
  }

  /**
   * Read 32 bits from an OTPStream as an unsigned integer.
   */
  _read32(rngStream) {
    let val = 0;
    for (let i = 0; i < 32; i++) {
      val |= rngStream.nextBit() << i;
    }
    return val >>> 0;
  }
}

/**
 * MetaLayerHopper — drives Gold code parameters through configuration space
 * using a hierarchy of OTPStream instances as layered RNG sources.
 *
 * Each layer controls a different parameter at a different timescale.
 * The coarsest layer changes every hopIntervalMs * numLayers^2,
 * the finest every hopIntervalMs, with geometric spacing in between.
 */
export class MetaLayerHopper {
  /**
   * @param {Object} opts
   * @param {number} opts.masterSeed - root seed for the entire hierarchy
   * @param {number} opts.hopIntervalMs - base hop interval (finest layer)
   * @param {number} opts.numLayers - number of RNG layers
   * @param {number} opts.registerLength - Gold code register length (5, 7, or 10)
   */
  constructor({ masterSeed, hopIntervalMs = 100, numLayers = 5, registerLength = 5 }) {
    this.masterSeed = masterSeed;
    this.hopIntervalMs = hopIntervalMs;
    this.numLayers = numLayers;
    this.registerLength = registerLength;

    this.configSpace = new ConfigurationSpace(registerLength);
    this.parameterNames = Object.keys(this.configSpace.parameters);

    // Derive per-layer seeds deterministically from the master seed
    this._seedStream = new OTPStream(masterSeed);
    this.layers = [];
    for (let i = 0; i < numLayers; i++) {
      const layerSeed = this._read32(this._seedStream);
      this.layers.push({
        seed: layerSeed,
        stream: new OTPStream(layerSeed),
        // Geometric spacing: layer 0 is finest, layer N-1 is coarsest
        // interval_i = hopIntervalMs * numLayers^(2*i/(numLayers-1))
        // This gives: layer 0 = hopIntervalMs, layer N-1 = hopIntervalMs * numLayers^2
        interval: this._layerInterval(i),
        parameterName: this.parameterNames[i % this.parameterNames.length],
      });
    }
  }

  /**
   * Compute the hop interval for a given layer index.
   * Layer 0 (finest) = hopIntervalMs
   * Layer N-1 (coarsest) = hopIntervalMs * numLayers^2
   * Intermediate layers geometrically spaced.
   */
  _layerInterval(layerIndex) {
    if (this.numLayers <= 1) return this.hopIntervalMs;
    const exponent = (2 * layerIndex) / (this.numLayers - 1);
    return this.hopIntervalMs * Math.pow(this.numLayers, exponent);
  }

  /**
   * Read 32 bits from an OTPStream as an unsigned integer.
   */
  _read32(stream) {
    let val = 0;
    for (let i = 0; i < 32; i++) {
      val |= stream.nextBit() << i;
    }
    return val >>> 0;
  }

  /**
   * Get the configuration sample from a single layer at a specific epoch index.
   * The layer's RNG is seeked to the position corresponding to that epoch,
   * then we read 32 bits to derive the parameter value.
   */
  _layerValueAtEpoch(layerIndex, epochIndex) {
    const layer = this.layers[layerIndex];
    const spec = this.configSpace.parameters[layer.parameterName];

    // Each epoch consumes 32 bits from the layer's stream
    const bitPosition = epochIndex * 32;
    const stream = new OTPStream(layer.seed);
    stream.seek(bitPosition);

    const raw = this._read32(stream);
    if (spec.type === 'discrete') {
      const range = spec.max - spec.min + 1;
      return spec.min + (raw % range);
    } else {
      return spec.min + (raw / 0x100000000) * (spec.max - spec.min);
    }
  }

  /**
   * Get the full configuration at a given time.
   * Each layer contributes its parameter value based on continuous interpolation
   * between epoch boundaries.
   *
   * @param {number} timeMs - time in milliseconds
   * @returns {Object} configuration: { goldCodeOffset, chipRate, phaseShift, fecRate, otpSeed }
   */
  getConfigAtTime(timeMs) {
    const config = {};

    // Initialize all parameters with defaults from the base layer
    for (const name of this.parameterNames) {
      config[name] = this.configSpace.parameters[name].min;
    }

    for (let i = 0; i < this.numLayers; i++) {
      const layer = this.layers[i];
      const interval = layer.interval;
      const paramName = layer.parameterName;
      const spec = this.configSpace.parameters[paramName];

      // Continuous evolution: interpolate between current and next epoch
      const exactEpoch = timeMs / interval;
      const epochFloor = Math.floor(exactEpoch);
      const fractional = exactEpoch - epochFloor;

      const valueCurrent = this._layerValueAtEpoch(i, epochFloor);
      const valueNext = this._layerValueAtEpoch(i, epochFloor + 1);

      // Smooth interpolation using smoothstep for continuous transitions
      const t = fractional * fractional * (3 - 2 * fractional); // smoothstep

      let interpolated;
      if (paramName === 'phaseShift') {
        // Circular interpolation for phase
        const fullRange = spec.max - spec.min;
        let diff = valueNext - valueCurrent;
        if (diff > fullRange / 2) diff -= fullRange;
        if (diff < -fullRange / 2) diff += fullRange;
        interpolated = valueCurrent + diff * t;
        if (interpolated < spec.min) interpolated += fullRange;
        if (interpolated >= spec.max) interpolated -= fullRange;
      } else if (spec.type === 'discrete') {
        interpolated = Math.round(valueCurrent + (valueNext - valueCurrent) * t);
      } else {
        interpolated = valueCurrent + (valueNext - valueCurrent) * t;
      }

      // When multiple layers drive the same parameter, the finer layer overrides
      config[paramName] = interpolated;
    }

    return config;
  }

  /**
   * Generate a hop schedule for a time window.
   * Returns an entry at each point where any layer transitions to a new epoch.
   *
   * @param {number} startMs - window start
   * @param {number} endMs - window end
   * @returns {Array<{time: number, config: Object}>}
   */
  hopSchedule(startMs, endMs) {
    // Collect all epoch boundary times for all layers within the window
    const boundaries = new Set();
    boundaries.add(startMs);
    boundaries.add(endMs);

    for (let i = 0; i < this.numLayers; i++) {
      const interval = this.layers[i].interval;
      const firstEpoch = Math.ceil(startMs / interval);
      const lastEpoch = Math.floor(endMs / interval);
      for (let e = firstEpoch; e <= lastEpoch; e++) {
        const t = e * interval;
        if (t >= startMs && t <= endMs) {
          boundaries.add(t);
        }
      }
    }

    // Sort and compute configs
    const times = Array.from(boundaries).sort((a, b) => a - b);
    return times.map(time => ({
      time,
      config: this.getConfigAtTime(time),
    }));
  }

  /**
   * Verify that a given config matches the expected config at a given time.
   * Useful for authentication — the receiver can check that the transmitter
   * is using the correct seed hierarchy.
   *
   * @param {number} timeMs
   * @param {Object} config - candidate configuration to verify
   * @param {number} tolerance - maximum allowed distance in normalized config space
   * @returns {boolean}
   */
  verifyConfig(timeMs, config, tolerance = 0.01) {
    const expected = this.getConfigAtTime(timeMs);
    const dist = this.configSpace.distance(expected, config);
    return dist <= tolerance;
  }

  /**
   * Return the compact seed representation from which the full history
   * can be regenerated.
   *
   * @returns {Object} { masterSeed, hopIntervalMs, numLayers, registerLength }
   */
  getSeedHierarchy() {
    return {
      masterSeed: this.masterSeed,
      hopIntervalMs: this.hopIntervalMs,
      numLayers: this.numLayers,
      registerLength: this.registerLength,
    };
  }

  /**
   * Regenerate configuration history for any time window at a given resolution.
   *
   * @param {number} startMs
   * @param {number} endMs
   * @param {number} resolution - sampling interval in ms
   * @returns {Array<{time: number, config: Object}>}
   */
  getConfigHistory(startMs, endMs, resolution) {
    const history = [];
    for (let t = startMs; t <= endMs; t += resolution) {
      history.push({
        time: t,
        config: this.getConfigAtTime(t),
      });
    }
    return history;
  }

  /**
   * Reconstruct a MetaLayerHopper from a seed hierarchy.
   * @param {Object} hierarchy - output of getSeedHierarchy()
   * @returns {MetaLayerHopper}
   */
  static fromSeedHierarchy(hierarchy) {
    return new MetaLayerHopper(hierarchy);
  }
}
