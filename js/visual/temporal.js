// Temporal Entangled Renderer
//
// Multiple independent visualizer instances run simultaneously, each at a
// different time offset.  The screen is divided into prime-number vertical
// stripes, each showing a LIVE animated view at a different temporal position.
//
// All stripes animate continuously — they are not frozen snapshots.
// Past stripes show the signal as it WAS (delayed playback).
// Future stripes show the signal as it WILL BE (predicted by advancing the code).
// The center stripe is NOW.
//
// Stripe count oscillates through primes: 1 → 3 → 5 → 7 → 5 → 3 → ...
// Even-distance positions from center are cross-temporally swapped.

const PRIMES = [1, 3, 5, 7, 5, 3];
const PRIME_CYCLE_PERIOD = 15; // seconds per full oscillation

export class TemporalRenderer {
  constructor(canvas) {
    this.mainCanvas = canvas;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._w = 0;
    this._h = 0;
    this._time = 0;

    // Time offset between adjacent stripes (seconds)
    this.timeSpread = 0.5;

    // Each stripe gets its own offscreen canvas that animates independently
    this._stripeCanvases = [];
    this._stripeCtxs = [];
    this._maxStripes = 7;

    // Per-stripe animation state (independent time, breath, color phase)
    this._stripeStates = [];

    // Shared code state
    this._codeState = null;
    this._coherence = 0;
    this._textLines = [];
    this.colorMode = 'spectrum';

    // Layer proxy (for compatibility with app.js layer toggle bindings)
    this.layers = {
      grid:        { enabled: true,  opacity: 0.6, scale: 1.0, gridSize: 16 },
      rings:       { enabled: true,  opacity: 0.5, scale: 1.0, ringCount: 5 },
      codeCircle:  { enabled: true,  opacity: 0.5, scale: 1.0 },
      waveformRing:{ enabled: true,  opacity: 0.5, scale: 1.0 },
      spirals:     { enabled: false, opacity: 0.4, scale: 1.0, armCount: 3 },
      particles:   { enabled: false, opacity: 0.4, scale: 1.0, count: 128 },
      bars:        { enabled: false, opacity: 0.5, scale: 1.0 },
      lissajous:   { enabled: false, opacity: 0.5, scale: 1.0 },
      textStream:  { enabled: false, opacity: 0.7, scale: 1.0 },
      highDim:     { enabled: false, opacity: 0.8, scale: 1.0 },
      colorRef:    { enabled: true,  opacity: 0.9, scale: 1.0 },
    };

    this.skipBackground = false;

    this._initStripeCanvases();
    this._resize();
  }

  _initStripeCanvases() {
    for (let i = 0; i < this._maxStripes; i++) {
      const c = document.createElement('canvas');
      this._stripeCanvases.push(c);
      this._stripeCtxs.push(c.getContext('2d'));
      this._stripeStates.push({
        time: 0,
        breathPhase: 0,
        colorPhase: 0,
        colorTriAngle: 0,
        colorTriSat: 70,
        colorTriLight: 40,
        colorTriPhase: 0,
      });
    }
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.mainCanvas.getBoundingClientRect();
    this.mainCanvas.width = rect.width * dpr;
    this.mainCanvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = rect.width;
    this._h = rect.height;

    for (const c of this._stripeCanvases) {
      c.width = rect.width * dpr;
      c.height = rect.height * dpr;
    }
  }

  resize() { this._resize(); }

  setCodeState(spreadingCode, dataStream, chipIndex) {
    this._codeState = { spreadingCode, dataStream, chipIndex };
  }

  setCoherence(v) { this._coherence = v; }
  setTextStream(lines) { this._textLines = lines; }

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
    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;
    const dpr = window.devicePixelRatio || 1;

    // Determine current stripe count
    const cyclePos = (this._time / PRIME_CYCLE_PERIOD) % 1;
    const cycleIdx = cyclePos * PRIMES.length;
    const primeIdx = Math.floor(cycleIdx);
    const numStripes = PRIMES[primeIdx % PRIMES.length];
    const timeOffsets = this._computeTimeOffsets(numStripes);

    // Clear main canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    if (numStripes === 1) {
      // Single stripe — render directly to main canvas, full animation
      this._renderStripe(this.ctx, w, h, dpr, dt, 0, audioTimeDomain, audioFrequency);
      this._drawHeader(ctx, w, h, 1, [0]);
      return;
    }

    const stripeW = w / numStripes;

    // Render each stripe independently to its own canvas, then composite
    for (let i = 0; i < numStripes; i++) {
      const offset = timeOffsets[i];
      const stripeCtx = this._stripeCtxs[i];
      stripeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Each stripe animates at real dt but with its time-offset applied
      this._renderStripe(stripeCtx, w, h, dpr, dt, offset, audioTimeDomain, audioFrequency);

      // Copy only the center vertical slice of the stripe canvas to the main canvas
      // (each stripe renders full-width but we only take the center column)
      const srcX = Math.floor((w / 2 - stripeW / 2) * dpr);
      const srcW = Math.ceil(stripeW * dpr);
      const dstX = Math.floor(i * stripeW);
      ctx.drawImage(
        this._stripeCanvases[i],
        srcX, 0, srcW, h * dpr,
        dstX, 0, stripeW, h
      );
    }

    // Stripe separators
    for (let i = 1; i < numStripes; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(Math.floor(i * stripeW), 0, 1, h);
    }

    // Header
    this._drawHeader(ctx, w, h, numStripes, timeOffsets);
  }

  _renderStripe(ctx, w, h, dpr, dt, timeOffset, audioTimeDomain, audioFrequency) {
    const code = this._codeState?.spreadingCode;
    const data = this._codeState?.dataStream;
    if (!code || code.length === 0) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    // Advance this stripe's independent state
    const idx = Math.max(0, Math.min(this._maxStripes - 1,
      Math.abs(timeOffset) + (timeOffset >= 0 ? 0 : 3)));
    const ss = this._stripeStates[idx];
    ss.time += dt;
    ss.breathPhase += dt * 0.15 * Math.PI * 2;
    ss.colorPhase += dt * 0.08;
    ss.colorTriAngle += dt * 12;
    ss.colorTriPhase += dt * 0.4;
    ss.colorTriSat = 45 + Math.sin(ss.colorTriPhase * 0.7) * 35 +
                      Math.sin(ss.colorTriPhase * 1.3) * 15;
    ss.colorTriLight = 30 + Math.sin(ss.colorTriPhase * 0.5) * 20 +
                        Math.sin(ss.colorTriPhase * 1.7) * 10;

    // The effective time for this stripe (offset from center)
    const effectiveTime = ss.time + timeOffset * this.timeSpread;
    const chipPhase = effectiveTime * 40;
    const breath = (Math.sin(ss.breathPhase + timeOffset * 0.5) + 1) / 2;

    // Background
    const bg = 2 + breath * 3;
    ctx.fillStyle = `rgb(${bg},${bg},${bg + 2})`;
    ctx.fillRect(0, 0, w, h);

    // Grid with color reference
    if (this.layers.grid.enabled) {
      this._drawGrid(ctx, w, h, code, data, chipPhase, breath, ss);
    }

    // Rings
    if (this.layers.rings.enabled) {
      this._drawRings(ctx, w, h, code, data, chipPhase, breath, effectiveTime);
    }

    // Code circle
    if (this.layers.codeCircle.enabled) {
      this._drawCodeCircle(ctx, w, h, code, data, chipPhase, breath, ss);
    }

    // Waveform ring
    if (this.layers.waveformRing.enabled && audioTimeDomain) {
      this._drawWaveformRing(ctx, w, h, audioTimeDomain);
    }
  }

  _drawGrid(ctx, w, h, code, data, chipPhase, breath, ss) {
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

    const triH0 = ss.colorTriAngle % 360;
    const triH1 = (triH0 + 120) % 360;
    const triH2 = (triH0 + 240) % 360;

    ctx.globalAlpha = L.opacity;
    for (let gy = 0; gy < gs; gy++) {
      for (let gx = 0; gx < gs; gx++) {
        const idx = (gy * gs + gx + offset) % code.length;
        const chip = code[idx];
        const coarse = code[Math.floor((gy * gs + gx) / 4) % code.length];
        const isRef = ((gx + gy * 2) % 5 === 0);

        let hue, sat, light;
        if (isRef) {
          const triVertex = (gx + gy) % 3;
          hue = [triH0, triH1, triH2][triVertex];
          sat = ss.colorTriSat;
          light = ss.colorTriLight + chip * 10 + breath * 3;
        } else {
          const base = ss.colorPhase * 360;
          const spatial = ((gx ^ gy) * 37 + gx * 7 + gy * 13) % 360;
          hue = (base + spatial * 0.5 + chip * 60 + coarse * 30) % 360;
          sat = 70;
          light = 6 + chip * 18 + breath * 5;
        }

        ctx.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
        ctx.fillRect(ox + gx * cellW + 0.5, oy + gy * cellH + 0.5, cellW - 1, cellH - 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawRings(ctx, w, h, code, data, chipPhase, breath, effectiveTime) {
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
      const rotation = effectiveTime * (0.2 + r * 0.15) * (chip ? 1 : -1);
      const segments = code.length;

      ctx.beginPath();
      for (let s = 0; s < segments; s++) {
        const sIdx = (s + Math.floor(chipPhase)) % code.length;
        const sChip = code[sIdx];
        const rMod = radius * (0.95 + sChip * 0.1);
        const angle = (s / segments) * Math.PI * 2 + rotation;
        const x = cx + Math.cos(angle) * rMod;
        const y = cy + Math.sin(angle) * rMod;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const hue = (effectiveTime * 10 + r * 60) % 360;
      ctx.strokeStyle = `hsl(${hue}, 60%, ${40 + dsss * 20}%)`;
      ctx.lineWidth = 1 + r * 0.3;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawCodeCircle(ctx, w, h, code, data, chipPhase, breath, ss) {
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
      const r = maxR * (0.3 + dsss * 0.15 + Math.sin(ss.breathPhase + i * 0.1) * 0.05);
      const angle = i * angleStep - Math.PI / 2;
      if (i === 0) ctx.moveTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      else ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    }
    ctx.closePath();
    const hue = (ss.colorPhase * 100) % 360;
    ctx.strokeStyle = `hsl(${hue}, 70%, 50%)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _drawWaveformRing(ctx, w, h, audioTimeDomain) {
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

  _computeTimeOffsets(n) {
    if (n === 1) return [0];
    const offsets = new Array(n).fill(0);
    const center = Math.floor(n / 2);
    offsets[center] = 0;
    let timeStep = 1;
    for (let dist = 1; dist <= center; dist++) {
      const leftPos = center - dist;
      const rightPos = center + dist;
      if (dist % 2 === 1) {
        if (leftPos >= 0) offsets[leftPos] = -timeStep;
        if (rightPos < n) offsets[rightPos] = timeStep;
      } else {
        if (leftPos >= 0) offsets[leftPos] = timeStep;
        if (rightPos < n) offsets[rightPos] = -timeStep;
      }
      timeStep++;
    }
    return offsets;
  }

  _drawHeader(ctx, w, h, numStripes, timeOffsets) {
    if (numStripes <= 1) {
      ctx.fillStyle = 'rgba(0,255,136,0.4)';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('t = 0', w / 2, 20);
      return;
    }

    const stripeW = w / numStripes;
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, w, 26);

    for (let i = 0; i < numStripes; i++) {
      const offset = timeOffsets[i];
      const cx = i * stripeW + stripeW / 2;

      let label, color;
      if (offset === 0) {
        label = 'NOW';
        color = 'rgba(0,255,136,0.9)';
      } else if (offset < 0) {
        label = `t${offset}`;
        color = 'rgba(100,150,255,0.8)';
      } else {
        label = `t+${offset}`;
        color = 'rgba(255,150,100,0.8)';
      }

      ctx.fillStyle = color;
      ctx.fillText(label, cx, 17);
    }
  }
}
