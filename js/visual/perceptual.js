// Perceptual mode — full-screen immersive visual pattern synchronized with audio
// Designed for phone + earbuds: visual fills screen, audio carries same code structure
// Chip rates tuned for unconscious cross-modal integration (20-100 Hz, 1-5s windows)

export class PerceptualRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._time = 0;
    this._codeState = null;
    this._patternPhase = 0;
    this._colorPhase = 0;
    this._breathPhase = 0;
    this._history = [];
    this._maxHistory = 120;
    this._coherenceScore = 0;

    // Perceptual parameters
    this.chipRate = 40;        // Hz — sweet spot for unconscious binding
    this.correlationWindow = 2; // seconds
    this.patternScale = 1.0;
    this.colorMode = 'warm';   // warm, cool, spectrum
    this.intensity = 0.8;
    this.breathRate = 0.15;    // Hz — slow breath-like modulation
    this.gridSize = 16;        // pattern grid resolution
    this._resize();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = rect.width;
    this._h = rect.height;
  }

  resize() {
    this._resize();
  }

  // Update with current spreading code state from audio engine
  setCodeState(spreadingCode, dataStream, chipIndex) {
    this._codeState = { spreadingCode, dataStream, chipIndex };
  }

  // Set coherence feedback (0-1, from correlation engine)
  setCoherence(score) {
    this._coherenceScore = score;
  }

  // Main render frame — call at requestAnimationFrame rate
  render(dt, audioTimeDomain, audioFrequency) {
    this._time += dt;
    this._patternPhase += dt * this.chipRate;
    this._breathPhase += dt * this.breathRate * Math.PI * 2;
    this._colorPhase += dt * 0.1;

    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;

    // Background with breath modulation
    const breathAmp = (Math.sin(this._breathPhase) + 1) / 2;
    const bgBright = 2 + breathAmp * 4;
    ctx.fillStyle = `rgb(${bgBright}, ${bgBright}, ${bgBright + 2})`;
    ctx.fillRect(0, 0, w, h);

    // Draw the pattern layers
    this._drawEntropyField(ctx, w, h, breathAmp);
    this._drawCodePattern(ctx, w, h);
    this._drawWaveformRing(ctx, w, h, audioTimeDomain);
    this._drawCoherenceIndicator(ctx, w, h);
  }

  _drawEntropyField(ctx, w, h, breathAmp) {
    if (!this._codeState || !this._codeState.spreadingCode) return;

    const code = this._codeState.spreadingCode;
    const gs = this.gridSize;
    const cellW = w / gs;
    const cellH = h / gs;

    // Map spreading code to 2D pattern using time-evolving Hilbert-like mapping
    const chipOffset = Math.floor(this._patternPhase) % (code.length || 1);

    for (let gy = 0; gy < gs; gy++) {
      for (let gx = 0; gx < gs; gx++) {
        const cellIdx = gy * gs + gx;
        const codeIdx = (cellIdx + chipOffset) % code.length;
        const chipVal = code[codeIdx];

        // Multi-scale color derivation
        const coarseIdx = Math.floor(cellIdx / 4) % code.length;
        const coarseVal = code[coarseIdx];

        // Time-varying color based on chip value + fractal position
        const hue = this._cellHue(gx, gy, chipVal, coarseVal);
        const sat = 60 + chipVal * 30 + breathAmp * 10;
        const light = 8 + (chipVal ? 1 : 0) * this.intensity * 20 +
                      breathAmp * 5 * this.intensity;

        // Smooth transitions via alpha
        const alpha = 0.3 + this.intensity * 0.5;

        ctx.fillStyle = `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
        ctx.fillRect(
          gx * cellW + 0.5,
          gy * cellH + 0.5,
          cellW - 1,
          cellH - 1
        );
      }
    }
  }

  _cellHue(gx, gy, chipVal, coarseVal) {
    const base = this._colorPhase * 360;
    const spatialHue = ((gx ^ gy) * 37 + gx * 7 + gy * 13) % 360;

    switch (this.colorMode) {
      case 'warm':
        return (base + spatialHue * 0.3 + chipVal * 40 + coarseVal * 20) % 60 + 340;
      case 'cool':
        return (base + spatialHue * 0.3 + chipVal * 40 + coarseVal * 20) % 80 + 180;
      case 'spectrum':
      default:
        return (base + spatialHue * 0.5 + chipVal * 60 + coarseVal * 30) % 360;
    }
  }

  _drawCodePattern(ctx, w, h) {
    if (!this._codeState || !this._codeState.dataStream) return;

    const data = this._codeState.dataStream;
    const code = this._codeState.spreadingCode;
    if (!data || !code || data.length === 0) return;

    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.4;

    // Draw a circular code visualization
    const numPoints = code.length;
    const angleStep = (Math.PI * 2) / numPoints;
    const chipOffset = Math.floor(this._patternPhase) % numPoints;

    ctx.beginPath();
    for (let i = 0; i < numPoints; i++) {
      const idx = (i + chipOffset) % numPoints;
      const chip = code[idx];
      const dataIdx = Math.floor(i / numPoints * data.length) % data.length;
      const dataBit = data[dataIdx];

      // Radius modulated by XOR of chip and data (the DSSS signal)
      const dsss = chip ^ dataBit;
      const r = maxR * (0.3 + dsss * 0.15 + Math.sin(this._breathPhase + i * 0.1) * 0.05);

      const angle = i * angleStep - Math.PI / 2;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const hue = (this._colorPhase * 100) % 360;
    ctx.strokeStyle = `hsla(${hue}, 70%, 50%, 0.4)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _drawWaveformRing(ctx, w, h, audioTimeDomain) {
    if (!audioTimeDomain) return;

    const cx = w / 2;
    const cy = h / 2;
    const baseR = Math.min(w, h) * 0.25;

    ctx.beginPath();
    const step = audioTimeDomain.length / 360;

    for (let deg = 0; deg < 360; deg++) {
      const idx = Math.floor(deg * step);
      const val = audioTimeDomain[idx] || 0;
      const r = baseR + val * baseR * 0.3;
      const angle = (deg * Math.PI) / 180 - Math.PI / 2;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      if (deg === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    ctx.strokeStyle = `hsla(160, 80%, 60%, 0.6)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _drawCoherenceIndicator(ctx, w, h) {
    // Small indicator at bottom showing cross-modal coherence
    const barW = w * 0.3;
    const barH = 3;
    const x = (w - barW) / 2;
    const y = h - 20;

    // Background
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x, y, barW, barH);

    // Fill based on coherence
    const fillW = barW * Math.min(1, this._coherenceScore);
    const hue = 120 * this._coherenceScore; // red → green
    ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
    ctx.fillRect(x, y, fillW, barH);
  }
}

// Audio tuner for perceptual mode — generates audio matched to visual pattern
// The DSSS code modulates the noise (amplitude modulation) so the code
// IS the noise structure.  No separate chirp — the spreading code shapes
// the noise envelope at the chip rate.
export class PerceptualAudioTuner {
  constructor(audioEngine) {
    this.engine = audioEngine;
    this._noiseGain = 0.25;
    this._toneGain = 0.06;
    this._modulationDepth = 0.3;  // how deeply the code shapes the noise
    this._baseFreq = 200;
  }

  activate() {
    this.engine.setNoiseType(1); // pink noise
    this.engine.setNoiseGain(this._noiseGain);
    this.engine.setModulationDepth(this._modulationDepth);
    this.engine.setDirectDsssGain(0.0); // no additive chirp — code lives inside the noise
    this.engine.setMasterGain(0.6);

    this._toneId = this.engine.addOscillator('sine', this._baseFreq, this._toneGain);
  }

  deactivate() {
    if (this._toneId !== undefined) {
      this.engine.removeOscillator(this._toneId);
      this._toneId = undefined;
    }
    // Clear the DSSS data so the worklet stops producing signal
    this.engine.clearDSSS();
    this.engine.setModulationDepth(0);
    this.engine.setDirectDsssGain(0);
  }

  setNoiseGain(v) {
    this._noiseGain = v;
    this.engine.setNoiseGain(v);
  }

  setToneGain(v) {
    this._toneGain = v;
    if (this._toneId !== undefined) {
      this.engine.updateOscillator(this._toneId, { gain: v });
    }
  }

  setModulationDepth(v) {
    this._modulationDepth = v;
    this.engine.setModulationDepth(v);
  }

  setBaseFreq(f) {
    this._baseFreq = f;
    if (this._toneId !== undefined) {
      this.engine.updateOscillator(this._toneId, { frequency: f });
    }
  }
}
