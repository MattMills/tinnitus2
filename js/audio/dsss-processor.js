class DSSSProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'chipRate', defaultValue: 1000, minValue: 100, maxValue: 48000 },
      { name: 'gain', defaultValue: 0.3, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this._spreadingCode = null;
    this._dataStream = null;
    this._chipIndex = 0;
    this._dataIndex = 0;
    this._samplesPerChip = 48;
    this._sampleCounter = 0;
    this._currentChip = 1;
    this._currentBit = 1;

    this.port.onmessage = (e) => {
      if (e.data.spreadingCode) {
        this._spreadingCode = e.data.spreadingCode;
        this._chipIndex = 0;
      }
      if (e.data.dataStream) {
        this._dataStream = e.data.dataStream;
        this._dataIndex = 0;
      }
      if (e.data.chipRate) {
        this._samplesPerChip = Math.floor(sampleRate / e.data.chipRate);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!this._spreadingCode || !this._dataStream) return true;

    const gain = parameters.gain[0];
    const chipsPerBit = this._spreadingCode.length;

    for (let channel = 0; channel < output.length; channel++) {
      const buf = output[channel];
      for (let i = 0; i < buf.length; i++) {
        if (this._sampleCounter >= this._samplesPerChip) {
          this._sampleCounter = 0;
          this._chipIndex++;
          if (this._chipIndex >= chipsPerBit) {
            this._chipIndex = 0;
            this._dataIndex = (this._dataIndex + 1) % this._dataStream.length;
            this._currentBit = this._dataStream[this._dataIndex];
          }
          this._currentChip = this._spreadingCode[this._chipIndex];
        }
        // DSSS: data bit XOR spreading chip → BPSK: +1 or -1
        buf[i] = (this._currentBit ^ this._currentChip ? 1 : -1) * gain;
        this._sampleCounter++;
      }
    }
    return true;
  }
}

registerProcessor('dsss-processor', DSSSProcessor);
