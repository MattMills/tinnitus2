// One-Time Pad token stream generator

export class OTPStream {
  constructor(seed) {
    this._seed = seed || Date.now();
    this._state = new Uint32Array(4);
    this._initState(this._seed);
    this._buffer = 0;
    this._position = 0;
  }

  _initState(seed) {
    // xoshiro128** seeding via splitmix32
    let s = seed >>> 0;
    for (let i = 0; i < 4; i++) {
      s += 0x9e3779b9;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      z = z ^ (z >>> 16);
      this._state[i] = z >>> 0;
    }
  }

  // xoshiro128** PRNG — period 2^128-1
  _next() {
    const s = this._state;
    const result = Math.imul(this._rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = this._rotl(s[3], 11);
    return result;
  }

  _rotl(x, k) {
    return ((x << k) | (x >>> (32 - k))) >>> 0;
  }

  nextBit() {
    if (this._position % 32 === 0) {
      this._buffer = this._next();
    }
    const bit = (this._buffer >>> (this._position % 32)) & 1;
    this._position++;
    return bit;
  }

  nextByte() {
    let byte = 0;
    for (let i = 0; i < 8; i++) {
      byte |= this.nextBit() << i;
    }
    return byte;
  }

  nextBits(count) {
    const bits = new Int8Array(count);
    for (let i = 0; i < count; i++) {
      bits[i] = this.nextBit();
    }
    return bits;
  }

  // XOR data with OTP stream
  encrypt(data) {
    const out = new Int8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      out[i] = data[i] ^ this.nextBit();
    }
    return out;
  }

  // Same operation — XOR is its own inverse
  decrypt(data) {
    return this.encrypt(data);
  }

  // Get current position for synchronization
  get position() {
    return this._position;
  }

  // Reset to specific position (re-derive state)
  seek(position) {
    this._initState(this._seed);
    this._position = 0;
    this._buffer = 0;
    // Fast-forward bit by bit
    for (let i = 0; i < position; i++) {
      this.nextBit();
    }
  }
}

// Synchronized OTP pair for tx/rx
export function createOTPPair(sharedSeed) {
  const seed = sharedSeed || Math.floor(Math.random() * 0xFFFFFFFF);
  return {
    seed,
    tx: new OTPStream(seed),
    rx: new OTPStream(seed),
  };
}
