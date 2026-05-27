class NoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'type', defaultValue: 0, minValue: 0, maxValue: 2 },
      { name: 'gain', defaultValue: 0.5, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    // Pink noise state (Voss-McCartney algorithm)
    this._pinkRows = new Float32Array(16);
    this._pinkRunningSum = 0;
    this._pinkIndex = 0;
    this._pinkIndexMask = (1 << 16) - 1;
    // Brown noise state
    this._brownLast = 0;
    this.port.onmessage = (e) => {
      if (e.data.type !== undefined) this._noiseType = e.data.type;
    };
    this._noiseType = 0; // 0=white, 1=pink, 2=brown
  }

  _white() {
    return Math.random() * 2 - 1;
  }

  _pink() {
    const index = this._pinkIndex++;
    this._pinkIndex &= this._pinkIndexMask;
    let numZeros = 0;
    let n = index;
    while (((n & 1) === 0) && n > 0) {
      numZeros++;
      n >>= 1;
    }
    if (numZeros < this._pinkRows.length) {
      this._pinkRunningSum -= this._pinkRows[numZeros];
      const newRandom = Math.random() * 2 - 1;
      this._pinkRunningSum += newRandom;
      this._pinkRows[numZeros] = newRandom;
    }
    return (this._pinkRunningSum + Math.random() * 2 - 1) / (this._pinkRows.length + 1);
  }

  _brown() {
    const white = this._white();
    this._brownLast = (this._brownLast + (0.02 * white)) / 1.02;
    return this._brownLast * 3.5;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const gain = parameters.gain.length > 1 ? parameters.gain : parameters.gain[0];

    for (let channel = 0; channel < output.length; channel++) {
      const buf = output[channel];
      for (let i = 0; i < buf.length; i++) {
        const g = typeof gain === 'number' ? gain : gain[i];
        let sample;
        switch (this._noiseType) {
          case 0: sample = this._white(); break;
          case 1: sample = this._pink(); break;
          case 2: sample = this._brown(); break;
          default: sample = this._white();
        }
        buf[i] = sample * g;
      }
    }
    return true;
  }
}

registerProcessor('noise-processor', NoiseProcessor);
