// DSSS spreading/despreading and signal embedding utilities

import { GoldCodeGenerator } from './gold-codes.js';
import { ConvolutionalEncoder, ViterbiDecoder, BlockInterleaver } from './fec.js';
import { OTPStream } from './otp.js';

export class SignalSpreader {
  constructor({ registerLength = 5, chipRate = 1000, otpSeed = null } = {}) {
    this.goldGen = new GoldCodeGenerator(registerLength);
    this.encoder = new ConvolutionalEncoder();
    this.decoder = new ViterbiDecoder();
    this.chipRate = chipRate;
    this.codeLength = this.goldGen.codeLength;

    // Build interleaver sized to match FEC output blocks
    this.interleaver = new BlockInterleaver(8, this.codeLength);

    this.otp = otpSeed !== null ? new OTPStream(otpSeed) : null;

    this._assignedCodes = new Map();
  }

  assignCode(channelId, phaseOffset) {
    const code = this.goldGen.generate(phaseOffset);
    this._assignedCodes.set(channelId, { phaseOffset, code });
    return code;
  }

  getCode(channelId) {
    return this._assignedCodes.get(channelId)?.code;
  }

  // Full transmit pipeline: data → FEC encode → interleave → OTP → DSSS spread
  spread(dataBits, channelId) {
    let bits = new Int8Array(dataBits);

    // FEC encode
    bits = this.encoder.encode(bits);

    // Interleave
    const blockSize = this.interleaver.rows * this.interleaver.cols;
    const padded = new Int8Array(Math.ceil(bits.length / blockSize) * blockSize);
    padded.set(bits);
    let interleaved = new Int8Array(padded.length);
    for (let i = 0; i < padded.length; i += blockSize) {
      const block = padded.slice(i, i + blockSize);
      interleaved.set(this.interleaver.interleave(block), i);
    }
    bits = interleaved;

    // OTP encryption
    if (this.otp) {
      this.otp.seek(0);
      bits = this.otp.encrypt(bits);
    }

    // DSSS spread
    const code = this.getCode(channelId);
    if (!code) throw new Error(`No code assigned for channel ${channelId}`);

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

  // Full receive pipeline: despread → OTP decrypt → deinterleave → FEC decode
  despread(signal, channelId) {
    const code = this.getCode(channelId);
    if (!code) throw new Error(`No code assigned for channel ${channelId}`);

    // Despread — correlate with code
    const numBits = Math.floor(signal.length / code.length);
    const softBits = new Float32Array(numBits);
    for (let i = 0; i < numBits; i++) {
      let sum = 0;
      for (let j = 0; j < code.length; j++) {
        const chipBipolar = code[j] ? 1 : -1;
        sum += signal[i * code.length + j] * chipBipolar;
      }
      softBits[i] = sum;
    }

    // Hard decision
    let bits = new Int8Array(numBits);
    for (let i = 0; i < numBits; i++) {
      bits[i] = softBits[i] > 0 ? 1 : 0;
    }

    // OTP decrypt
    if (this.otp) {
      this.otp.seek(0);
      bits = this.otp.decrypt(bits);
    }

    // Deinterleave
    const blockSize = this.interleaver.rows * this.interleaver.cols;
    let deinterleaved = new Int8Array(bits.length);
    for (let i = 0; i < bits.length; i += blockSize) {
      const block = bits.slice(i, i + blockSize);
      deinterleaved.set(this.interleaver.deinterleave(block), i);
    }

    // FEC decode
    return this.decoder.decode(deinterleaved);
  }

  // Detect which Gold codes are present in a signal
  detect(signal, threshold = 0.5) {
    const results = [];
    for (const [channelId, { code, phaseOffset }] of this._assignedCodes) {
      const numBits = Math.floor(signal.length / code.length);
      if (numBits === 0) continue;

      let maxCorr = 0;
      for (let i = 0; i < Math.min(numBits, 10); i++) {
        let sum = 0;
        for (let j = 0; j < code.length; j++) {
          const chipBipolar = code[j] ? 1 : -1;
          sum += signal[i * code.length + j] * chipBipolar;
        }
        maxCorr = Math.max(maxCorr, Math.abs(sum) / code.length);
      }

      if (maxCorr > threshold) {
        results.push({ channelId, phaseOffset, correlation: maxCorr });
      }
    }
    return results.sort((a, b) => b.correlation - a.correlation);
  }
}

// Embed a spread signal into noise at a given power ratio
export function embedInNoise(spreadSignal, noisePower = 1.0, signalPower = 0.1) {
  const out = new Float32Array(spreadSignal.length);
  for (let i = 0; i < out.length; i++) {
    const noise = (Math.random() * 2 - 1) * noisePower;
    out[i] = noise + spreadSignal[i] * signalPower;
  }
  return out;
}
