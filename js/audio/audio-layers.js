// Multi-Layer Audio Synthesis Engine
//
// Mirrors the visual layer system — each audio layer encodes the identity
// signal through a different acoustic dimension.  All layers independently
// toggleable with per-layer gain.
//
// Layers:
//   1. noiseStack    — white + pink + brown simultaneously, each with its own
//                      Gold code offset and modulation depth
//   2. hoppingTones  — N oscillators frequency-hopping on PRNG schedule
//   3. harmonicComb  — fundamental + overtones, amplitudes modulated by code chips
//   4. binaural      — left/right ears get different code phase offsets
//   5. spectralBands — noise split into frequency bands, each carries a fractal level
//   6. morseBeacon   — identity phrase in morse code, slow repeating, in the clear
//   7. trainingRamp  — alternates between clear and buried signal for perceptual learning

export class AudioLayerEngine {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.masterGain = null;
    this.analyser = null;

    this.layers = {
      noiseStack:    { enabled: true,  gain: 0.15, label: 'Noise Stack' },
      hoppingTones:  { enabled: true,  gain: 0.06, label: 'Freq Hopping' },
      harmonicComb:  { enabled: true,  gain: 0.05, label: 'Harmonic Comb' },
      binaural:      { enabled: true,  gain: 0.10, label: 'Binaural Split' },
      spectralBands: { enabled: false, gain: 0.08, label: 'Spectral Bands' },
      morseBeacon:   { enabled: true,  gain: 0.04, label: 'Morse Beacon' },
      trainingRamp:  { enabled: false, gain: 0.10, label: 'Training Ramp' },
    };

    this._nodes = {};
    this._code = null;
    this._data = null;
    this._phrase = '';
    this._hopRng = null;
    this._hopTimer = 0;
    this._morsePos = 0;
    this._morseTimer = 0;
    this._trainingPhase = 0;
    this._time = 0;
    this._updateInterval = null;
  }

  init(masterGain, analyser) {
    this.masterGain = masterGain;
    this.analyser = analyser;
    this._buildNoiseStack();
    this._buildHoppingTones();
    this._buildHarmonicComb();
    this._buildBinaural();
    this._buildSpectralBands();
    this._buildMorseBeacon();
    this._buildTrainingRamp();

    // Periodic update for time-varying layers (hop, morse, training)
    this._updateInterval = setInterval(() => this._tick(), 50);
  }

  setCodeState(code, data) {
    this._code = code;
    this._data = data;
  }

  setPhrase(phrase) {
    this._phrase = phrase;
    this._morseSequence = this._textToMorse(phrase);
    this._morsePos = 0;
  }

  setLayerEnabled(name, enabled) {
    if (!this.layers[name]) return;
    this.layers[name].enabled = enabled;
    this._applyLayerGain(name);
  }

  setLayerGain(name, gain) {
    if (!this.layers[name]) return;
    this.layers[name].gain = gain;
    this._applyLayerGain(name);
  }

  _applyLayerGain(name) {
    const node = this._nodes[name]?.gainNode;
    if (node) {
      node.gain.value = this.layers[name].enabled ? this.layers[name].gain : 0;
    }
  }

  // =========================================================
  // Layer 1: Noise Stack (white + pink + brown, each code-modulated)
  // =========================================================
  _buildNoiseStack() {
    const group = this.ctx.createGain();
    group.gain.value = this.layers.noiseStack.gain;
    group.connect(this.masterGain);

    // We reuse the existing noise worklet but create 3 instances
    const noiseTypes = [0, 1, 2]; // white, pink, brown
    const noises = [];

    for (let i = 0; i < 3; i++) {
      const noise = new AudioWorkletNode(this.ctx, 'noise-processor');
      noise.port.postMessage({ type: noiseTypes[i] });
      const noiseGain = this.ctx.createGain();
      noiseGain.gain.value = [0.12, 0.15, 0.10][i];

      // Each noise type gets its own modulator driven by a different code phase
      const modulator = this.ctx.createGain();
      modulator.gain.value = 1.0;

      noise.connect(noiseGain);
      noiseGain.connect(modulator);
      modulator.connect(group);
      noises.push({ noise, noiseGain, modulator, codeOffset: i * 7 });
    }

    this._nodes.noiseStack = { gainNode: group, noises };
  }

  // =========================================================
  // Layer 2: Frequency Hopping Tones
  // =========================================================
  _buildHoppingTones() {
    const group = this.ctx.createGain();
    group.gain.value = this.layers.hoppingTones.gain;
    group.connect(this.masterGain);

    const numTones = 4;
    const tones = [];
    const baseFreqs = [200, 350, 550, 800];

    for (let i = 0; i < numTones; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = ['sine', 'triangle', 'sine', 'triangle'][i];
      osc.frequency.value = baseFreqs[i];
      const toneGain = this.ctx.createGain();
      toneGain.gain.value = 0.15;
      osc.connect(toneGain);
      toneGain.connect(group);
      osc.start();
      tones.push({ osc, gain: toneGain, baseFreq: baseFreqs[i], currentFreq: baseFreqs[i] });
    }

    this._nodes.hoppingTones = { gainNode: group, tones };
    this._hopTimer = 0;
  }

  // =========================================================
  // Layer 3: Harmonic Comb (fundamental + overtones code-modulated)
  // =========================================================
  _buildHarmonicComb() {
    const group = this.ctx.createGain();
    group.gain.value = this.layers.harmonicComb.gain;
    group.connect(this.masterGain);

    const fundamental = 110;
    const numHarmonics = 8;
    const harmonics = [];

    for (let h = 1; h <= numHarmonics; h++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = fundamental * h;
      const hGain = this.ctx.createGain();
      hGain.gain.value = 0.1 / h; // natural rolloff
      osc.connect(hGain);
      hGain.connect(group);
      osc.start();
      harmonics.push({ osc, gain: hGain, harmonic: h });
    }

    this._nodes.harmonicComb = { gainNode: group, harmonics, fundamental };
  }

  // =========================================================
  // Layer 4: Binaural Split (L/R get different code phases)
  // =========================================================
  _buildBinaural() {
    const group = this.ctx.createGain();
    group.gain.value = this.layers.binaural.gain;

    // Create stereo splitter
    const merger = this.ctx.createChannelMerger(2);
    merger.connect(group);
    group.connect(this.masterGain);

    // Left channel: noise with code phase 0
    const leftNoise = new AudioWorkletNode(this.ctx, 'noise-processor');
    leftNoise.port.postMessage({ type: 1 }); // pink
    const leftGain = this.ctx.createGain();
    leftGain.gain.value = 0.15;
    leftNoise.connect(leftGain);
    leftGain.connect(merger, 0, 0);

    // Right channel: noise with code phase offset
    const rightNoise = new AudioWorkletNode(this.ctx, 'noise-processor');
    rightNoise.port.postMessage({ type: 1 }); // pink
    const rightGain = this.ctx.createGain();
    rightGain.gain.value = 0.15;
    rightNoise.connect(rightGain);
    rightGain.connect(merger, 0, 1);

    // Modulators for each ear
    const leftMod = this.ctx.createGain();
    leftMod.gain.value = 1.0;
    const rightMod = this.ctx.createGain();
    rightMod.gain.value = 1.0;

    this._nodes.binaural = {
      gainNode: group, merger,
      left: { noise: leftNoise, gain: leftGain, mod: leftMod },
      right: { noise: rightNoise, gain: rightGain, mod: rightMod },
    };
  }

  // =========================================================
  // Layer 5: Spectral Bands (bandpassed noise, each band = fractal level)
  // =========================================================
  _buildSpectralBands() {
    const group = this.ctx.createGain();
    group.gain.value = this.layers.spectralBands.enabled ? this.layers.spectralBands.gain : 0;
    group.connect(this.masterGain);

    const noise = new AudioWorkletNode(this.ctx, 'noise-processor');
    noise.port.postMessage({ type: 0 }); // white (flat spectrum for even band energy)

    const bands = [
      { lo: 80, hi: 300, label: 'sub-bass' },
      { lo: 300, hi: 1000, label: 'low-mid' },
      { lo: 1000, hi: 4000, label: 'mid' },
      { lo: 4000, hi: 12000, label: 'presence' },
    ];

    const bandNodes = bands.map((b, i) => {
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = Math.sqrt(b.lo * b.hi);
      bp.Q.value = bp.frequency.value / (b.hi - b.lo);

      const bandGain = this.ctx.createGain();
      bandGain.gain.value = 0.15;

      noise.connect(bp);
      bp.connect(bandGain);
      bandGain.connect(group);

      return { filter: bp, gain: bandGain, fractalLevel: i };
    });

    this._nodes.spectralBands = { gainNode: group, noise, bands: bandNodes };
  }

  // =========================================================
  // Layer 6: Morse Beacon (identity phrase in morse, in the clear)
  // =========================================================
  _buildMorseBeacon() {
    const group = this.ctx.createGain();
    group.gain.value = this.layers.morseBeacon.gain;
    group.connect(this.masterGain);

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 660;
    const oscGain = this.ctx.createGain();
    oscGain.gain.value = 0; // keyed on/off by morse
    osc.connect(oscGain);
    oscGain.connect(group);
    osc.start();

    this._morseSequence = [];
    this._nodes.morseBeacon = { gainNode: group, osc, oscGain };
  }

  // =========================================================
  // Layer 7: Training Ramp (alternates clear ↔ buried for learning)
  // =========================================================
  _buildTrainingRamp() {
    const group = this.ctx.createGain();
    group.gain.value = this.layers.trainingRamp.enabled ? this.layers.trainingRamp.gain : 0;
    group.connect(this.masterGain);

    // A DSSS modulated tone that cycles between loud (clear) and quiet (buried)
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 440;
    const oscGain = this.ctx.createGain();
    oscGain.gain.value = 0.2;
    osc.connect(oscGain);
    oscGain.connect(group);
    osc.start();

    // Background noise for burying
    const noise = new AudioWorkletNode(this.ctx, 'noise-processor');
    noise.port.postMessage({ type: 1 });
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.1;
    noise.connect(noiseGain);
    noiseGain.connect(group);

    this._nodes.trainingRamp = { gainNode: group, osc, oscGain, noise, noiseGain };
    this._trainingPhase = 0;
  }

  // =========================================================
  // Periodic tick — drives time-varying layers
  // =========================================================
  _tick() {
    this._time += 0.05;
    const code = this._code;
    if (!code || code.length === 0) return;

    // --- Frequency Hopping ---
    if (this.layers.hoppingTones.enabled) {
      this._hopTimer += 0.05;
      const hopInterval = 0.5; // seconds between hops
      if (this._hopTimer >= hopInterval) {
        this._hopTimer = 0;
        const tones = this._nodes.hoppingTones?.tones;
        if (tones) {
          for (let i = 0; i < tones.length; i++) {
            const chipIdx = (Math.floor(this._time * 10) + i * 5) % code.length;
            const chip = code[chipIdx];
            // Hop: base frequency * (1 + code-derived offset)
            const hopMultiplier = 1 + (chip ? 0.25 : -0.15) +
              (code[(chipIdx + 3) % code.length] ? 0.1 : 0);
            const newFreq = tones[i].baseFreq * hopMultiplier;
            tones[i].osc.frequency.setTargetAtTime(newFreq, this.ctx.currentTime, 0.05);
            tones[i].currentFreq = newFreq;
          }
        }
      }
    }

    // --- Harmonic Comb modulation ---
    if (this.layers.harmonicComb.enabled) {
      const harmonics = this._nodes.harmonicComb?.harmonics;
      if (harmonics) {
        for (let h = 0; h < harmonics.length; h++) {
          const chipIdx = (Math.floor(this._time * 20) + h * 4) % code.length;
          const chip = code[chipIdx];
          const targetGain = chip ? (0.15 / (h + 1)) : (0.03 / (h + 1));
          harmonics[h].gain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.02);
        }
      }
    }

    // --- Spectral Band modulation ---
    if (this.layers.spectralBands.enabled) {
      const bands = this._nodes.spectralBands?.bands;
      if (bands) {
        for (let b = 0; b < bands.length; b++) {
          const chipIdx = (Math.floor(this._time * 15) + b * 8) % code.length;
          const chip = code[chipIdx];
          const targetGain = chip ? 0.2 : 0.05;
          bands[b].gain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.03);
        }
      }
    }

    // --- Morse Beacon ---
    if (this.layers.morseBeacon.enabled && this._morseSequence.length > 0) {
      this._morseTimer += 0.05;
      const dotLen = 0.12; // seconds per dot
      if (this._morseTimer >= dotLen) {
        this._morseTimer = 0;
        const sym = this._morseSequence[this._morsePos % this._morseSequence.length];
        const oscGain = this._nodes.morseBeacon?.oscGain;
        if (oscGain) {
          // 1 = tone on, 0 = silence
          oscGain.gain.setTargetAtTime(sym ? 0.15 : 0, this.ctx.currentTime, 0.005);
        }
        this._morsePos++;
        if (this._morsePos >= this._morseSequence.length) {
          this._morsePos = 0;
        }
      }
    }

    // --- Training Ramp ---
    if (this.layers.trainingRamp.enabled) {
      this._trainingPhase += 0.05;
      const cyclePeriod = 8; // seconds: 4s clear, 4s buried
      const phase = (this._trainingPhase % cyclePeriod) / cyclePeriod;
      const nodes = this._nodes.trainingRamp;
      if (nodes) {
        if (phase < 0.5) {
          // Clear phase: tone loud, noise quiet
          const clarity = Math.sin(phase * Math.PI) * 2; // smooth ramp
          nodes.oscGain.gain.setTargetAtTime(0.15 * Math.min(1, clarity), this.ctx.currentTime, 0.05);
          nodes.noiseGain.gain.setTargetAtTime(0.03, this.ctx.currentTime, 0.05);
        } else {
          // Buried phase: tone quiet, noise loud
          const burial = Math.sin((phase - 0.5) * Math.PI) * 2;
          nodes.oscGain.gain.setTargetAtTime(0.03, this.ctx.currentTime, 0.05);
          nodes.noiseGain.gain.setTargetAtTime(0.15 * Math.min(1, burial), this.ctx.currentTime, 0.05);
        }
        // FM modulation of tone by code
        const chipIdx = Math.floor(this._time * 30) % code.length;
        const chip = code[chipIdx];
        const freq = 440 * (chip ? 1.02 : 0.98);
        nodes.osc.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.01);
      }
    }
  }

  // =========================================================
  // Morse encoding
  // =========================================================
  _textToMorse(text) {
    const MORSE = {
      'A':'.-','B':'-...','C':'-.-.','D':'-..','E':'.','F':'..-.','G':'--.','H':'....',
      'I':'..','J':'.---','K':'-.-','L':'.-..','M':'--','N':'-.','O':'---','P':'.--.',
      'Q':'--.-','R':'.-.','S':'...','T':'-','U':'..-','V':'...-','W':'.--','X':'-..-',
      'Y':'-.--','Z':'--..','0':'-----','1':'.----','2':'..---','3':'...--','4':'....-',
      '5':'.....','6':'-....','7':'--...','8':'---..','9':'----.',
      ' ':'/','.':'.-.-.-',',':'--..--',
    };
    const seq = [];
    for (const ch of text.toUpperCase()) {
      const morse = MORSE[ch];
      if (!morse) { seq.push(0, 0, 0, 0); continue; } // unknown = pause
      for (let i = 0; i < morse.length; i++) {
        if (morse[i] === '.') { seq.push(1); }
        else if (morse[i] === '-') { seq.push(1, 1, 1); }
        else if (morse[i] === '/') { seq.push(0, 0, 0, 0, 0, 0, 0); }
        if (i < morse.length - 1) seq.push(0); // intra-char gap
      }
      seq.push(0, 0, 0); // inter-char gap
    }
    seq.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0); // end-of-message pause
    return seq;
  }

  // =========================================================
  // Cleanup
  // =========================================================
  destroy() {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
      this._updateInterval = null;
    }
    // Stop all oscillators
    const stopOsc = (node) => { try { node.stop(); node.disconnect(); } catch(e) {} };
    this._nodes.hoppingTones?.tones?.forEach(t => stopOsc(t.osc));
    this._nodes.harmonicComb?.harmonics?.forEach(h => stopOsc(h.osc));
    if (this._nodes.morseBeacon?.osc) stopOsc(this._nodes.morseBeacon.osc);
    if (this._nodes.trainingRamp?.osc) stopOsc(this._nodes.trainingRamp.osc);
    // Disconnect all gain nodes
    for (const layer of Object.values(this._nodes)) {
      try { layer.gainNode?.disconnect(); } catch(e) {}
    }
    this._nodes = {};
  }
}
