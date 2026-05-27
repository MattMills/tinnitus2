// Gold code generator from two maximal-length LFSR sequences

const LFSR_TAPS = {
  5:  [[5, 3], [5, 4, 3, 2]],
  7:  [[7, 6], [7, 4]],
  10: [[10, 7], [10, 9, 8, 6]],
};

export class LFSR {
  constructor(taps, length, seed = 1) {
    this.taps = taps;
    this.length = length;
    this.mask = (1 << length) - 1;
    this.state = seed & this.mask || 1;
  }

  shift() {
    let feedback = 0;
    for (const tap of this.taps) {
      feedback ^= (this.state >> (tap - 1)) & 1;
    }
    this.state = ((this.state << 1) | feedback) & this.mask;
    return this.state & 1;
  }

  sequence() {
    const len = (1 << this.length) - 1;
    const seq = new Int8Array(len);
    const savedState = this.state;
    for (let i = 0; i < len; i++) {
      seq[i] = this.shift();
    }
    this.state = savedState;
    return seq;
  }
}

export class GoldCodeGenerator {
  constructor(registerLength = 5) {
    if (!LFSR_TAPS[registerLength]) {
      throw new Error(`No tap configuration for register length ${registerLength}`);
    }
    this.registerLength = registerLength;
    this.codeLength = (1 << registerLength) - 1;
    const [taps1, taps2] = LFSR_TAPS[registerLength];
    this._lfsr1Taps = taps1;
    this._lfsr2Taps = taps2;
  }

  generate(phaseOffset = 0) {
    const lfsr1 = new LFSR(this._lfsr1Taps, this.registerLength);
    const lfsr2 = new LFSR(this._lfsr2Taps, this.registerLength);

    const seq1 = lfsr1.sequence();
    const seq2 = lfsr2.sequence();

    const code = new Int8Array(this.codeLength);
    for (let i = 0; i < this.codeLength; i++) {
      code[i] = seq1[i] ^ seq2[(i + phaseOffset) % this.codeLength];
    }
    return code;
  }

  generateFamily() {
    const family = [];
    // Gold family: seq1, seq2, plus codeLength codes from XOR with offsets
    const lfsr1 = new LFSR(this._lfsr1Taps, this.registerLength);
    const lfsr2 = new LFSR(this._lfsr2Taps, this.registerLength);
    family.push({ offset: 'seq1', code: lfsr1.sequence() });
    family.push({ offset: 'seq2', code: lfsr2.sequence() });
    for (let offset = 0; offset < this.codeLength; offset++) {
      family.push({ offset, code: this.generate(offset) });
    }
    return family;
  }

  static crossCorrelation(codeA, codeB) {
    const len = codeA.length;
    const result = new Float32Array(len);
    for (let lag = 0; lag < len; lag++) {
      let sum = 0;
      for (let i = 0; i < len; i++) {
        const a = codeA[i] * 2 - 1; // map 0,1 → -1,+1
        const b = codeB[(i + lag) % len] * 2 - 1;
        sum += a * b;
      }
      result[lag] = sum / len;
    }
    return result;
  }
}
