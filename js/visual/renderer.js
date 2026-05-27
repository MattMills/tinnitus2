// Visual renderer — spectrogram, waveform, pattern display, and correlation view

export class VisualRenderer {
  constructor(canvasIds) {
    this.canvases = {};
    this.contexts = {};
    for (const [key, id] of Object.entries(canvasIds)) {
      const canvas = document.getElementById(id);
      this.canvases[key] = canvas;
      this.contexts[key] = canvas.getContext('2d');
    }
    this._spectrogramColumn = 0;
    this._spectrogramImage = null;
    this._running = false;
    this._rafId = null;
  }

  resize() {
    for (const [key, canvas] of Object.entries(this.canvases)) {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * devicePixelRatio;
      canvas.height = rect.height * devicePixelRatio;
      this.contexts[key].scale(devicePixelRatio, devicePixelRatio);
    }
    this._spectrogramImage = null;
    this._spectrogramColumn = 0;
  }

  drawWaveform(timeDomainData) {
    const ctx = this.contexts.waveform;
    const canvas = this.canvases.waveform;
    const w = canvas.width / devicePixelRatio;
    const h = canvas.height / devicePixelRatio;

    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, w, h);

    if (!timeDomainData) return;

    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const step = timeDomainData.length / w;
    for (let i = 0; i < w; i++) {
      const idx = Math.floor(i * step);
      const v = timeDomainData[idx];
      const y = (1 - v) * h / 2;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();

    // Center line
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }

  drawSpectrogram(frequencyData) {
    const ctx = this.contexts.spectrogram;
    const canvas = this.canvases.spectrogram;
    const w = canvas.width / devicePixelRatio;
    const h = canvas.height / devicePixelRatio;

    if (!frequencyData) {
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    // Scroll left
    if (this._spectrogramImage) {
      ctx.putImageData(this._spectrogramImage, -1, 0);
    }

    // Draw new column
    const numBins = frequencyData.length;
    const binHeight = h / numBins;

    for (let i = 0; i < numBins; i++) {
      const db = frequencyData[i];
      const normalized = Math.max(0, Math.min(1, (db + 100) / 100));
      const hue = 240 - normalized * 240;
      const lightness = normalized * 50;
      ctx.fillStyle = `hsl(${hue}, 100%, ${lightness}%)`;
      ctx.fillRect(w - 1, h - (i + 1) * binHeight, 1, binHeight + 0.5);
    }

    this._spectrogramImage = ctx.getImageData(0, 0,
      canvas.width, canvas.height);
    this._spectrogramColumn++;
  }

  drawPattern(patternData, width, height) {
    const ctx = this.contexts.pattern;
    const canvas = this.canvases.pattern;
    const cw = canvas.width / devicePixelRatio;
    const ch = canvas.height / devicePixelRatio;

    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, cw, ch);

    if (!patternData) return;

    const cellW = cw / width;
    const cellH = ch / height;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (idx >= patternData.length) break;
        const v = patternData[idx];
        const r = Math.floor(Math.max(0, Math.min(1, (v + 1) / 2)) * 255);
        const g = Math.floor(Math.max(0, Math.min(1, v > 0 ? v : 0)) * 200);
        const b = Math.floor(Math.max(0, Math.min(1, v < 0 ? -v : 0)) * 255);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x * cellW, y * cellH, cellW - 0.5, cellH - 0.5);
      }
    }
  }

  drawCorrelation(correlationData, labels) {
    const ctx = this.contexts.correlation;
    const canvas = this.canvases.correlation;
    const w = canvas.width / devicePixelRatio;
    const h = canvas.height / devicePixelRatio;

    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, w, h);

    if (!correlationData || correlationData.length === 0) return;

    const colors = ['#ff4444', '#44ff44', '#4444ff', '#ffff44', '#ff44ff', '#44ffff'];

    for (let c = 0; c < correlationData.length; c++) {
      const data = correlationData[c];
      const color = colors[c % colors.length];

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      const step = data.length / w;
      for (let i = 0; i < w; i++) {
        const idx = Math.floor(i * step);
        const v = data[idx];
        const y = (1 - (v + 1) / 2) * h;
        if (i === 0) ctx.moveTo(i, y);
        else ctx.lineTo(i, y);
      }
      ctx.stroke();

      if (labels && labels[c]) {
        ctx.fillStyle = color;
        ctx.font = '11px monospace';
        ctx.fillText(labels[c], 5, 15 + c * 15);
      }
    }

    // Zero line
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }
}
