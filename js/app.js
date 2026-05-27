import { AudioEngine } from './audio/engine.js';
import { VisualRenderer } from './visual/renderer.js';
import { SignalPipeline } from './engine/pipeline.js';
import { GoldCodeGenerator } from './signal/gold-codes.js';

class App {
  constructor() {
    this.audio = new AudioEngine();
    this.pipeline = new SignalPipeline();
    this.renderer = null;
    this.running = false;
    this._rafId = null;
    this._oscList = [];
    this._channelWidgets = [];
    this._logEl = null;
  }

  async start() {
    try {
      await this.audio.init();
      this.renderer = new VisualRenderer({
        waveform: 'cv-waveform',
        spectrogram: 'cv-spectrogram',
        pattern: 'cv-pattern',
        correlation: 'cv-correlation',
      });
      this.renderer.resize();
      window.addEventListener('resize', () => this.renderer.resize());

      this._bindControls();
      this._startRenderLoop();
      this.running = true;

      this._setStatus('active', `Running — ${this.audio.ctx.sampleRate} Hz`);
      this._log('success', 'Audio engine initialized');
      this._log('info', `Sample rate: ${this.audio.ctx.sampleRate} Hz`);
      this._log('info', `Gold code length: ${this.pipeline.goldGen.codeLength} chips`);

      document.getElementById('btn-start').textContent = 'Stop';
    } catch (e) {
      this._log('error', `Init failed: ${e.message}`);
      console.error(e);
    }
  }

  stop() {
    this.audio.destroy();
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._setStatus('', 'Stopped');
    document.getElementById('btn-start').textContent = 'Start';
  }

  _bindControls() {
    // Noise type
    document.getElementById('noise-type').addEventListener('change', (e) => {
      const val = parseInt(e.target.value);
      this.audio.setNoiseType(val);
      this._log('info', `Noise: ${['white', 'pink', 'brown'][val]}`);
    });

    // Noise gain
    this._bindSlider('noise-gain', (v) => {
      this.audio.setNoiseGain(v);
    });

    // Master gain
    this._bindSlider('master-gain', (v) => {
      this.audio.setMasterGain(v);
    });

    // DSSS gain
    this._bindSlider('dsss-gain', (v) => {
      this.audio.setDSSSGain(v);
    });

    // Chip rate
    this._bindSlider('chip-rate', (v) => {
      const rate = Math.floor(v * 10000) + 100;
      this.audio.setChipRate(rate);
      document.getElementById('chip-rate-val').textContent = rate;
    });

    // Add oscillator
    document.getElementById('btn-add-osc').addEventListener('click', () => {
      this._addOscillator();
    });

    // Add channel
    document.getElementById('btn-add-channel').addEventListener('click', () => {
      this._addChannel();
    });

    // Embed signal
    document.getElementById('btn-embed').addEventListener('click', () => {
      this._embedSignal();
    });

    // Detect signals
    document.getElementById('btn-detect').addEventListener('click', () => {
      this._detectSignals();
    });

    // Scan all codes
    document.getElementById('btn-scan').addEventListener('click', () => {
      this._scanAllCodes();
    });

    // Cross-domain correlation
    document.getElementById('btn-cross-correlate').addEventListener('click', () => {
      this._crossCorrelate();
    });

    // Extract code
    document.getElementById('btn-extract-code').addEventListener('click', () => {
      this._extractCode();
    });

    // OTP toggle
    document.getElementById('otp-enabled').addEventListener('change', (e) => {
      if (e.target.checked) {
        const seed = parseInt(document.getElementById('otp-seed').value) || Date.now();
        this.pipeline.setOTPSeed(seed);
        this._log('info', `OTP enabled (seed: ${seed})`);
      } else {
        this.pipeline.setOTPSeed(null);
        this._log('info', 'OTP disabled');
      }
    });

    // Register length
    document.getElementById('register-length').addEventListener('change', (e) => {
      const len = parseInt(e.target.value);
      try {
        this.pipeline.setRegisterLength(len);
        this._log('info', `Register length: ${len}, code length: ${this.pipeline.goldGen.codeLength}`);
      } catch (err) {
        this._log('error', err.message);
      }
    });
  }

  _bindSlider(id, callback) {
    const slider = document.getElementById(id);
    const valEl = document.getElementById(id + '-val');
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      if (valEl) valEl.textContent = v.toFixed(2);
      callback(v);
    });
  }

  _addOscillator() {
    const type = document.getElementById('osc-type').value;
    const freq = parseFloat(document.getElementById('osc-freq').value) || 440;
    const gain = parseFloat(document.getElementById('osc-gain-input').value) || 0.2;
    const id = this.audio.addOscillator(type, freq, gain);
    this._oscList.push(id);
    this._renderOscList();
    this._log('info', `Added ${type} oscillator at ${freq} Hz`);
  }

  _renderOscList() {
    const container = document.getElementById('osc-list');
    container.innerHTML = '';
    for (const oscId of this._oscList) {
      const entry = this.audio.oscillators.find(o => o.id === oscId);
      if (!entry) continue;

      const div = document.createElement('div');
      div.className = 'osc-item';
      div.innerHTML = `
        <div class="osc-header">
          <span style="color:var(--accent);font-size:11px">${entry.type} ${entry.frequency} Hz</span>
          <button class="remove-btn" data-id="${oscId}">&times;</button>
        </div>
        <div class="control-row">
          <label>Gain</label>
          <input type="range" min="0" max="1" step="0.01" value="${entry.gain.gain.value}" data-osc-gain="${oscId}">
          <span class="value">${entry.gain.gain.value.toFixed(2)}</span>
        </div>
        <div class="control-row">
          <label>Freq</label>
          <input type="range" min="20" max="20000" step="1" value="${entry.osc.frequency.value}" data-osc-freq="${oscId}">
          <span class="value">${Math.round(entry.osc.frequency.value)}</span>
        </div>
      `;

      div.querySelector('.remove-btn').addEventListener('click', () => {
        this.audio.removeOscillator(oscId);
        this._oscList = this._oscList.filter(x => x !== oscId);
        this._renderOscList();
      });

      const gainSlider = div.querySelector(`[data-osc-gain="${oscId}"]`);
      gainSlider.addEventListener('input', () => {
        this.audio.updateOscillator(oscId, { gain: parseFloat(gainSlider.value) });
        gainSlider.nextElementSibling.textContent = parseFloat(gainSlider.value).toFixed(2);
      });

      const freqSlider = div.querySelector(`[data-osc-freq="${oscId}"]`);
      freqSlider.addEventListener('input', () => {
        this.audio.updateOscillator(oscId, { frequency: parseFloat(freqSlider.value) });
        freqSlider.nextElementSibling.textContent = Math.round(parseFloat(freqSlider.value));
      });

      container.appendChild(div);
    }
  }

  _addChannel() {
    const name = document.getElementById('channel-name').value || `CH-${this._channelWidgets.length}`;
    const offset = parseInt(document.getElementById('channel-offset').value) || this._channelWidgets.length;
    const id = this.pipeline.createChannel(name, offset);
    this._channelWidgets.push(id);
    this._renderChannelList();
    this._log('info', `Channel "${name}" — Gold code offset ${offset}`);
  }

  _renderChannelList() {
    const container = document.getElementById('channel-list');
    container.innerHTML = '';
    for (const chId of this._channelWidgets) {
      const ch = this.pipeline.channels.get(chId);
      if (!ch) continue;

      const div = document.createElement('div');
      div.className = 'channel-item';
      div.innerHTML = `
        <div class="channel-header">
          <span class="channel-name">${ch.name}</span>
          <button class="remove-btn" data-ch="${chId}">&times;</button>
        </div>
        <div class="data-input">
          <textarea placeholder="Enter data to encode..." data-ch-data="${chId}">${ch._inputText || ''}</textarea>
        </div>
        <div class="btn-row">
          <button data-ch-encode="${chId}">Encode</button>
          <button data-ch-decode="${chId}">Decode</button>
        </div>
        <div class="channel-status" id="ch-status-${chId}" style="font-size:10px;color:var(--text-dim);margin-top:4px"></div>
      `;

      div.querySelector(`[data-ch="${chId}"]`).addEventListener('click', () => {
        this.pipeline.removeChannel(chId);
        this._channelWidgets = this._channelWidgets.filter(x => x !== chId);
        this._renderChannelList();
      });

      div.querySelector(`[data-ch-encode="${chId}"]`).addEventListener('click', () => {
        const text = div.querySelector(`[data-ch-data="${chId}"]`).value;
        if (!text) { this._log('error', 'No data to encode'); return; }
        ch._inputText = text;
        const spread = this.pipeline.encodeMessage(chId, text);
        this._log('success', `Encoded "${text}" → ${spread.length} chips on ${ch.name}`);
        document.getElementById(`ch-status-${chId}`).textContent =
          `${text.length} bytes → ${spread.length} chips`;

        // Feed to audio DSSS
        this.audio.sendSpreadingCode(ch.code);
        const bits = this.pipeline.textToBits(text);
        this.audio.sendDataStream(bits);
      });

      div.querySelector(`[data-ch-decode="${chId}"]`).addEventListener('click', () => {
        const result = this.pipeline.decodeChannel(chId);
        if (result) {
          this._log('success', `Decoded from ${ch.name}: "${result}"`);
          document.getElementById(`ch-status-${chId}`).textContent = `Decoded: ${result}`;
        } else {
          this._log('error', `Could not decode ${ch.name}`);
        }
      });

      container.appendChild(div);
    }
  }

  _embedSignal() {
    const noisePower = parseFloat(document.getElementById('embed-noise').value) || 1.0;
    const sigPower = parseFloat(document.getElementById('embed-signal').value) || 0.1;

    const embedded = this.pipeline.embed(noisePower, sigPower);
    if (!embedded) {
      this._log('error', 'No encoded channels to embed');
      return;
    }

    this._log('success', `Embedded ${embedded.length} samples (SNR: ${(20 * Math.log10(sigPower / noisePower)).toFixed(1)} dB)`);

    // Update pattern display
    const pd = this.pipeline.patternData;
    if (pd) {
      this.renderer.drawPattern(pd, this.pipeline.patternWidth, this.pipeline.patternHeight);
    }

    // Update correlation display
    const corrData = this.pipeline.getCorrelationData();
    const corrLabels = this.pipeline.getCorrelationLabels();
    if (corrData.length > 0) {
      this.renderer.drawCorrelation(corrData, corrLabels);
    }
  }

  _detectSignals() {
    const threshold = parseFloat(document.getElementById('detect-threshold').value) || 0.3;
    const results = this.pipeline.detect(null, threshold);

    const container = document.getElementById('detection-results');
    container.innerHTML = '';

    if (results.length === 0) {
      this._log('info', 'No signals detected');
      container.innerHTML = '<div style="color:var(--text-dim);font-size:11px">No signals found</div>';
      return;
    }

    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'detection-item';
      div.innerHTML = `
        <span class="det-label">Code offset ${r.offset}</span>
        <span class="det-value">peak: ${r.peak.toFixed(3)} lag: ${r.lag}</span>
      `;
      container.appendChild(div);
    }

    this._log('success', `Detected ${results.length} signal(s)`);
  }

  _scanAllCodes() {
    this._log('info', 'Scanning all Gold codes...');
    const results = this.pipeline.detect(null, 0.2);

    const container = document.getElementById('detection-results');
    container.innerHTML = '';

    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'detection-item';
      div.innerHTML = `
        <span class="det-label">Offset ${r.offset}</span>
        <span class="det-value">corr: ${r.peak.toFixed(4)}</span>
      `;
      container.appendChild(div);
    }

    this._log('success', `Scan complete: ${results.length} code(s) found`);
  }

  _crossCorrelate() {
    const corr = this.pipeline.crossDomainCorrelation();
    if (!corr) {
      this._log('error', 'No embedded signal for cross-correlation');
      return;
    }

    let maxCorr = 0;
    let maxLag = 0;
    for (let i = 0; i < corr.length; i++) {
      if (Math.abs(corr[i]) > maxCorr) {
        maxCorr = Math.abs(corr[i]);
        maxLag = i;
      }
    }

    this._log('success', `Cross-domain correlation: peak=${maxCorr.toFixed(4)} at lag=${maxLag}`);

    // Display in correlation view
    this.renderer.drawCorrelation(
      [corr],
      ['Visual↔Audio cross-correlation']
    );
  }

  _extractCode() {
    const result = this.pipeline.extractCode();
    if (!result) {
      this._log('error', 'Cannot extract — no embedded signal');
      return;
    }

    const codeStr = Array.from(result.hard.slice(0, 31)).join('');
    this._log('success', `Extracted code: ${codeStr}...`);

    // Compare against known codes
    for (const [chId, ch] of this.pipeline.channels) {
      const knownStr = Array.from(ch.code.slice(0, 31)).join('');
      const corr = GoldCodeGenerator.crossCorrelation(result.hard, ch.code);
      let maxCorr = 0;
      for (const v of corr) if (Math.abs(v) > maxCorr) maxCorr = Math.abs(v);
      this._log('info', `  vs ${ch.name}: max correlation ${maxCorr.toFixed(4)} (code: ${knownStr}...)`);
    }
  }

  _startRenderLoop() {
    const draw = () => {
      if (!this.running) return;

      const timeDomain = this.audio.getTimeDomainData();
      const frequency = this.audio.getFrequencyData();

      this.renderer.drawWaveform(timeDomain);
      this.renderer.drawSpectrogram(frequency);

      this._rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  _setStatus(cls, text) {
    const el = document.getElementById('status-text');
    el.className = 'status ' + cls;
    el.textContent = text;
  }

  _log(type, message) {
    if (!this._logEl) this._logEl = document.getElementById('log-area');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const ts = new Date().toLocaleTimeString();
    entry.textContent = `[${ts}] ${message}`;
    this._logEl.appendChild(entry);
    this._logEl.scrollTop = this._logEl.scrollHeight;
  }
}

// Boot
const app = new App();
window.app = app;

document.getElementById('btn-start').addEventListener('click', () => {
  if (app.running) {
    app.stop();
  } else {
    app.start();
  }
});
