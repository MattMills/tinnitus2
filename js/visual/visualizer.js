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
      textStream:  { enabled: true,  opacity: 0.7, scale: 1.0 },
      highDim:     { enabled: true,  opacity: 0.8, scale: 1.0 },
      colorRef:    { enabled: true,  opacity: 0.9, scale: 1.0 },
    };

    // Color reference state — triangular relationship rotating through full gamut
    this._colorTriAngle = 0;   // base hue of the triangle
    this._colorTriSat = 70;
    this._colorTriLight = 40;
    this._colorTriPhase = 0;   // drives saturation/lightness oscillation into brown range

    // Text stream content — the topmost layer, announcing what this is
    this._textLines = [];
    this._textScroll = 0;

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

  // Set the text content for the text stream overlay
  // lines: array of strings to display, continuously scrolling
  setTextStream(lines) {
    this._textLines = lines;
  }

  render(dt, audioTimeDomain, audioFrequency) {
    this._time += dt;
    this._breathPhase += dt * this.breathRate * Math.PI * 2;
    this._colorPhase += dt * 0.08;

    // Evolve color reference triangle — slow rotation through full hue + brown range
    this._colorTriAngle += dt * 12; // 30 seconds per full hue rotation
    this._colorTriPhase += dt * 0.4;
    // Oscillate saturation and lightness to reach browns (low sat, low-mid light)
    // and pure spectral colors (high sat) and pastels (high light)
    this._colorTriSat = 45 + Math.sin(this._colorTriPhase * 0.7) * 35 +
                         Math.sin(this._colorTriPhase * 1.3) * 15;
    this._colorTriLight = 30 + Math.sin(this._colorTriPhase * 0.5) * 20 +
                           Math.sin(this._colorTriPhase * 1.7) * 10;

    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;
    const breath = (Math.sin(this._breathPhase) + 1) / 2;

    // Background (skip if high-dim renderer already drew)
    if (!this.skipBackground) {
      const bg = 2 + breath * 3;
      ctx.fillStyle = `rgb(${bg},${bg},${bg + 2})`;
      ctx.fillRect(0, 0, w, h);
    }
    this.skipBackground = false;

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
    if (this.layers.colorRef.enabled)
      this._drawColorRef(ctx, w, h, code, chipPhase, breath);
    if (this.layers.textStream.enabled)
      this._drawTextStream(ctx, w, h, code, chipPhase);

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

    // Color triangle vertices — 3 hues always 120° apart
    const triH0 = this._colorTriAngle % 360;
    const triH1 = (triH0 + 120) % 360;
    const triH2 = (triH0 + 240) % 360;
    const triS = this._colorTriSat;
    const triL = this._colorTriLight;

    ctx.globalAlpha = L.opacity;
    for (let gy = 0; gy < gs; gy++) {
      for (let gx = 0; gx < gs; gx++) {
        const idx = (gy * gs + gx + offset) % code.length;
        const chip = code[idx];
        const coarse = code[Math.floor((gy * gs + gx) / 4) % code.length];

        // Determine if this cell is a coherence reference cell
        // Reference cells form a regular pattern: every 4th cell in a staggered grid
        const isRef = ((gx + gy * 2) % 5 === 0);

        let hue, sat, light;
        if (isRef) {
          // Coherent: pick one of the three triangle vertices based on position
          const triVertex = (gx + gy) % 3;
          hue = [triH0, triH1, triH2][triVertex];
          sat = triS;
          light = triL + chip * 10 + breath * 3;
        } else {
          // Incoherent: entropic color from the code
          hue = this._hue(gx, gy, chip, coarse);
          sat = 70;
          light = 6 + chip * 18 + breath * 5;
        }

        ctx.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
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

  // --- Layer: Color Reference (coherence/incoherence standard) ---
  // Three corner swatches maintain a triangular color relationship (always 120°
  // apart in hue) while slowly rotating through the full gamut.  Saturation and
  // lightness oscillate to reach every perceivable color including browns, olives,
  // maroons — colors that require specific sat/light combinations not reachable
  // by hue alone.
  //
  // The triangle provides a coherence standard: the viewer's color perception
  // system can anchor to the known 120° relationship.  Grid cells that match the
  // triangle are "coherent."  Grid cells with entropic colors are "incoherent."
  // The contrast between them engages color constancy mechanisms.
  _drawColorRef(ctx, w, h, code, chipPhase, breath) {
    const L = this.layers.colorRef;
    const size = Math.min(w, h) * 0.06 * L.scale;
    const margin = size * 0.6;

    const triH0 = this._colorTriAngle % 360;
    const triH1 = (triH0 + 120) % 360;
    const triH2 = (triH0 + 240) % 360;
    const s = this._colorTriSat;
    const l = this._colorTriLight;

    ctx.globalAlpha = L.opacity;

    // Three swatches in top-left, top-right, bottom-center
    const positions = [
      [margin, margin],
      [w - margin - size, margin],
      [(w - size) / 2, h - margin - size],
    ];
    const hues = [triH0, triH1, triH2];

    for (let i = 0; i < 3; i++) {
      const [px, py] = positions[i];
      const hue = hues[i];

      // Main swatch
      ctx.fillStyle = `hsl(${hue}, ${s}%, ${l}%)`;
      ctx.fillRect(px, py, size, size);

      // Thin border showing the pure hue at full saturation for comparison
      ctx.strokeStyle = `hsl(${hue}, 100%, 50%)`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px, py, size, size);

      // Small label
      ctx.fillStyle = `hsla(0, 0%, ${l > 50 ? 0 : 100}%, 0.6)`;
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(hue)}°`, px + size / 2, py + size / 2 + 3);
    }

    // Draw thin lines connecting the three swatches (the triangle)
    ctx.beginPath();
    ctx.moveTo(positions[0][0] + size / 2, positions[0][1] + size / 2);
    ctx.lineTo(positions[1][0] + size / 2, positions[1][1] + size / 2);
    ctx.lineTo(positions[2][0] + size / 2, positions[2][1] + size / 2);
    ctx.closePath();
    ctx.strokeStyle = `hsla(${triH0}, ${s}%, ${l + 20}%, 0.2)`;
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Incoherence indicator: a small swatch showing the "opposite" of coherence —
    // a color derived from the code that breaks the triangle relationship
    const cIdx = Math.floor(chipPhase) % (code?.length || 1);
    const chip = code ? code[cIdx] : 0;
    const incoherentHue = (triH0 + 60 + chip * 30) % 360; // deliberately NOT on the triangle
    const incoherentS = 90 - s;  // inverted saturation
    const incoherentL = 80 - l;  // inverted lightness
    const incSize = size * 0.6;
    const incX = (w - incSize) / 2;
    const incY = margin;
    ctx.fillStyle = `hsl(${incoherentHue}, ${Math.abs(incoherentS)}%, ${Math.max(5, Math.abs(incoherentL))}%)`;
    ctx.fillRect(incX, incY, incSize, incSize);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(incX, incY, incSize, incSize);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '7px monospace';
    ctx.fillText('inc', incX + incSize / 2, incY + incSize / 2 + 2);

    ctx.globalAlpha = 1;
  }

  // --- Layer: Text Stream (topmost — announces what this is) ---
  _drawTextStream(ctx, w, h, code, chipPhase) {
    if (this._textLines.length === 0) return;
    const L = this.layers.textStream;
    const fontSize = Math.max(10, Math.min(14, h * 0.018)) * L.scale;
    const lineHeight = fontSize * 1.6;
    const totalHeight = this._textLines.length * lineHeight;

    // Slow continuous scroll
    this._textScroll += 0.3;
    if (this._textScroll > totalHeight + h) this._textScroll = 0;

    ctx.globalAlpha = L.opacity;
    ctx.font = `${fontSize}px 'SF Mono','Fira Code','Cascadia Code',monospace`;
    ctx.textAlign = 'center';

    for (let i = 0; i < this._textLines.length; i++) {
      const baseY = h + (i * lineHeight) - this._textScroll;
      if (baseY < -lineHeight || baseY > h + lineHeight) continue;

      const line = this._textLines[i];
      // Each character gets a code-modulated color
      const chars = Array.from(line);
      const totalW = ctx.measureText(line).width;
      let x = (w - totalW) / 2;

      for (let c = 0; c < chars.length; c++) {
        const codeIdx = (Math.floor(chipPhase) + i * 7 + c) % (code?.length || 1);
        const chip = code ? code[codeIdx] : 0;
        const hue = (this._colorPhase * 360 + c * 3 + chip * 60) % 360;
        const light = 35 + chip * 25;
        ctx.fillStyle = `hsl(${hue}, 50%, ${light}%)`;
        ctx.textAlign = 'left';
        ctx.fillText(chars[c], x, baseY);
        x += ctx.measureText(chars[c]).width;
      }
    }
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
