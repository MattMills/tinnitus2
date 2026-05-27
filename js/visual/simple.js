// Simple perceptual renderer — clean cross-modal signal
// Smooth organic shapes that breathe with the code structure.
// The code modulates radius smoothly (not binary spikes).

export class SimpleRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._time = 0;
    this._breathPhase = 0;
    this._colorPhase = 0;
    this._coherence = 0;
    this._code = null;
    this._data = null;
    this._smoothR = null;
    this._w = 0;
    this._h = 0;
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

  setCodeState(spreadingCode, dataStream) {
    this._code = spreadingCode;
    this._data = dataStream;
    this._smoothR = null;
  }

  setCoherence(v) { this._coherence = v; }

  render(dt, audioTimeDomain) {
    this._time += dt;
    this._breathPhase += dt * 0.15 * Math.PI * 2;
    this._colorPhase += dt * 0.03;

    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;
    const cx = w / 2;
    const cy = h / 2;
    const breath = (Math.sin(this._breathPhase) + 1) / 2;

    // Dark background with subtle breath
    const bg = 3 + breath * 2;
    ctx.fillStyle = `rgb(${bg},${bg},${bg + 1})`;
    ctx.fillRect(0, 0, w, h);

    const code = this._code;
    const data = this._data;
    if (!code || code.length === 0) return;

    const chipPhase = this._time * 40;
    const maxR = Math.min(w, h) * 0.38;

    // Build smooth radius profile from code — interpolate between chips
    // so the shape flows instead of hard gear teeth
    const numPoints = 360;
    if (!this._smoothR || this._smoothR.length !== numPoints) {
      this._smoothR = new Float32Array(numPoints);
    }

    const offset = Math.floor(chipPhase) % code.length;
    for (let i = 0; i < numPoints; i++) {
      const codePos = (i / numPoints) * code.length;
      const idx0 = (Math.floor(codePos) + offset) % code.length;
      const idx1 = (idx0 + 1) % code.length;
      const frac = codePos % 1;

      const chip0 = code[idx0];
      const chip1 = code[idx1];
      const dataIdx = data ? Math.floor((i / numPoints) * data.length) % data.length : 0;
      const dataBit = data ? data[dataIdx] : 0;

      const dsss0 = chip0 ^ dataBit;
      const dsss1 = chip1 ^ dataBit;
      // Smooth interpolation between chip values
      const dsss = dsss0 * (1 - frac) + dsss1 * frac;

      // Target radius with gentle modulation
      const target = maxR * (0.55 + dsss * 0.12 + breath * 0.03);
      // Exponential smoothing
      this._smoothR[i] = this._smoothR[i] * 0.85 + target * 0.15;
    }

    // Outer code shape — smooth organic curve
    ctx.beginPath();
    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2 - Math.PI / 2;
      const r = this._smoothR[i];
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const hue = (this._colorPhase * 60 + 20) % 360;
    ctx.strokeStyle = `hsla(${hue}, 50%, 40%, 0.5)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Subtle fill
    ctx.fillStyle = `hsla(${hue}, 40%, 15%, 0.08)`;
    ctx.fill();

    // Second ring — offset phase, different color
    ctx.beginPath();
    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2 - Math.PI / 2;
      const baseR = this._smoothR[(i + numPoints / 3) % numPoints];
      const r = baseR * 0.75;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = `hsla(${(hue + 140) % 360}, 45%, 38%, 0.35)`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Inner waveform ring
    if (audioTimeDomain) {
      const innerR = maxR * 0.35;
      ctx.beginPath();
      const step = audioTimeDomain.length / 360;
      for (let deg = 0; deg < 360; deg++) {
        const val = audioTimeDomain[Math.floor(deg * step)] || 0;
        const r = innerR + val * innerR * 0.6;
        const angle = (deg * Math.PI) / 180 - Math.PI / 2;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (deg === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(160, 60%, 50%, 0.4)`;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Center coherence glow
    const glowR = 6 + this._coherence * 15;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    grad.addColorStop(0, `hsla(${120 * this._coherence}, 80%, 55%, 0.5)`);
    grad.addColorStop(1, `hsla(${120 * this._coherence}, 80%, 55%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Coherence bar
    const barW = w * 0.2;
    const barX = (w - barW) / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(barX, h - 14, barW, 2);
    ctx.fillStyle = `hsl(${120 * this._coherence}, 80%, 50%)`;
    ctx.fillRect(barX, h - 14, barW * this._coherence, 2);
  }
}
