// Forward Error Correction — rate-1/2 convolutional encoder + Viterbi decoder
// Constraint length K=3, generators [7, 5] (octal)

export class ConvolutionalEncoder {
  constructor() {
    this.g0 = 0b111; // generator polynomial 1 (octal 7)
    this.g1 = 0b101; // generator polynomial 2 (octal 5)
    this.K = 3;
    this.state = 0;
  }

  reset() {
    this.state = 0;
  }

  encodeBit(bit) {
    this.state = ((this.state << 1) | (bit & 1)) & ((1 << this.K) - 1);
    const out0 = this._parity(this.state & this.g0);
    const out1 = this._parity(this.state & this.g1);
    return [out0, out1];
  }

  encode(bits) {
    this.reset();
    const output = [];
    for (const bit of bits) {
      const [a, b] = this.encodeBit(bit);
      output.push(a, b);
    }
    // Flush with K-1 zeros
    for (let i = 0; i < this.K - 1; i++) {
      const [a, b] = this.encodeBit(0);
      output.push(a, b);
    }
    return new Int8Array(output);
  }

  _parity(x) {
    let p = 0;
    while (x) { p ^= x & 1; x >>= 1; }
    return p;
  }
}

export class ViterbiDecoder {
  constructor() {
    this.K = 3;
    this.numStates = 1 << (this.K - 1);
    this.g0 = 0b111;
    this.g1 = 0b101;
  }

  decode(received) {
    const numStates = this.numStates;
    const numSteps = received.length / 2;
    const INF = 1e9;

    let pathMetric = new Float32Array(numStates).fill(INF);
    pathMetric[0] = 0;
    const survivors = [];

    for (let step = 0; step < numSteps; step++) {
      const r0 = received[step * 2];
      const r1 = received[step * 2 + 1];
      const newMetric = new Float32Array(numStates).fill(INF);
      const prevState = new Int32Array(numStates);
      const bits = new Int8Array(numStates);

      for (let s = 0; s < numStates; s++) {
        for (let bit = 0; bit <= 1; bit++) {
          const fullState = ((s << 1) | bit) & ((1 << this.K) - 1);
          const nextState = fullState >> 0 & (numStates - 1);
          const actualNext = ((s << 1) | bit) & (numStates - 1);
          const e0 = this._parity(fullState & this.g0);
          const e1 = this._parity(fullState & this.g1);
          const branchMetric = (r0 !== e0 ? 1 : 0) + (r1 !== e1 ? 1 : 0);
          const candidate = pathMetric[s] + branchMetric;
          if (candidate < newMetric[actualNext]) {
            newMetric[actualNext] = candidate;
            prevState[actualNext] = s;
            bits[actualNext] = bit;
          }
        }
      }

      pathMetric = newMetric;
      survivors.push({ prevState: prevState.slice(), bits: bits.slice() });
    }

    // Traceback from state 0
    let state = 0;
    const decoded = [];
    for (let step = survivors.length - 1; step >= 0; step--) {
      decoded.unshift(survivors[step].bits[state]);
      state = survivors[step].prevState[state];
    }

    // Remove tail bits
    return new Int8Array(decoded.slice(0, decoded.length - (this.K - 1)));
  }

  _parity(x) {
    let p = 0;
    while (x) { p ^= x & 1; x >>= 1; }
    return p;
  }
}

// Simple interleaver for burst error protection
export class BlockInterleaver {
  constructor(rows, cols) {
    this.rows = rows;
    this.cols = cols;
  }

  interleave(data) {
    const out = new Int8Array(this.rows * this.cols);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const srcIdx = r * this.cols + c;
        const dstIdx = c * this.rows + r;
        out[dstIdx] = srcIdx < data.length ? data[srcIdx] : 0;
      }
    }
    return out;
  }

  deinterleave(data) {
    const out = new Int8Array(this.rows * this.cols);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const srcIdx = c * this.rows + r;
        const dstIdx = r * this.cols + c;
        out[dstIdx] = srcIdx < data.length ? data[srcIdx] : 0;
      }
    }
    return out;
  }
}
