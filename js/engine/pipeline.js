// Signal pipeline — orchestrates the full encode/embed/detect/extract workflow

import { GoldCodeGenerator } from '../signal/gold-codes.js';
import { SignalSpreader, embedInNoise } from '../signal/spreader.js';
import { OTPStream, createOTPPair } from '../signal/otp.js';
import { Correlator } from './correlator.js';

export class SignalPipeline {
  constructor() {
    this.spreader = new SignalSpreader({ registerLength: 5, chipRate: 1000 });
    this.correlator = new Correlator();
    this.goldGen = this.spreader.goldGen;
    this.channels = new Map();
    this._nextChannelId = 0;
    this._embeddedSignal = null;
    this._patternData = null;
    this._patternWidth = 32;
    this._patternHeight = 32;
    this._correlationResults = [];
    this._detectionResults = [];
  }

  setRegisterLength(len) {
    this.spreader = new SignalSpreader({ registerLength: len });
    this.goldGen = this.spreader.goldGen;
    // Re-assign existing channels
    for (const [id, ch] of this.channels) {
      this.spreader.assignCode(id, ch.phaseOffset);
    }
  }

  setOTPSeed(seed) {
    this.spreader.otp = seed !== null ? new OTPStream(seed) : null;
  }

  createChannel(name, phaseOffset) {
    const id = this._nextChannelId++;
    const code = this.spreader.assignCode(id, phaseOffset % this.goldGen.codeLength);
    this.channels.set(id, { name, phaseOffset, code, data: null, spread: null });
    return id;
  }

  removeChannel(id) {
    this.channels.delete(id);
  }

  // Encode text to bits
  textToBits(text) {
    const bytes = new TextEncoder().encode(text);
    const bits = new Int8Array(bytes.length * 8);
    for (let i = 0; i < bytes.length; i++) {
      for (let j = 0; j < 8; j++) {
        bits[i * 8 + j] = (bytes[i] >> j) & 1;
      }
    }
    return bits;
  }

  bitsToText(bits) {
    const numBytes = Math.floor(bits.length / 8);
    const bytes = new Uint8Array(numBytes);
    for (let i = 0; i < numBytes; i++) {
      let byte = 0;
      for (let j = 0; j < 8; j++) {
        byte |= (bits[i * 8 + j] & 1) << j;
      }
      bytes[i] = byte;
    }
    return new TextDecoder().decode(bytes);
  }

  // Encode and spread a message on a channel
  encodeMessage(channelId, text) {
    const ch = this.channels.get(channelId);
    if (!ch) throw new Error(`Channel ${channelId} not found`);

    const bits = this.textToBits(text);
    ch.data = bits;
    ch.spread = this.spreader.spread(bits, channelId);
    return ch.spread;
  }

  // Combine all channel spread signals with noise
  embed(noisePower = 1.0, signalPower = 0.1) {
    let maxLen = 0;
    for (const [, ch] of this.channels) {
      if (ch.spread) maxLen = Math.max(maxLen, ch.spread.length);
    }
    if (maxLen === 0) return null;

    const combined = new Float32Array(maxLen);
    // Add noise
    for (let i = 0; i < maxLen; i++) {
      combined[i] = (Math.random() * 2 - 1) * noisePower;
    }
    // Add all channel signals
    for (const [, ch] of this.channels) {
      if (!ch.spread) continue;
      for (let i = 0; i < ch.spread.length; i++) {
        combined[i] += ch.spread[i] * signalPower;
      }
    }

    this._embeddedSignal = combined;
    this._patternData = this.correlator.signalToPattern(
      combined, this._patternWidth, this._patternHeight
    );

    return combined;
  }

  // Detect which channels are present in a signal
  detect(signal, threshold = 0.3) {
    if (!signal) signal = this._embeddedSignal;
    if (!signal) return [];

    this._detectionResults = this.correlator.detectCodes(
      signal, this.goldGen, threshold
    );
    return this._detectionResults;
  }

  // Despread and decode a specific channel
  decodeChannel(channelId, signal) {
    if (!signal) signal = this._embeddedSignal;
    if (!signal) return null;

    try {
      const bits = this.spreader.despread(signal, channelId);
      return this.bitsToText(bits);
    } catch (e) {
      return null;
    }
  }

  // Cross-correlate between visual pattern and audio
  crossDomainCorrelation() {
    if (!this._embeddedSignal || !this._patternData) return null;

    const corr = this.correlator.visualAudioCorrelation(
      this._patternData, this._embeddedSignal
    );
    return corr;
  }

  // Extract spreading code from signal
  extractCode(signal, codeLength) {
    if (!signal) signal = this._embeddedSignal;
    if (!signal) return null;
    return this.correlator.extractCode(signal, codeLength || this.goldGen.codeLength);
  }

  // Get all correlation results for visualization
  getCorrelationData() {
    if (!this._embeddedSignal) return [];

    const results = [];
    for (const [channelId, ch] of this.channels) {
      const bipolarCode = new Float32Array(ch.code.length);
      for (let i = 0; i < ch.code.length; i++) {
        bipolarCode[i] = ch.code[i] * 2 - 1;
      }
      const corr = this.correlator.crossCorrelate(
        this._embeddedSignal.slice(0, 256),
        bipolarCode.slice(0, Math.min(bipolarCode.length, 256))
      );
      results.push(corr);
    }
    return results;
  }

  getCorrelationLabels() {
    return Array.from(this.channels.values()).map(ch => ch.name);
  }

  get patternData() { return this._patternData; }
  get patternWidth() { return this._patternWidth; }
  get patternHeight() { return this._patternHeight; }
  get embeddedSignal() { return this._embeddedSignal; }
  get detectionResults() { return this._detectionResults; }
}
