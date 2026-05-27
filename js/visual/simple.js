// Simple perceptual renderer — clean cross-modal signal
// Just the waveform ring, code circle, breath modulation, and coherence.
// No grid, no particles, no text — the minimum for cross-modal binding.

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
  }

  setCoherence(v) { this._coherence = v; }

  render(dt, audioTimeDomain) {
    this._time += dt;
    this._breathPhase += dt * 0.15 * Math.PI * 2;
    this._colorPhase += dt * 0.05;

    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;
    const cx = w / 2;
    const cy = h / 2;
    const breath = (Math.sin(this._breathPhase) + 1) / 2;

    // Dark background with breath
    const bg = 2 + breath * 3;
    ctx.fillStyle = `rgb(${bg},${bg},${bg + 1})`;
    ctx.fillRect(0, 0, w, h);

    const code = this._code;
    const data = this._data;
    if (!code || code.length === 0) return;

    const chipPhase = this._time * 40;
    const baseR = Math.min(w, h) * 0.35;

    // Outer code circle — the spreading code shape
    const n = code.length;
    const offset = Math.floor(chipPhase) % n;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const idx = (i + offset) % n;
      const chip = code[idx];
      const dataBit = data ? data[Math.floor(i / n * data.length) % data.length] : 0;
      const dsss = chip ^ dataBit;
      const r = baseR * (0.5 + dsss * 0.2 + breath * 0.05);
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const hue = (this._colorPhase * 80) % 360;
    ctx.strokeStyle = `hsla(${hue}, 60%, 45%, 0.6)`;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner waveform ring
    if (audioTimeDomain) {
      const innerR = baseR * 0.4;
      ctx.beginPath();
      const step = audioTimeDomain.length / 360;
      for (let deg = 0; deg < 360; deg++) {
        const val = audioTimeDomain[Math.floor(deg * step)] || 0;
        const r = innerR + val * innerR * 0.5;
        const angle = (deg * Math.PI) / 180 - Math.PI / 2;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (deg === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(160, 70%, 55%, 0.5)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Center coherence dot
    const dotR = 3 + this._coherence * 8;
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${120 * this._coherence}, 80%, 50%, 0.6)`;
    ctx.fill();

    // Coherence bar at bottom
    const barW = w * 0.25;
    const barX = (w - barW) / 2;
    const barY = h - 16;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(barX, barY, barW, 2);
    ctx.fillStyle = `hsl(${120 * this._coherence}, 80%, 50%)`;
    ctx.fillRect(barX, barY, barW * this._coherence, 2);
  }
}
