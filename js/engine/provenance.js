// Provenance fingerprinting and worldpath tracking
// Embeds provenance metadata into signals via a dedicated Gold code channel
// and tracks the chain of transformations a signal undergoes.

import { GoldCodeGenerator } from '../signal/gold-codes.js';
import { OTPStream } from '../signal/otp.js';
import { ConvolutionalEncoder, ViterbiDecoder } from '../signal/fec.js';

// Well-known Gold code offset for the provenance channel
const PROVENANCE_CODE_OFFSET = 0;

// Metadata field layout (in bits)
const FIELD_LAYOUT = {
  timestamp:   48,  // ms since epoch, ~8900 years range
  sessionId:   32,  // random session identifier
  spatialSigX: 16,  // spatial signature X (quantized)
  spatialSigY: 16,  // spatial signature Y (quantized)
  spatialSigZ: 16,  // spatial signature Z (quantized)
  checksum:    16,  // CRC-16 for integrity
};

const METADATA_BITS = Object.values(FIELD_LAYOUT).reduce((a, b) => a + b, 0);

/**
 * ProvenanceEncoder — embeds and extracts provenance metadata in signals
 * using a dedicated Gold code channel with OTP encryption.
 */
export class ProvenanceEncoder {
  /**
   * @param {Object} opts
   * @param {number} opts.registerLength - Gold code register length (5, 7, or 10)
   * @param {number} opts.otpSeed - seed for OTP encryption of provenance data
   */
  constructor({ registerLength = 5, otpSeed = 0xDEADBEEF } = {}) {
    this.registerLength = registerLength;
    this.goldGen = new GoldCodeGenerator(registerLength);
    this.codeLength = this.goldGen.codeLength;
    this.provenanceCode = this.goldGen.generate(PROVENANCE_CODE_OFFSET);
    this.otpSeed = otpSeed;
    this.encoder = new ConvolutionalEncoder();
    this.decoder = new ViterbiDecoder();
  }

  /**
   * Embed provenance metadata into a signal by modulating the provenance
   * Gold code channel. The metadata is OTP-encrypted before embedding.
   *
   * @param {Float32Array} signal - the host signal to embed into
   * @param {Object} metadata - provenance metadata
   * @param {number} metadata.timestamp - ms since epoch
   * @param {number} metadata.sessionId - session identifier
   * @param {Object} metadata.spatialSignature - {x, y, z} spatial coordinates
   * @param {number} [power=0.05] - embedding power relative to signal
   * @returns {Float32Array} signal with provenance embedded
   */
  embed(signal, metadata, power = 0.05) {
    // Serialize metadata to bits
    const metaBits = this._serializeMetadata(metadata);

    // FEC encode for robustness
    const encoded = this.encoder.encode(metaBits);

    // OTP encrypt
    const otp = new OTPStream(this.otpSeed);
    const encrypted = otp.encrypt(encoded);

    // DSSS spread with the provenance Gold code
    const spread = this._spread(encrypted);

    // Add to signal (create a copy to avoid mutating the input)
    const output = new Float32Array(signal.length);
    output.set(signal);

    for (let i = 0; i < spread.length && i < output.length; i++) {
      output[i] += spread[i] * power;
    }

    return output;
  }

  /**
   * Extract provenance metadata from a signal.
   *
   * @param {Float32Array} signal - signal potentially containing provenance
   * @returns {Object|null} extracted metadata, or null if not found/invalid
   */
  extract(signal) {
    // Despread with the provenance Gold code
    const despread = this._despread(signal);
    if (!despread) return null;

    // OTP decrypt (same seed, same stream position)
    const otp = new OTPStream(this.otpSeed);
    const decrypted = otp.decrypt(despread);

    // FEC decode
    let decoded;
    try {
      decoded = this.decoder.decode(decrypted);
    } catch (_e) {
      return null;
    }

    // Deserialize and verify checksum
    return this._deserializeMetadata(decoded);
  }

  /**
   * Spread data bits using the provenance Gold code.
   */
  _spread(bits) {
    const code = this.provenanceCode;
    const spread = new Float32Array(bits.length * code.length);
    for (let i = 0; i < bits.length; i++) {
      const dataBipolar = bits[i] ? 1 : -1;
      for (let j = 0; j < code.length; j++) {
        const chipBipolar = code[j] ? 1 : -1;
        spread[i * code.length + j] = dataBipolar * chipBipolar;
      }
    }
    return spread;
  }

  /**
   * Despread a signal using the provenance Gold code.
   */
  _despread(signal) {
    const code = this.provenanceCode;
    const numBits = Math.floor(signal.length / code.length);
    if (numBits === 0) return null;

    const bits = new Int8Array(numBits);
    for (let i = 0; i < numBits; i++) {
      let sum = 0;
      for (let j = 0; j < code.length; j++) {
        const chipBipolar = code[j] ? 1 : -1;
        sum += signal[i * code.length + j] * chipBipolar;
      }
      bits[i] = sum > 0 ? 1 : 0;
    }
    return bits;
  }

  /**
   * Serialize metadata object to a bit array.
   */
  _serializeMetadata(metadata) {
    const bits = new Int8Array(METADATA_BITS);
    let offset = 0;

    // Timestamp (48 bits)
    const ts = metadata.timestamp || Date.now();
    this._writeBits(bits, offset, FIELD_LAYOUT.timestamp, ts);
    offset += FIELD_LAYOUT.timestamp;

    // Session ID (32 bits)
    const sid = (metadata.sessionId || 0) >>> 0;
    this._writeBits(bits, offset, FIELD_LAYOUT.sessionId, sid);
    offset += FIELD_LAYOUT.sessionId;

    // Spatial signature (3 x 16 bits, quantized to [0, 65535])
    const spatial = metadata.spatialSignature || { x: 0, y: 0, z: 0 };
    this._writeBits(bits, offset, FIELD_LAYOUT.spatialSigX, this._quantize(spatial.x));
    offset += FIELD_LAYOUT.spatialSigX;
    this._writeBits(bits, offset, FIELD_LAYOUT.spatialSigY, this._quantize(spatial.y));
    offset += FIELD_LAYOUT.spatialSigY;
    this._writeBits(bits, offset, FIELD_LAYOUT.spatialSigZ, this._quantize(spatial.z));
    offset += FIELD_LAYOUT.spatialSigZ;

    // CRC-16 checksum over everything before this point
    const crc = this._crc16(bits, 0, offset);
    this._writeBits(bits, offset, FIELD_LAYOUT.checksum, crc);

    return bits;
  }

  /**
   * Deserialize a bit array back to metadata, verifying the checksum.
   */
  _deserializeMetadata(bits) {
    if (bits.length < METADATA_BITS) return null;

    let offset = 0;

    const timestamp = this._readBits(bits, offset, FIELD_LAYOUT.timestamp);
    offset += FIELD_LAYOUT.timestamp;

    const sessionId = this._readBits(bits, offset, FIELD_LAYOUT.sessionId);
    offset += FIELD_LAYOUT.sessionId;

    const spatialX = this._readBits(bits, offset, FIELD_LAYOUT.spatialSigX);
    offset += FIELD_LAYOUT.spatialSigX;
    const spatialY = this._readBits(bits, offset, FIELD_LAYOUT.spatialSigY);
    offset += FIELD_LAYOUT.spatialSigY;
    const spatialZ = this._readBits(bits, offset, FIELD_LAYOUT.spatialSigZ);
    offset += FIELD_LAYOUT.spatialSigZ;

    // Verify checksum
    const storedCrc = this._readBits(bits, offset, FIELD_LAYOUT.checksum);
    const computedCrc = this._crc16(bits, 0, offset);
    if (storedCrc !== computedCrc) return null;

    return {
      timestamp,
      sessionId,
      spatialSignature: {
        x: this._dequantize(spatialX),
        y: this._dequantize(spatialY),
        z: this._dequantize(spatialZ),
      },
    };
  }

  /**
   * Write a numeric value as little-endian bits into a bit array.
   */
  _writeBits(bits, offset, count, value) {
    // For values > 32 bits, handle as two parts
    let lo = value >>> 0;
    let hi = 0;
    if (count > 32) {
      // JavaScript bitwise ops are 32-bit, so handle the high part via division
      hi = Math.floor(value / 0x100000000) >>> 0;
    }
    for (let i = 0; i < Math.min(count, 32); i++) {
      bits[offset + i] = (lo >>> i) & 1;
    }
    for (let i = 32; i < count; i++) {
      bits[offset + i] = (hi >>> (i - 32)) & 1;
    }
  }

  /**
   * Read bits from a bit array as a numeric value (little-endian).
   */
  _readBits(bits, offset, count) {
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < Math.min(count, 32); i++) {
      if (bits[offset + i]) lo |= (1 << i);
    }
    lo = lo >>> 0;
    for (let i = 32; i < count; i++) {
      if (bits[offset + i]) hi |= (1 << (i - 32));
    }
    hi = hi >>> 0;
    if (count <= 32) return lo;
    return hi * 0x100000000 + lo;
  }

  /**
   * Quantize a float in [-1, 1] to a 16-bit unsigned integer.
   */
  _quantize(value) {
    const clamped = Math.max(-1, Math.min(1, value || 0));
    return Math.round((clamped + 1) * 0.5 * 0xFFFF) & 0xFFFF;
  }

  /**
   * Dequantize a 16-bit unsigned integer back to a float in [-1, 1].
   */
  _dequantize(value) {
    return (value / 0xFFFF) * 2 - 1;
  }

  /**
   * CRC-16-CCITT over a range of bits.
   */
  _crc16(bits, start, length) {
    let crc = 0xFFFF;
    for (let i = start; i < start + length; i++) {
      const bit = bits[i] & 1;
      const xorBit = ((crc >> 15) ^ bit) & 1;
      crc = (crc << 1) & 0xFFFF;
      if (xorBit) crc ^= 0x1021;
    }
    return crc;
  }
}


/**
 * WorldpathTracker — tracks the chain of transformations a signal undergoes,
 * computes composite fingerprints, and can infer transformations by comparing
 * original and captured signals.
 */
export class WorldpathTracker {
  constructor() {
    this._transformations = [];
    this._createdAt = Date.now();
  }

  /**
   * Log a transformation that the signal has undergone.
   *
   * @param {string} type - transformation type: 'copy', 'transcode', 'transmit',
   *   'compress', 'resample', 'noise', 'amplify', 'filter', 'capture', etc.
   * @param {Object} metadata - additional info about the transformation
   * @param {number} [metadata.timestamp] - when the transformation occurred
   * @param {string} [metadata.codec] - codec used (for transcode/compress)
   * @param {number} [metadata.sampleRate] - sample rate (for resample)
   * @param {number} [metadata.bitrate] - bitrate (for compress)
   * @param {number} [metadata.gain] - gain factor (for amplify)
   * @param {Object} [metadata.filterParams] - filter parameters
   */
  addTransformation(type, metadata = {}) {
    this._transformations.push({
      type,
      timestamp: metadata.timestamp || Date.now(),
      metadata: { ...metadata },
      index: this._transformations.length,
    });
  }

  /**
   * Returns the full chain of transformations.
   *
   * @returns {Array<{type: string, timestamp: number, metadata: Object, index: number}>}
   */
  getWorldpath() {
    return this._transformations.map(t => ({ ...t, metadata: { ...t.metadata } }));
  }

  /**
   * Compute a fingerprint of a signal that includes the accumulated worldpath.
   * The fingerprint is a 64-bit hash (as a hex string) combining spectral
   * features of the signal with the worldpath chain.
   *
   * @param {Float32Array} signal - the signal to fingerprint
   * @returns {string} hex fingerprint
   */
  fingerprint(signal) {
    // Compute spectral energy distribution in 8 bands
    const bands = this._spectralBands(signal, 8);

    // Hash the spectral bands
    let hash = 0x811c9dc5; // FNV-1a offset basis (32-bit)
    for (let i = 0; i < bands.length; i++) {
      // Quantize band energy to 16-bit integer
      const quantized = Math.round(Math.min(bands[i], 1) * 0xFFFF) & 0xFFFF;
      hash = this._fnv1aStep(hash, quantized & 0xFF);
      hash = this._fnv1aStep(hash, (quantized >> 8) & 0xFF);
    }

    // Mix in the worldpath
    for (const t of this._transformations) {
      // Hash transformation type string
      for (let i = 0; i < t.type.length; i++) {
        hash = this._fnv1aStep(hash, t.type.charCodeAt(i));
      }
      // Hash timestamp (lower 32 bits)
      const ts = t.timestamp >>> 0;
      hash = this._fnv1aStep(hash, ts & 0xFF);
      hash = this._fnv1aStep(hash, (ts >> 8) & 0xFF);
      hash = this._fnv1aStep(hash, (ts >> 16) & 0xFF);
      hash = this._fnv1aStep(hash, (ts >> 24) & 0xFF);
    }

    // Compute a second hash with different offset for 64-bit fingerprint
    let hash2 = 0x01000193; // FNV prime as alternate offset
    for (let i = 0; i < bands.length; i++) {
      const quantized = Math.round(Math.min(bands[i], 1) * 0xFFFF) & 0xFFFF;
      hash2 = this._fnv1aStep(hash2, (quantized >> 8) & 0xFF);
      hash2 = this._fnv1aStep(hash2, quantized & 0xFF);
    }
    for (const t of this._transformations) {
      for (let i = t.type.length - 1; i >= 0; i--) {
        hash2 = this._fnv1aStep(hash2, t.type.charCodeAt(i));
      }
    }

    const hex1 = (hash >>> 0).toString(16).padStart(8, '0');
    const hex2 = (hash2 >>> 0).toString(16).padStart(8, '0');
    return hex1 + hex2;
  }

  /**
   * Compare an original and captured signal to infer what transformations
   * have occurred. Detects: compression artifacts, resampling, noise addition,
   * amplitude changes, spectral filtering, and time stretching.
   *
   * @param {Float32Array} originalSignal
   * @param {Float32Array} capturedSignal
   * @returns {Array<{type: string, confidence: number, details: Object}>}
   */
  detectTransformations(originalSignal, capturedSignal) {
    const detections = [];

    // 1. Check for amplitude/gain change
    const origRms = this._rms(originalSignal);
    const captRms = this._rms(capturedSignal);
    if (origRms > 0) {
      const gainRatio = captRms / origRms;
      if (Math.abs(gainRatio - 1.0) > 0.05) {
        detections.push({
          type: 'amplify',
          confidence: Math.min(1, Math.abs(gainRatio - 1.0) * 5),
          details: { gainRatio, originalRms: origRms, capturedRms: captRms },
        });
      }
    }

    // 2. Check for resampling (length mismatch)
    const lengthRatio = capturedSignal.length / originalSignal.length;
    if (Math.abs(lengthRatio - 1.0) > 0.01) {
      detections.push({
        type: 'resample',
        confidence: Math.min(1, Math.abs(lengthRatio - 1.0) * 10),
        details: {
          originalLength: originalSignal.length,
          capturedLength: capturedSignal.length,
          ratio: lengthRatio,
        },
      });
    }

    // 3. Check for additive noise
    // Resample captured to original length for direct comparison
    const aligned = this._resampleToLength(capturedSignal, originalSignal.length);
    const normalizedAligned = this._normalizeRms(aligned, origRms);
    const residual = new Float32Array(originalSignal.length);
    for (let i = 0; i < originalSignal.length; i++) {
      residual[i] = normalizedAligned[i] - originalSignal[i];
    }
    const residualRms = this._rms(residual);
    const snr = origRms > 0 ? origRms / Math.max(residualRms, 1e-10) : Infinity;
    if (snr < 100) {
      detections.push({
        type: 'noise',
        confidence: Math.min(1, 1 - snr / 100),
        details: { snrLinear: snr, snrDb: 20 * Math.log10(snr), residualRms },
      });
    }

    // 4. Check for spectral filtering (high-frequency loss = compression/filtering)
    const origBands = this._spectralBands(originalSignal, 8);
    const captBands = this._spectralBands(capturedSignal, 8);
    let highFreqLoss = 0;
    let lowFreqLoss = 0;
    for (let i = 0; i < 8; i++) {
      const origE = origBands[i] || 1e-10;
      const captE = captBands[i] || 0;
      const ratio = captE / origE;
      if (i >= 5) {
        highFreqLoss += Math.max(0, 1 - ratio);
      } else if (i <= 1) {
        lowFreqLoss += Math.max(0, 1 - ratio);
      }
    }
    highFreqLoss /= 3;
    lowFreqLoss /= 2;

    if (highFreqLoss > 0.1) {
      detections.push({
        type: 'compress',
        confidence: Math.min(1, highFreqLoss),
        details: {
          highFreqLoss,
          spectralProfile: { original: Array.from(origBands), captured: Array.from(captBands) },
        },
      });
    }

    if (lowFreqLoss > 0.1 || highFreqLoss > 0.1) {
      detections.push({
        type: 'filter',
        confidence: Math.min(1, Math.max(lowFreqLoss, highFreqLoss)),
        details: { lowFreqLoss, highFreqLoss },
      });
    }

    // 5. Check for time stretching (cross-correlation peak offset)
    const corrPeak = this._findCrossCorrelationPeak(originalSignal, capturedSignal);
    if (corrPeak.offset !== 0) {
      detections.push({
        type: 'timeShift',
        confidence: corrPeak.peakValue,
        details: { offsetSamples: corrPeak.offset, peakCorrelation: corrPeak.peakValue },
      });
    }

    return detections.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * From signal characteristics, estimate the capture geometry:
   * capture duration, sensor bandwidth, distance/attenuation, spatial averaging.
   *
   * @param {Float32Array} signal
   * @returns {Object} estimated capture parameters
   */
  estimateCaptureGeometry(signal) {
    const duration = signal.length; // in samples
    const rms = this._rms(signal);
    const bands = this._spectralBands(signal, 16);

    // Estimate effective bandwidth from spectral rolloff
    let totalEnergy = 0;
    let weightedFreq = 0;
    let maxBandEnergy = 0;
    let rolloffBand = bands.length;
    for (let i = 0; i < bands.length; i++) {
      totalEnergy += bands[i];
      weightedFreq += bands[i] * (i + 0.5);
      maxBandEnergy = Math.max(maxBandEnergy, bands[i]);
    }
    const centroidBand = totalEnergy > 0 ? weightedFreq / totalEnergy : 0;

    // Find -3dB rolloff point
    const threshold3dB = maxBandEnergy * 0.5;
    for (let i = bands.length - 1; i >= 0; i--) {
      if (bands[i] >= threshold3dB) {
        rolloffBand = i + 1;
        break;
      }
    }
    const bandwidthFraction = rolloffBand / bands.length;

    // Estimate distance/attenuation from signal level
    // Assume free-space path loss: power falls as 1/r^2
    // Normalized so rms=1 corresponds to distance=1 unit
    const estimatedAttenuation = rms > 0 ? 1 / (rms * rms) : Infinity;

    // Estimate spatial averaging from spectral smoothness
    // More averaging -> smoother spectrum -> lower variance between bands
    let spectralVariance = 0;
    const meanEnergy = totalEnergy / bands.length;
    for (let i = 0; i < bands.length; i++) {
      const diff = bands[i] - meanEnergy;
      spectralVariance += diff * diff;
    }
    spectralVariance /= bands.length;
    const spectralSmoothness = 1 / (1 + spectralVariance / (meanEnergy * meanEnergy + 1e-10));

    // Estimate peak-to-average ratio (crest factor) as a spatial averaging indicator
    let peak = 0;
    for (let i = 0; i < signal.length; i++) {
      peak = Math.max(peak, Math.abs(signal[i]));
    }
    const crestFactor = rms > 0 ? peak / rms : 0;

    return {
      captureDuration: duration,
      sensorBandwidth: bandwidthFraction,
      spectralCentroid: centroidBand / bands.length,
      rolloffBand,
      estimatedAttenuation,
      estimatedDistance: Math.sqrt(estimatedAttenuation),
      spatialAveraging: spectralSmoothness,
      crestFactor,
      rmsLevel: rms,
      peakLevel: peak,
      spectralBands: Array.from(bands),
    };
  }

  // --- Internal helpers ---

  /**
   * FNV-1a hash step (32-bit).
   */
  _fnv1aStep(hash, byte) {
    hash ^= byte & 0xFF;
    hash = Math.imul(hash, 0x01000193);
    return hash >>> 0;
  }

  /**
   * Compute RMS of a signal.
   */
  _rms(signal) {
    let sum = 0;
    for (let i = 0; i < signal.length; i++) {
      sum += signal[i] * signal[i];
    }
    return Math.sqrt(sum / (signal.length || 1));
  }

  /**
   * Compute spectral energy in N equal-width bands using a simple DFT approach.
   * For efficiency, uses block averaging and partial DFT.
   */
  _spectralBands(signal, numBands) {
    const bands = new Float32Array(numBands);
    const N = signal.length;
    if (N === 0) return bands;

    // Use block-averaged periodogram
    const blockSize = Math.min(512, N);
    const numBlocks = Math.max(1, Math.floor(N / blockSize));
    const binsPerBand = Math.max(1, Math.floor(blockSize / (2 * numBands)));

    for (let b = 0; b < numBlocks; b++) {
      const offset = b * blockSize;
      // Compute DFT magnitude for bins in each band
      for (let band = 0; band < numBands; band++) {
        const binStart = band * binsPerBand;
        const binEnd = Math.min(binStart + binsPerBand, Math.floor(blockSize / 2));
        for (let k = binStart; k < binEnd; k++) {
          let re = 0;
          let im = 0;
          const freq = (2 * Math.PI * k) / blockSize;
          for (let n = 0; n < blockSize && (offset + n) < N; n++) {
            const sample = signal[offset + n];
            re += sample * Math.cos(freq * n);
            im -= sample * Math.sin(freq * n);
          }
          bands[band] += (re * re + im * im) / (blockSize * blockSize);
        }
      }
    }

    // Normalize by number of blocks
    for (let i = 0; i < numBands; i++) {
      bands[i] /= numBlocks;
    }

    return bands;
  }

  /**
   * Resample a signal to a target length using linear interpolation.
   */
  _resampleToLength(signal, targetLength) {
    if (signal.length === targetLength) return new Float32Array(signal);
    const out = new Float32Array(targetLength);
    const ratio = signal.length / targetLength;
    for (let i = 0; i < targetLength; i++) {
      const srcIdx = i * ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, signal.length - 1);
      const frac = srcIdx - lo;
      out[i] = signal[lo] * (1 - frac) + signal[hi] * frac;
    }
    return out;
  }

  /**
   * Normalize a signal to a target RMS level.
   */
  _normalizeRms(signal, targetRms) {
    const currentRms = this._rms(signal);
    if (currentRms < 1e-10) return new Float32Array(signal.length);
    const scale = targetRms / currentRms;
    const out = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      out[i] = signal[i] * scale;
    }
    return out;
  }

  /**
   * Find the cross-correlation peak between two signals.
   * Uses a windowed approach for efficiency.
   */
  _findCrossCorrelationPeak(signalA, signalB) {
    const windowSize = Math.min(256, signalA.length, signalB.length);
    const maxLag = Math.min(64, Math.floor(windowSize / 2));

    let bestCorr = -Infinity;
    let bestOffset = 0;

    const aSlice = signalA.subarray(0, windowSize);

    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let sum = 0;
      let count = 0;
      for (let i = 0; i < windowSize; i++) {
        const j = i + lag;
        if (j >= 0 && j < signalB.length) {
          sum += aSlice[i] * signalB[j];
          count++;
        }
      }
      const normalized = count > 0 ? sum / count : 0;
      if (normalized > bestCorr) {
        bestCorr = normalized;
        bestOffset = lag;
      }
    }

    // Normalize peak value to [0, 1]
    const aRms = this._rms(aSlice);
    const bRms = this._rms(signalB.subarray(0, windowSize));
    const normFactor = aRms * bRms;
    const peakValue = normFactor > 0 ? Math.min(1, bestCorr / normFactor) : 0;

    return { offset: bestOffset, peakValue };
  }
}
