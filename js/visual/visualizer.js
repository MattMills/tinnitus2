// Multi-layer entropic visualizer
//
// Each visual layer encodes the same spreading code / data stream in a
// different geometric representation.  Layers can be independently toggled,
// scaled, and opacity-controlled.  All layers read from the same code state
// and audio data, providing redundant cross-geometric encoding.

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._time = 0;
    this._codeState = null;
    this._coherence = 0;
    this._breathPhase = 0;
    this._w = 0;
    this._h = 0;

    // Global params
    this.breathRate = 0.15;
    this.colorMode = 'spectrum'; // warm, cool, spectrum

    // Layer definitions — each can be toggled, scaled, opacity-adjusted
    this.layers = {
      grid:        { enabled: true,  opacity: 0.6, scale: 1.0, gridSize: 16 },
      rings:       { enabled: true,  opacity: 0.5, scale: 1.0, ringCount: 5 },
      codeCircle:  { enabled: true,  opacity: 0.5, scale: 1.0 },
      waveformRing:{ enabled: true,  opacity: 0.5, scale: 1.0 },
      spirals:     { enabled: true,  opacity: 0.4, scale: 1.0, armCount: 3 },
      particles:   { enabled: false, opacity: 0.4, scale: 1.0, count: 128 },
      bars:        { enabled: false, opacity: 0.5, scale: 1.0 },
      lissajous:   { enabled: false, opacity: 0.5, scale: 1.0 },
    };

    this._particles = [];
    this._colorPhase = 0;
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

  resize() { this._resize(); }

  setCodeState(spreadingCode, dataStream, chipIndex) {
    this._codeState = { spreadingCode, dataStream, chipIndex };
  }

  setCoherence(v) { this._coherence = v; }

  setLayerEnabled(name, enabled) {
    if (this.layers[name]) this.layers[name].enabled = enabled;
  }

  setLayerOpacity(name, opacity) {
    if (this.layers[name]) this.layers[name].opacity = Math.max(0, Math.min(1, opacity));
  }

  setLayerScale(name, scale) {
    if (this.layers[name]) this.layers[name].scale = Math.max(0.1, Math.min(3, scale));
  }

  render(dt, audioTimeDomain, audioFrequency) {
    this._time += dt;
    this._breathPhase += dt * this.breathRate * Math.PI * 2;
    this._colorPhase += dt * 0.08;

    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;
    const breath = (Math.sin(this._breathPhase) + 1) / 2;

    // Background
    const bg = 2 + breath * 3;
    ctx.fillStyle = `rgb(${bg},${bg},${bg + 2})`;
    ctx.fillRect(0, 0, w, h);

    const code = this._codeState?.spreadingCode;
    const data = this._codeState?.dataStream;
    if (!code || code.length === 0) return;

    const chipPhase = this._time * 40; // base chip rate for visual sync

    // Draw enabled layers in order (back to front)
    if (this.layers.grid.enabled)
      this._drawGrid(ctx, w, h, code, data, chipPhase, breath);
    if (this.layers.bars.enabled)
      this._drawBars(ctx, w, h, code, data, chipPhase, audioFrequency);
    if (this.layers.spirals.enabled)
      this._drawSpirals(ctx, w, h, code, data, chipPhase, breath);
    if (this.layers.rings.enabled)
      this._drawRings(ctx, w, h, code, data, chipPhase, breath);
    if (this.layers.lissajous.enabled)
      this._drawLissajous(ctx, w, h, code, data, chipPhase);
    if (this.layers.particles.enabled)
      this._drawParticles(ctx, w, h, code, data, chipPhase, dt);
    if (this.layers.codeCircle.enabled)
      this._drawCodeCircle(ctx, w, h, code, data, chipPhase, breath);
    if (this.layers.waveformRing.enabled)
      this._drawWaveformRing(ctx, w, h, audioTimeDomain);

    // Coherence indicator
    this._drawCoherence(ctx, w, h);
  }

  // --- Layer: Entropy Grid ---
  _drawGrid(ctx, w, h, code, data, chipPhase, breath) {
    const L = this.layers.grid;
    const gs = L.gridSize;
    const s = L.scale;
    const gridW = w * s;
    const gridH = h * s;
    const ox = (w - gridW) / 2;
    const oy = (h - gridH) / 2;
    const cellW = gridW / gs;
    const cellH = gridH / gs;
    const offset = Math.floor(chipPhase) % code.length;

    ctx.globalAlpha = L.opacity;
    for (let gy = 0; gy < gs; gy++) {
      for (let gx = 0; gx < gs; gx++) {
        const idx = (gy * gs + gx + offset) % code.length;
        const chip = code[idx];
        const coarse = code[Math.floor((gy * gs + gx) / 4) % code.length];
        const hue = this._hue(gx, gy, chip, coarse);
        const light = 6 + chip * 18 + breath * 5;
        ctx.fillStyle = `hsl(${hue}, 70%, ${light}%)`;
        ctx.fillRect(ox + gx * cellW + 0.5, oy + gy * cellH + 0.5, cellW - 1, cellH - 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  // --- Layer: Concentric Rings (size/rotation encode code) ---
  _drawRings(ctx, w, h, code, data, chipPhase, breath) {
    const L = this.layers.rings;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.45 * L.scale;
    const n = L.ringCount;

    ctx.globalAlpha = L.opacity;
    for (let r = 0; r < n; r++) {
      const codeIdx = Math.floor(chipPhase + r * code.length / n) % code.length;
      const chip = code[codeIdx];
      const dataIdx = data ? (codeIdx % data.length) : 0;
      const dataBit = data ? data[dataIdx] : 0;
      const dsss = chip ^ dataBit;

      const radius = maxR * ((r + 1) / n) * (0.8 + dsss * 0.2 + breath * 0.05);
      const rotation = this._time * (0.2 + r * 0.15) * (chip ? 1 : -1);
      const segments = code.length;

      ctx.beginPath();
      for (let s = 0; s < segments; s++) {
        const sIdx = (s + Math.floor(chipPhase)) % code.length;
        const sChip = code[sIdx];
        const rMod = radius * (0.95 + sChip * 0.1);
        const angle = (s / segments) * Math.PI * 2 + rotation;
        const x = cx + Math.cos(angle) * rMod;
        const y = cy + Math.sin(angle) * rMod;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      const hue = (this._colorPhase * 360 + r * 60) % 360;
      ctx.strokeStyle = `hsl(${hue}, 60%, ${40 + dsss * 20}%)`;
      ctx.lineWidth = 1 + r * 0.3;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // --- Layer: Code Circle (original DSSS ring) ---
  _drawCodeCircle(ctx, w, h, code, data, chipPhase, breath) {
    const L = this.layers.codeCircle;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.35 * L.scale;
    const n = code.length;
    const angleStep = (Math.PI * 2) / n;
    const offset = Math.floor(chipPhase) % n;

    ctx.globalAlpha = L.opacity;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const idx = (i + offset) % n;
      const chip = code[idx];
      const dataBit = data ? data[Math.floor(i / n * data.length) % data.length] : 0;
      const dsss = chip ^ dataBit;
      const r = maxR * (0.3 + dsss * 0.15 + Math.sin(this._breathPhase + i * 0.1) * 0.05);
      const angle = i * angleStep - Math.PI / 2;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const hue = (this._colorPhase * 100) % 360;
    ctx.strokeStyle = `hsl(${hue}, 70%, 50%)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // --- Layer: Spirals (logarithmic, arm count and tightness encode code) ---
  _drawSpirals(ctx, w, h, code, data, chipPhase, breath) {
    const L = this.layers.spirals;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.42 * L.scale;

    ctx.globalAlpha = L.opacity;
    for (let arm = 0; arm < L.armCount; arm++) {
      const armOffset = (arm / L.armCount) * Math.PI * 2;
      const rotation = this._time * 0.3 * (arm % 2 === 0 ? 1 : -1);

      ctx.beginPath();
      const points = 200;
      for (let p = 0; p < points; p++) {
        const t = p / points;
        const codeIdx = Math.floor(chipPhase + p) % code.length;
        const chip = code[codeIdx];
        const rBase = maxR * t;
        const rMod = rBase * (0.9 + chip * 0.2 + breath * 0.05);
        const angle = t * Math.PI * 6 + armOffset + rotation;
        const x = cx + Math.cos(angle) * rMod;
        const y = cy + Math.sin(angle) * rMod;
        if (p === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      const hue = (this._colorPhase * 360 + arm * 120) % 360;
      ctx.strokeStyle = `hsl(${hue}, 50%, 45%)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // --- Layer: Waveform Ring ---
  _drawWaveformRing(ctx, w, h, audioTimeDomain) {
    if (!audioTimeDomain) return;
    const L = this.layers.waveformRing;
    const cx = w / 2;
    const cy = h / 2;
    const baseR = Math.min(w, h) * 0.22 * L.scale;

    ctx.globalAlpha = L.opacity;
    ctx.beginPath();
    const step = audioTimeDomain.length / 360;
    for (let deg = 0; deg < 360; deg++) {
      const val = audioTimeDomain[Math.floor(deg * step)] || 0;
      const r = baseR + val * baseR * 0.4;
      const angle = (deg * Math.PI) / 180 - Math.PI / 2;
      if (deg === 0) ctx.moveTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      else ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.strokeStyle = 'hsla(160, 80%, 60%, 0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // --- Layer: Particles (entropic Brownian motion) ---
  _drawParticles(ctx, w, h, code, data, chipPhase, dt) {
    const L = this.layers.particles;
    while (this._particles.length < L.count) {
      this._particles.push({
        x: Math.random() * w, y: Math.random() * h,
        vx: 0, vy: 0, codeIdx: Math.floor(Math.random() * code.length),
      });
    }
    this._particles.length = L.count;

    ctx.globalAlpha = L.opacity;
    for (const p of this._particles) {
      const chip = code[p.codeIdx % code.length];
      const force = (chip ? 1 : -1) * 50 * L.scale;
      p.vx += (force * (Math.random() - 0.5)) * dt;
      p.vy += (force * (Math.random() - 0.5)) * dt;
      p.vx *= 0.98;
      p.vy *= 0.98;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      p.x = Math.max(0, Math.min(w, p.x));
      p.y = Math.max(0, Math.min(h, p.y));
      p.codeIdx = (p.codeIdx + 1) % code.length;

      const hue = (this._colorPhase * 360 + p.codeIdx * 10) % 360;
      ctx.fillStyle = `hsl(${hue}, 60%, ${30 + chip * 30}%)`;
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  // --- Layer: Frequency Bars ---
  _drawBars(ctx, w, h, code, data, chipPhase, audioFrequency) {
    if (!audioFrequency) return;
    const L = this.layers.bars;
    const numBars = 64;
    const barW = (w * L.scale) / numBars;
    const ox = (w - w * L.scale) / 2;

    ctx.globalAlpha = L.opacity;
    for (let i = 0; i < numBars; i++) {
      const freqIdx = Math.floor(i / numBars * audioFrequency.length);
      const db = audioFrequency[freqIdx];
      const norm = Math.max(0, (db + 100) / 100);
      const codeIdx = (i + Math.floor(chipPhase)) % code.length;
      const chip = code[codeIdx];

      const barH = norm * h * 0.6;
      const hue = (this._colorPhase * 360 + i * 5 + chip * 40) % 360;
      ctx.fillStyle = `hsl(${hue}, 60%, ${20 + norm * 40}%)`;
      ctx.fillRect(ox + i * barW, h - barH, barW - 1, barH);
    }
    ctx.globalAlpha = 1;
  }

  // --- Layer: Lissajous Curves ---
  _drawLissajous(ctx, w, h, code, data, chipPhase) {
    const L = this.layers.lissajous;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.35 * L.scale;

    ctx.globalAlpha = L.opacity;
    const cIdx0 = Math.floor(chipPhase) % code.length;
    const cIdx1 = (cIdx0 + Math.floor(code.length / 3)) % code.length;
    const freqX = 2 + code[cIdx0] * 3;
    const freqY = 3 + code[cIdx1] * 2;
    const phase = this._time * 0.5;

    ctx.beginPath();
    for (let t = 0; t <= 360; t++) {
      const rad = (t * Math.PI) / 180;
      const x = cx + Math.sin(freqX * rad + phase) * maxR;
      const y = cy + Math.sin(freqY * rad) * maxR;
      if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    const hue = (this._colorPhase * 200) % 360;
    ctx.strokeStyle = `hsl(${hue}, 60%, 50%)`;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // --- Coherence indicator ---
  _drawCoherence(ctx, w, h) {
    const barW = w * 0.3;
    const x = (w - barW) / 2;
    const y = h - 16;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, y, barW, 2);
    const fillW = barW * Math.min(1, this._coherence);
    ctx.fillStyle = `hsl(${120 * this._coherence}, 80%, 50%)`;
    ctx.fillRect(x, y, fillW, 2);
  }

  _hue(gx, gy, chip, coarse) {
    const base = this._colorPhase * 360;
    const spatial = ((gx ^ gy) * 37 + gx * 7 + gy * 13) % 360;
    switch (this.colorMode) {
      case 'warm': return (base + spatial * 0.3 + chip * 40 + coarse * 20) % 60 + 340;
      case 'cool': return (base + spatial * 0.3 + chip * 40 + coarse * 20) % 80 + 180;
      default: return (base + spatial * 0.5 + chip * 60 + coarse * 30) % 360;
    }
  }
}
