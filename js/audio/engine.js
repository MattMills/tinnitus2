// Audio engine — manages Web Audio context, noise generators, tone oscillators, and DSSS modulator

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.noiseNode = null;
    this.noiseGain = null;
    this.dsssNode = null;
    this.dsssGain = null;
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
    this.noiseNode.connect(this.noiseGain);
    this.noiseGain.connect(this.masterGain);
  }

  _initDSSS() {
    this.dsssNode = new AudioWorkletNode(this.ctx, 'dsss-processor');
    this.dsssGain = this.ctx.createGain();
    this.dsssGain.gain.value = 0.2;
    this.dsssNode.connect(this.dsssGain);
    this.dsssGain.connect(this.masterGain);
  }

  setNoiseType(type) {
    // 0=white, 1=pink, 2=brown
    if (this.noiseNode) {
      this.noiseNode.port.postMessage({ type });
    }
  }

  setNoiseGain(value) {
    if (this.noiseGain) this.noiseGain.gain.value = value;
  }

  setDSSSGain(value) {
    if (this.dsssGain) this.dsssGain.gain.value = value;
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
    this.oscillators.forEach(o => { o.osc.stop(); o.osc.disconnect(); });
    this.oscillators = [];
    if (this.noiseNode) this.noiseNode.disconnect();
    if (this.dsssNode) this.dsssNode.disconnect();
    if (this.ctx) this.ctx.close();
    this.running = false;
  }
}
