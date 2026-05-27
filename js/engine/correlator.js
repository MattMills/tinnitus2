// Cross-domain correlation engine
// Finds signals across audio and visual domains, extracts spreading codes

import { GoldCodeGenerator } from '../signal/gold-codes.js';

export class Correlator {
  constructor() {
    this._fftSize = 1024;
    this._correlationHistory = [];
    this._maxHistory = 256;
  }

  // FFT-based cross-correlation (O(N log N))
  crossCorrelate(signalA, signalB) {
    const N = nextPow2(signalA.length + signalB.length - 1);
    const reA = new Float32Array(N);
    const imA = new Float32Array(N);
    const reB = new Float32Array(N);
    const imB = new Float32Array(N);

    reA.set(signalA);
    reB.set(signalB);

    fft(reA, imA, false);
    fft(reB, imB, false);

    // Multiply A by conjugate of B
    const reC = new Float32Array(N);
    const imC = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      reC[i] = reA[i] * reB[i] + imA[i] * imB[i];
      imC[i] = imA[i] * reB[i] - reA[i] * imB[i];
    }

    fft(reC, imC, true);
    return reC.slice(0, signalA.length);
  }

  // Detect Gold codes present in a signal
  detectCodes(signal, goldGen, threshold = 0.3) {
    const family = goldGen.generateFamily();
    const detections = [];

    for (const { offset, code } of family) {
      // Convert to bipolar
      const bipolar = new Float32Array(code.length);
      for (let i = 0; i < code.length; i++) {
        bipolar[i] = code[i] * 2 - 1;
      }

      const corr = this.crossCorrelate(signal, bipolar);

      let peak = 0;
      let peakLag = 0;
      for (let i = 0; i < corr.length; i++) {
        const absVal = Math.abs(corr[i]);
        if (absVal > peak) {
          peak = absVal;
          peakLag = i;
        }
      }

      const normalized = peak / code.length;
      if (normalized > threshold) {
        detections.push({ offset, peak: normalized, lag: peakLag, code });
      }
    }

    return detections.sort((a, b) => b.peak - a.peak);
  }

  // Cross-correlate visual pattern with audio signal
  visualAudioCorrelation(visualData, audioData) {
    // Flatten visual data to 1D signal for correlation
    const visual1D = new Float32Array(visualData.length);
    for (let i = 0; i < visualData.length; i++) {
      visual1D[i] = visualData[i];
    }

    // Resample to match lengths if needed
    const targetLen = Math.min(visual1D.length, audioData.length);
    const resampledVisual = resample(visual1D, targetLen);
    const resampledAudio = resample(audioData, targetLen);

    return this.crossCorrelate(resampledVisual, resampledAudio);
  }

  // Build a 2D pattern from a signal for visual encoding
  signalToPattern(signal, width, height) {
    const pattern = new Float32Array(width * height);
    const samplesPerCell = Math.max(1, Math.floor(signal.length / (width * height)));

    for (let i = 0; i < width * height; i++) {
      let sum = 0;
      for (let j = 0; j < samplesPerCell; j++) {
        const idx = i * samplesPerCell + j;
        if (idx < signal.length) sum += signal[idx];
      }
      pattern[i] = sum / samplesPerCell;
    }
    return pattern;
  }

  // Extract spreading code from observed signal
  extractCode(signal, codeLength) {
    const numPeriods = Math.floor(signal.length / codeLength);
    if (numPeriods < 2) return null;

    // Average over periods to extract repeating code
    const code = new Float32Array(codeLength);
    for (let i = 0; i < numPeriods; i++) {
      for (let j = 0; j < codeLength; j++) {
        code[j] += signal[i * codeLength + j];
      }
    }
    for (let j = 0; j < codeLength; j++) {
      code[j] /= numPeriods;
    }

    // Hard decision
    const hardCode = new Int8Array(codeLength);
    for (let j = 0; j < codeLength; j++) {
      hardCode[j] = code[j] > 0 ? 1 : 0;
    }

    return { soft: code, hard: hardCode };
  }

  // Track correlation over time for persistence display
  pushCorrelationFrame(data) {
    this._correlationHistory.push(data);
    if (this._correlationHistory.length > this._maxHistory) {
      this._correlationHistory.shift();
    }
  }

  getCorrelationHistory() {
    return this._correlationHistory;
  }
}

// Radix-2 FFT (in-place, Cooley-Tukey)
function fft(re, im, inverse) {
  const N = re.length;
  const logN = Math.log2(N);

  // Bit-reversal permutation
  for (let i = 0; i < N; i++) {
    const j = bitReverse(i, logN);
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Butterfly
  for (let size = 2; size <= N; size *= 2) {
    const half = size / 2;
    const angle = (inverse ? 2 : -2) * Math.PI / size;

    for (let i = 0; i < N; i += size) {
      for (let j = 0; j < half; j++) {
        const wr = Math.cos(angle * j);
        const wi = Math.sin(angle * j);
        const idx1 = i + j;
        const idx2 = i + j + half;

        const tRe = wr * re[idx2] - wi * im[idx2];
        const tIm = wr * im[idx2] + wi * re[idx2];

        re[idx2] = re[idx1] - tRe;
        im[idx2] = im[idx1] - tIm;
        re[idx1] += tRe;
        im[idx1] += tIm;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < N; i++) {
      re[i] /= N;
      im[i] /= N;
    }
  }
}

function bitReverse(x, bits) {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (x & 1);
    x >>= 1;
  }
  return result;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function resample(signal, targetLen) {
  if (signal.length === targetLen) return signal;
  const out = new Float32Array(targetLen);
  const ratio = signal.length / targetLen;
  for (let i = 0; i < targetLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, signal.length - 1);
    const frac = srcIdx - lo;
    out[i] = signal[lo] * (1 - frac) + signal[hi] * frac;
  }
  return out;
}
