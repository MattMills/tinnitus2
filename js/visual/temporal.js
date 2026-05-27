// Temporal Entangled Renderer
//
// Divides the screen into prime-number vertical stripes showing different
// time offsets of the same visual signal.  The stripe count oscillates
// through primes: 1 → 3 → 5 → 7 → 5 → 3 → 1 → ...
//
// Stripe layout (example for 5 stripes, left to right):
//   [t+2, t-1, t=0, t+1, t-2]
//
// The past/future are interleaved on alternating sides:
//   Center:           t=0 (now)
//   1st from center:  left=t-1, right=t+1 (natural)
//   2nd from center:  left=t+2, right=t-2 (SWAPPED — cross-temporal)
//   3rd from center:  left=t-3, right=t+3 (natural)
//
// This forces the perceptual system to integrate across a spatially
// scrambled timeline — engaging retrodictive processing.
//
// A circular buffer stores past states.  Future states are computed
// by advancing the code deterministically.  A clear header shows the
// relative time offset of each stripe.

import { Visualizer } from './visualizer.js';

const PRIMES = [1, 3, 5, 7, 5, 3]; // oscillation cycle
const PRIME_CYCLE_PERIOD = 12; // seconds per full oscillation

export class TemporalRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._w = 0;
    this._h = 0;
    this._time = 0;

    // The underlying visualizer we render through
    this._viz = new Visualizer(canvas);

    // Offscreen canvas for rendering individual time slices
    this._offscreen = document.createElement('canvas');
    this._offCtx = this._offscreen.getContext('2d');

    // Circular buffer of past states
    this._bufferSize = 60; // ~1 second at 60fps
    this._buffer = [];
    this._bufferIdx = 0;

    // Frame interval between stored states (in render frames)
    // Larger = wider temporal spread between stripes
    this.frameSpread = 8; // each stripe offset = 8 frames apart (~133ms)

    // Current stripe configuration
    this._currentPrimeIdx = 0;
    this._stripeCount = 1;
    this._stripeTransition = 0; // 0-1 blend between stripe counts

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

    this._offscreen.width = this.canvas.width;
    this._offscreen.height = this.canvas.height;
    this._offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this._viz._w = rect.width;
    this._viz._h = rect.height;
  }

  resize() { this._resize(); }

  setCodeState(spreadingCode, dataStream, chipIndex) {
    this._viz.setCodeState(spreadingCode, dataStream, chipIndex);
  }

  setCoherence(v) { this._viz.setCoherence(v); }

  setTextStream(lines) { this._viz.setTextStream(lines); }

  setLayerEnabled(name, enabled) { this._viz.setLayerEnabled(name, enabled); }
  setLayerOpacity(name, opacity) { this._viz.setLayerOpacity(name, opacity); }
  setLayerScale(name, scale) { this._viz.setLayerScale(name, scale); }

  get layers() { return this._viz.layers; }
  set skipBackground(v) { this._viz.skipBackground = v; }
  set colorMode(v) { this._viz.colorMode = v; }

  render(dt, audioTimeDomain, audioFrequency) {
    this._time += dt;
    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;

    // Store current state snapshot in circular buffer
    this._pushState(audioTimeDomain, audioFrequency);

    // Determine current stripe count (oscillates through primes)
    const cyclePos = (this._time / PRIME_CYCLE_PERIOD) % 1;
    const cycleIdx = cyclePos * PRIMES.length;
    const primeIdx = Math.floor(cycleIdx);
    this._stripeTransition = cycleIdx - primeIdx;
    this._stripeCount = PRIMES[primeIdx % PRIMES.length];
    const nextStripeCount = PRIMES[(primeIdx + 1) % PRIMES.length];

    // Clear main canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    if (this._stripeCount === 1 && this._stripeTransition < 0.3) {
      // Unary view — just render normally
      this._viz.render(dt, audioTimeDomain, audioFrequency);
      this._drawHeader(ctx, w, h, 1);
      return;
    }

    // Multi-stripe rendering
    const numStripes = this._stripeCount;
    const stripeW = w / numStripes;
    const timeOffsets = this._computeTimeOffsets(numStripes);

    for (let i = 0; i < numStripes; i++) {
      const offset = timeOffsets[i];
      const stripeX = i * stripeW;

      // Get the state for this time offset
      const state = this._getStateAtOffset(offset);

      // Render the visualizer with this state to the offscreen canvas
      this._renderStateToOffscreen(state, dt);

      // Copy the relevant vertical stripe from offscreen to main canvas
      const dpr = window.devicePixelRatio || 1;
      ctx.drawImage(
        this._offscreen,
        stripeX * dpr, 0, stripeW * dpr, h * dpr,
        stripeX, 0, stripeW, h
      );

      // Stripe separator
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(stripeX, 0, 1, h);
    }

    // Draw time offset header
    this._drawHeader(ctx, w, h, numStripes, timeOffsets);
  }

  _pushState(audioTimeDomain, audioFrequency) {
    const state = {
      time: this._viz._time,
      breathPhase: this._viz._breathPhase,
      colorPhase: this._viz._colorPhase,
      chipPhase: this._viz._time * 40,
      audioTD: audioTimeDomain ? new Float32Array(audioTimeDomain) : null,
      audioFQ: audioFrequency ? new Float32Array(audioFrequency) : null,
      codeState: this._viz._codeState ? { ...this._viz._codeState } : null,
    };

    if (this._buffer.length < this._bufferSize) {
      this._buffer.push(state);
    } else {
      this._buffer[this._bufferIdx] = state;
    }
    this._bufferIdx = (this._bufferIdx + 1) % this._bufferSize;
  }

  _getStateAtOffset(offset) {
    if (offset === 0) {
      // Current state — use live data
      return this._buffer.length > 0
        ? this._buffer[(this._bufferIdx - 1 + this._buffer.length) % this._buffer.length]
        : null;
    }

    if (offset < 0) {
      // Past state — look back in buffer
      const framesBack = Math.abs(offset) * this.frameSpread;
      const idx = (this._bufferIdx - 1 - framesBack + this._buffer.length * 100) % this._buffer.length;
      return this._buffer[idx] || null;
    }

    // Future state — compute by advancing code forward
    // We can predict code state deterministically (it's pseudorandom from seeds)
    const framesForward = offset * this.frameSpread;
    const baseState = this._buffer.length > 0
      ? this._buffer[(this._bufferIdx - 1 + this._buffer.length) % this._buffer.length]
      : null;
    if (!baseState) return null;

    // Create a predicted future state by advancing the phase
    const dtPerFrame = 1 / 60;
    return {
      ...baseState,
      time: baseState.time + framesForward * dtPerFrame,
      breathPhase: baseState.breathPhase + framesForward * dtPerFrame * 0.15 * Math.PI * 2,
      colorPhase: baseState.colorPhase + framesForward * dtPerFrame * 0.08,
      chipPhase: (baseState.time + framesForward * dtPerFrame) * 40,
      audioTD: baseState.audioTD, // can't predict audio, use current
      audioFQ: baseState.audioFQ,
    };
  }

  _renderStateToOffscreen(state, dt) {
    if (!state) {
      this._offCtx.fillStyle = '#000';
      this._offCtx.fillRect(0, 0, this._w, this._h);
      return;
    }

    // Temporarily set the visualizer's internal state to the target time
    const saved = {
      time: this._viz._time,
      breathPhase: this._viz._breathPhase,
      colorPhase: this._viz._colorPhase,
    };

    this._viz._time = state.time;
    this._viz._breathPhase = state.breathPhase;
    this._viz._colorPhase = state.colorPhase;

    // Swap canvas context to offscreen
    const savedCtx = this._viz.ctx;
    this._viz.ctx = this._offCtx;

    // Render
    this._viz.skipBackground = false;
    this._viz.render(0.001, state.audioTD, state.audioFQ);

    // Restore
    this._viz.ctx = savedCtx;
    this._viz._time = saved.time;
    this._viz._breathPhase = saved.breathPhase;
    this._viz._colorPhase = saved.colorPhase;
  }

  // Compute the time offsets for each stripe position
  // Center = 0, then alternating with cross-temporal swap on even positions
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
        // Odd distance: natural mapping (past left, future right)
        if (leftPos >= 0) offsets[leftPos] = -timeStep;
        if (rightPos < n) offsets[rightPos] = timeStep;
      } else {
        // Even distance: SWAPPED (future left, past right) — the entanglement
        if (leftPos >= 0) offsets[leftPos] = timeStep;
        if (rightPos < n) offsets[rightPos] = -timeStep;
      }
      timeStep++;
    }

    return offsets;
  }

  _drawHeader(ctx, w, h, numStripes, timeOffsets) {
    if (numStripes <= 1) {
      // Single view header
      ctx.fillStyle = 'rgba(0,255,136,0.4)';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('t = 0 (now)', w / 2, 20);
      return;
    }

    const stripeW = w / numStripes;
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';

    // Header background
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, 28);

    for (let i = 0; i < numStripes; i++) {
      const offset = timeOffsets[i];
      const cx = i * stripeW + stripeW / 2;

      let label, color;
      if (offset === 0) {
        label = 'NOW';
        color = 'rgba(0,255,136,0.8)';
      } else if (offset < 0) {
        label = `t${offset}`;
        color = 'rgba(100,150,255,0.7)';
      } else {
        label = `t+${offset}`;
        color = 'rgba(255,150,100,0.7)';
      }

      ctx.fillStyle = color;
      ctx.fillText(label, cx, 18);

      // Small arrow showing temporal direction
      const arrowY = 24;
      ctx.beginPath();
      if (offset < 0) {
        ctx.moveTo(cx - 6, arrowY);
        ctx.lineTo(cx + 6, arrowY);
        ctx.lineTo(cx + 3, arrowY - 3);
      } else if (offset > 0) {
        ctx.moveTo(cx - 6, arrowY);
        ctx.lineTo(cx + 6, arrowY);
        ctx.lineTo(cx + 3, arrowY + 3);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
