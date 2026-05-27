// Audio engine — manages Web Audio context, noise generators, tone oscillators, and DSSS modulator
//
// Audio graph architecture:
//
//   NoiseNode → noiseGain ─→ modulatorGain ─→ masterGain → analyser → destination
//                              ↑ (gain param)
//                           dsssNode
//
//   Oscillators → oscGain ──→ masterGain
//
// The DSSS signal modulates the noise (amplitude modulation) rather than
// being an additive parallel path.  This means the spreading code shapes
// the noise itself — the code IS the noise structure.  A small direct
// DSSS path is available for engineering/debug but defaults to off.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.noiseNode = null;
    this.noiseGain = null;
    this.dsssNode = null;
    this.modulatorGain = null;     // noise passes through here; DSSS controls its gain
    this.directDsssGain = null;    // optional additive DSSS (off by default)
    this.modulationDepth = null;   // GainNode scaling DSSS before it hits the modulator param
    this.oscillators = [];
    this.analyser = null;
    this.running = false;
    this._timeDomainData = null;
    this._frequencyData = null;
  }

  async init() {
    this.ctx = new AudioContext({ sampleRate: 48000 });

    await this.ctx.audioWorklet.addModule('js/audio/noise-processor.js');
    await this.ctx.audioWorklet.addModule('js/audio/dsss-processor.js');

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.7;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this._timeDomainData = new Float32Array(this.analyser.fftSize);
    this._frequencyData = new Float32Array(this.analyser.frequencyBinCount);

    this._initNoise();
    this._initDSSS();

    this.running = true;
  }

  _initNoise() {
    this.noiseNode = new AudioWorkletNode(this.ctx, 'noise-processor');
    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 0.3;

    // Modulator: noise flows through this gain node.
    // DSSS signal is connected to its .gain AudioParam,
    // so output = noise * (baseGain + dsssSignal * depth).
    this.modulatorGain = this.ctx.createGain();
    this.modulatorGain.gain.value = 1.0; // baseline: noise passes at unity

    this.noiseNode.connect(this.noiseGain);
    this.noiseGain.connect(this.modulatorGain);
    this.modulatorGain.connect(this.masterGain);
  }

  _initDSSS() {
    this.dsssNode = new AudioWorkletNode(this.ctx, 'dsss-processor');

    // Modulation depth: scales the DSSS signal before it hits the modulator gain param.
    // At depth=0 the noise is unmodulated. At depth=0.3 the noise gain oscillates ±30%.
    this.modulationDepth = this.ctx.createGain();
    this.modulationDepth.gain.value = 0.3;

    // DSSS → depth scaler → modulatorGain.gain (AudioParam)
    this.dsssNode.connect(this.modulationDepth);
    this.modulationDepth.connect(this.modulatorGain.gain);

    // Direct additive DSSS path (for engineering mode / debug). Off by default.
    this.directDsssGain = this.ctx.createGain();
    this.directDsssGain.gain.value = 0.0;
    this.dsssNode.connect(this.directDsssGain);
    this.directDsssGain.connect(this.masterGain);
  }

  setNoiseType(type) {
    if (this.noiseNode) {
      this.noiseNode.port.postMessage({ type });
    }
  }

  setNoiseGain(value) {
    if (this.noiseGain) this.noiseGain.gain.value = value;
  }

  // How deeply the DSSS code modulates the noise (0 = none, 1 = full ±100%)
  setModulationDepth(value) {
    if (this.modulationDepth) this.modulationDepth.gain.value = value;
  }

  // Direct additive DSSS gain (for engineering mode; 0 = off)
  setDirectDsssGain(value) {
    if (this.directDsssGain) this.directDsssGain.gain.value = value;
  }

  // Legacy name kept for compatibility — controls modulation depth
  setDSSSGain(value) {
    this.setModulationDepth(value);
  }

  setMasterGain(value) {
    if (this.masterGain) this.masterGain.gain.value = value;
  }

  sendSpreadingCode(code) {
    if (this.dsssNode) {
      this.dsssNode.port.postMessage({ spreadingCode: Array.from(code) });
    }
  }

  sendDataStream(data) {
    if (this.dsssNode) {
      this.dsssNode.port.postMessage({ dataStream: Array.from(data) });
    }
  }

  clearDSSS() {
    if (this.dsssNode) {
      this.dsssNode.port.postMessage({ spreadingCode: null, dataStream: null });
    }
  }

  setChipRate(rate) {
    if (this.dsssNode) {
      this.dsssNode.port.postMessage({ chipRate: rate });
    }
  }

  addOscillator(type = 'sine', frequency = 440, gain = 0.2) {
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gainNode.gain.value = gain;
    osc.connect(gainNode);
    gainNode.connect(this.masterGain);
    osc.start();
    const id = Date.now() + Math.random();
    this.oscillators.push({ id, osc, gain: gainNode, type, frequency });
    return id;
  }

  updateOscillator(id, { type, frequency, gain } = {}) {
    const entry = this.oscillators.find(o => o.id === id);
    if (!entry) return;
    if (type) entry.osc.type = type;
    if (frequency !== undefined) entry.osc.frequency.value = frequency;
    if (gain !== undefined) entry.gain.gain.value = gain;
  }

  removeOscillator(id) {
    const idx = this.oscillators.findIndex(o => o.id === id);
    if (idx === -1) return;
    const entry = this.oscillators[idx];
    entry.osc.stop();
    entry.osc.disconnect();
    entry.gain.disconnect();
    this.oscillators.splice(idx, 1);
  }

  // --- Clock signal: 7 sine oscillators encoding the timestamp ---
  // Each time component maps to a base frequency band. The frequency
  // continuously varies with the component's value and is cross-modulated
  // by neighboring components. The result is a continuously variable
  // continuous signal that encodes time at every scale.
  initClockOscillators(gain = 0.03) {
    if (this._clockOscs) return;
    this._clockOscs = [];
    this._clockGain = this.ctx.createGain();
    this._clockGain.gain.value = gain;
    this._clockGain.connect(this.masterGain);

    // Base frequencies chosen to be in different perceptual bands
    // and harmonically unrelated (prime-ratio-ish)
    const baseFreqs = [
      130,   // H  — low bass
      233,   // M  — mid-bass
      349,   // S  — mid
      523,   // ms — upper mid
      784,   // 10s — high mid
      1175,  // D  — presence
      1760,  // Y  — high
    ];

    for (let i = 0; i < 7; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = baseFreqs[i];
      const oscGain = this.ctx.createGain();
      oscGain.gain.value = 1.0 / 7;
      osc.connect(oscGain);
      oscGain.connect(this._clockGain);
      osc.start();
      this._clockOscs.push({ osc, gain: oscGain, baseFreq: baseFreqs[i] });
    }
  }

  updateClockFrequencies() {
    if (!this._clockOscs || !this.ctx) return;
    const now = Date.now();
    const d = new Date(now);
    const t = this.ctx.currentTime;

    const components = [
      d.getHours() / 24,
      d.getMinutes() / 60,
      d.getSeconds() / 60 + (now % 1000) / 60000, // smooth sub-second
      (now % 1000) / 1000,
      (now % 10000) / 10000,
      d.getDay() / 7,
      (d.getMonth() + d.getDate() / 31) / 12,
    ];

    for (let i = 0; i < this._clockOscs.length; i++) {
      const c = this._clockOscs[i];
      const val = components[i];
      const prevVal = components[(i + 6) % 7];
      const nextVal = components[(i + 1) % 7];

      // Cross-modulation: frequency shifts by neighbors
      const crossMod = 1 + (prevVal - 0.5) * 0.15 + (nextVal - 0.5) * 0.1;
      // Value maps to ±20% of base frequency
      const freq = c.baseFreq * crossMod * (0.8 + val * 0.4);

      c.osc.frequency.setTargetAtTime(freq, t, 0.05);
    }
  }

  setClockGain(value) {
    if (this._clockGain) this._clockGain.gain.value = value;
  }

  destroyClockOscillators() {
    if (!this._clockOscs) return;
    for (const c of this._clockOscs) {
      c.osc.stop();
      c.osc.disconnect();
      c.gain.disconnect();
    }
    this._clockOscs = null;
    if (this._clockGain) {
      this._clockGain.disconnect();
      this._clockGain = null;
    }
  }

  getTimeDomainData() {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this._timeDomainData);
    return this._timeDomainData;
  }

  getFrequencyData() {
    if (!this.analyser) return null;
    this.analyser.getFloatFrequencyData(this._frequencyData);
    return this._frequencyData;
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
    this.running = false;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    this.running = true;
  }

  destroy() {
    this.destroyClockOscillators();
    this.oscillators.forEach(o => { try { o.osc.stop(); o.osc.disconnect(); } catch(e) {} });
    this.oscillators = [];
    if (this.noiseNode) { this.noiseNode.disconnect(); this.noiseNode = null; }
    if (this.dsssNode) { this.dsssNode.disconnect(); this.dsssNode = null; }
    if (this.modulatorGain) { this.modulatorGain.disconnect(); this.modulatorGain = null; }
    if (this.directDsssGain) { this.directDsssGain.disconnect(); this.directDsssGain = null; }
    if (this.modulationDepth) { this.modulationDepth.disconnect(); this.modulationDepth = null; }
    if (this.noiseGain) { this.noiseGain.disconnect(); this.noiseGain = null; }
    if (this.masterGain) { this.masterGain.disconnect(); this.masterGain = null; }
    if (this.analyser) { this.analyser.disconnect(); this.analyser = null; }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.running = false;
  }
}
