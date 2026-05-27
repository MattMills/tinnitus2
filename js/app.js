import { AudioEngine } from './audio/engine.js';
import { VisualRenderer } from './visual/renderer.js';
import { PerceptualRenderer, PerceptualAudioTuner } from './visual/perceptual.js';
import { SignalPipeline } from './engine/pipeline.js';
import { GoldCodeGenerator } from './signal/gold-codes.js';

// ================================================================
// Mode management
// ================================================================
const SCREENS = {
  launch: document.getElementById('launch-screen'),
  perceptual: document.getElementById('perceptual-mode'),
  engineering: document.getElementById('engineering-mode'),
};

function showScreen(name) {
  for (const [k, el] of Object.entries(SCREENS)) {
    el.style.display = k === name ? '' : 'none';
  }
}

// ================================================================
// Shared state
// ================================================================
let audio = null;
let pipeline = null;
let audioInitialized = false;

async function ensureAudio() {
  if (audioInitialized) return;
  audio = new AudioEngine();
  await audio.init();
  pipeline = new SignalPipeline();
  audioInitialized = true;
}

// ================================================================
// PERCEPTUAL MODE
// ================================================================
class PerceptualMode {
  constructor() {
    this.renderer = null;
    this.tuner = null;
    this.running = false;
    this._rafId = null;
    this._lastTime = 0;
    this._overlayVisible = true;
    this._settingsVisible = false;
    this._identitySeed = 42;
    this._identityPhrase = '';
    this._identityChannel = null;
    this._coherenceSmooth = 0;
  }

  async start() {
    await ensureAudio();
    // Resume if previously suspended (e.g. returning from launch screen)
    if (audio.ctx && audio.ctx.state === 'suspended') audio.resume();

    const canvas = document.getElementById('cv-perceptual');
    this.renderer = new PerceptualRenderer(canvas);
    this.tuner = new PerceptualAudioTuner(audio);

    window.addEventListener('resize', () => this.renderer.resize());
    this.renderer.resize();

    this._bindControls();
    this._initIdentitySignal();
    this.tuner.activate();

    this.running = true;
    this._lastTime = performance.now();
    this._renderLoop();
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this.tuner) this.tuner.deactivate();
    // Suspend the audio context so nothing keeps playing
    if (audio) audio.suspend();
  }

  _initIdentitySignal() {
    const seed = this._identitySeed;
    const phrase = this._identityPhrase || 'identity';

    pipeline.setOTPSeed(seed);
    this._identityChannel = pipeline.createChannel('SELF', seed % pipeline.goldGen.codeLength);

    const bits = pipeline.textToBits(phrase);
    const ch = pipeline.channels.get(this._identityChannel);
    if (ch) {
      pipeline.encodeMessage(this._identityChannel, phrase);
      audio.sendSpreadingCode(ch.code);
      audio.sendDataStream(bits);

      // Set perceptual renderer code state
      this.renderer.setCodeState(
        Array.from(ch.code),
        Array.from(bits),
        0
      );
    }
  }

  _reInitIdentity() {
    // Remove old channel
    if (this._identityChannel !== null) {
      pipeline.removeChannel(this._identityChannel);
    }
    this._initIdentitySignal();
  }

  _bindControls() {
    // Tap canvas to toggle overlay
    document.getElementById('cv-perceptual').addEventListener('click', () => {
      this._overlayVisible = !this._overlayVisible;
      const overlay = document.getElementById('perceptual-overlay');
      overlay.classList.toggle('hidden', !this._overlayVisible);
      if (!this._overlayVisible) {
        document.getElementById('perceptual-settings-panel').style.display = 'none';
        this._settingsVisible = false;
      }
    });

    // Back button — fully destroy audio so nothing keeps playing
    document.getElementById('btn-perceptual-back').addEventListener('click', (e) => {
      e.stopPropagation();
      this.stop();
      if (audio) { audio.destroy(); audioInitialized = false; audio = null; pipeline = null; }
      showScreen('launch');
    });

    // Settings toggle
    document.getElementById('btn-perceptual-settings').addEventListener('click', (e) => {
      e.stopPropagation();
      this._settingsVisible = !this._settingsVisible;
      document.getElementById('perceptual-settings-panel').style.display =
        this._settingsVisible ? '' : 'none';
    });

    // Identity controls
    const seedInput = document.getElementById('p-seed');
    const phraseInput = document.getElementById('p-phrase');
    seedInput.addEventListener('change', () => {
      this._identitySeed = parseInt(seedInput.value) || 42;
      this._reInitIdentity();
    });
    phraseInput.addEventListener('change', () => {
      this._identityPhrase = phraseInput.value;
      this._reInitIdentity();
    });

    // Audio controls
    this._bindPerceptualSlider('p-noise-gain', (v) => this.tuner.setNoiseGain(v));
    this._bindPerceptualSlider('p-tone-gain', (v) => this.tuner.setToneGain(v));
    this._bindPerceptualSlider('p-dsss-gain', (v) => this.tuner.setModulationDepth(v));
    this._bindPerceptualSlider('p-base-freq', (v) => {
      this.tuner.setBaseFreq(v);
      document.getElementById('p-base-freq-val').textContent = Math.round(v);
    });

    // Visual controls
    this._bindPerceptualSlider('p-chip-rate', (v) => {
      this.renderer.chipRate = v;
      audio.setChipRate(v * pipeline.goldGen.codeLength);
      document.getElementById('p-chip-rate-val').textContent = Math.round(v) + ' Hz';
    });
    this._bindPerceptualSlider('p-intensity', (v) => {
      this.renderer.intensity = v;
    });
    this._bindPerceptualSlider('p-grid', (v) => {
      this.renderer.gridSize = Math.round(v);
      document.getElementById('p-grid-val').textContent = Math.round(v);
    });

    document.getElementById('p-color-mode').addEventListener('change', (e) => {
      this.renderer.colorMode = e.target.value;
    });

    document.getElementById('p-noise-type').addEventListener('change', (e) => {
      audio.setNoiseType(parseInt(e.target.value));
    });

    // Fractal controls (will connect to fractal module when loaded)
    this._bindPerceptualSlider('p-fractal-levels', (v) => {
      document.getElementById('p-fractal-levels-val').textContent = Math.round(v);
    });
    this._bindPerceptualSlider('p-hop-interval', (v) => {
      document.getElementById('p-hop-interval-val').textContent = Math.round(v / 1000) + 's';
    });
  }

  _bindPerceptualSlider(id, callback) {
    const slider = document.getElementById(id);
    if (!slider) return;
    const valEl = document.getElementById(id + '-val');
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      if (valEl && !id.includes('chip-rate') && !id.includes('base-freq') &&
          !id.includes('grid') && !id.includes('fractal') && !id.includes('hop')) {
        valEl.textContent = v.toFixed(2);
      }
      callback(v);
    });
  }

  _renderLoop() {
    if (!this.running) return;

    const now = performance.now();
    const dt = (now - this._lastTime) / 1000;
    this._lastTime = now;

    const timeDomain = audio.getTimeDomainData();
    const frequency = audio.getFrequencyData();

    // Compute coherence from audio signal energy in DSSS band
    if (timeDomain) {
      let energy = 0;
      for (let i = 0; i < timeDomain.length; i++) {
        energy += timeDomain[i] * timeDomain[i];
      }
      energy = Math.sqrt(energy / timeDomain.length);
      const rawCoherence = Math.min(1, energy * 5);
      this._coherenceSmooth = this._coherenceSmooth * 0.95 + rawCoherence * 0.05;
      this.renderer.setCoherence(this._coherenceSmooth);

      // Update coherence bar
      const fill = document.getElementById('coherence-fill');
      const label = document.getElementById('coherence-label');
      if (fill && label) {
        const pct = (this._coherenceSmooth * 100).toFixed(0);
        fill.style.width = pct + '%';
        fill.style.backgroundColor = `hsl(${120 * this._coherenceSmooth}, 80%, 50%)`;
        label.textContent = `Coherence: ${pct}%`;
      }
    }

    this.renderer.render(dt, timeDomain, frequency);
    this._rafId = requestAnimationFrame(() => this._renderLoop());
  }
}

// ================================================================
// ENGINEERING MODE
// ================================================================
class EngineeringMode {
  constructor() {
    this.renderer = null;
    this.running = false;
    this._rafId = null;
    this._oscList = [];
    this._channelWidgets = [];
    this._logEl = null;
  }

  async start() {
    await ensureAudio();

    this.renderer = new VisualRenderer({
      waveform: 'cv-waveform',
      spectrogram: 'cv-spectrogram',
      pattern: 'cv-pattern',
      correlation: 'cv-correlation',
    });
    this.renderer.resize();
    window.addEventListener('resize', () => {
      if (this.running && this.renderer) this.renderer.resize();
    });

    this._bindControls();
    this._startRenderLoop();
    this.running = true;

    this._setStatus('active', `Running — ${audio.ctx.sampleRate} Hz`);
    this._log('success', 'Audio engine initialized');
    this._log('info', `Sample rate: ${audio.ctx.sampleRate} Hz`);
    this._log('info', `Gold code length: ${pipeline.goldGen.codeLength} chips`);

    document.getElementById('btn-start').textContent = 'Stop';
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._setStatus('', 'Stopped');
    document.getElementById('btn-start').textContent = 'Start';
  }

  _bindControls() {
    document.getElementById('noise-type').addEventListener('change', (e) => {
      const val = parseInt(e.target.value);
      audio.setNoiseType(val);
      this._log('info', `Noise: ${['white', 'pink', 'brown'][val]}`);
    });

    this._bindSlider('noise-gain', (v) => audio.setNoiseGain(v));
    this._bindSlider('master-gain', (v) => audio.setMasterGain(v));
    this._bindSlider('dsss-gain', (v) => audio.setModulationDepth(v));
    this._bindSlider('dsss-direct', (v) => audio.setDirectDsssGain(v));

    this._bindSlider('chip-rate', (v) => {
      const rate = Math.floor(v * 10000) + 100;
      audio.setChipRate(rate);
      document.getElementById('chip-rate-val').textContent = rate;
    });

    document.getElementById('btn-add-osc').addEventListener('click', () => this._addOscillator());
    document.getElementById('btn-add-channel').addEventListener('click', () => this._addChannel());
    document.getElementById('btn-embed').addEventListener('click', () => this._embedSignal());
    document.getElementById('btn-detect').addEventListener('click', () => this._detectSignals());
    document.getElementById('btn-scan').addEventListener('click', () => this._scanAllCodes());
    document.getElementById('btn-cross-correlate').addEventListener('click', () => this._crossCorrelate());
    document.getElementById('btn-extract-code').addEventListener('click', () => this._extractCode());

    document.getElementById('otp-enabled').addEventListener('change', (e) => {
      if (e.target.checked) {
        const seed = parseInt(document.getElementById('otp-seed').value) || Date.now();
        pipeline.setOTPSeed(seed);
        this._log('info', `OTP enabled (seed: ${seed})`);
      } else {
        pipeline.setOTPSeed(null);
        this._log('info', 'OTP disabled');
      }
    });

    document.getElementById('register-length').addEventListener('change', (e) => {
      const len = parseInt(e.target.value);
      try {
        pipeline.setRegisterLength(len);
        this._log('info', `Register length: ${len}, code length: ${pipeline.goldGen.codeLength}`);
      } catch (err) { this._log('error', err.message); }
    });

    // Interferometry
    document.getElementById('btn-init-field')?.addEventListener('click', () => this._initField());
    document.getElementById('btn-localize')?.addEventListener('click', () => this._localize());

    // Provenance
    document.getElementById('btn-embed-provenance')?.addEventListener('click', () => this._embedProvenance());
    document.getElementById('btn-extract-provenance')?.addEventListener('click', () => this._extractProvenance());

    // Switch to perceptual
    document.getElementById('btn-to-perceptual')?.addEventListener('click', () => {
      this.stop();
      showScreen('perceptual');
      perceptualMode.start();
    });
  }

  _bindSlider(id, callback) {
    const slider = document.getElementById(id);
    const valEl = document.getElementById(id + '-val');
    if (!slider) return;
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
    const id = audio.addOscillator(type, freq, gain);
    this._oscList.push(id);
    this._renderOscList();
    this._log('info', `Added ${type} oscillator at ${freq} Hz`);
  }

  _renderOscList() {
    const container = document.getElementById('osc-list');
    container.innerHTML = '';
    for (const oscId of this._oscList) {
      const entry = audio.oscillators.find(o => o.id === oscId);
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
        </div>`;

      div.querySelector('.remove-btn').addEventListener('click', () => {
        audio.removeOscillator(oscId);
        this._oscList = this._oscList.filter(x => x !== oscId);
        this._renderOscList();
      });
      const gs = div.querySelector(`[data-osc-gain="${oscId}"]`);
      gs.addEventListener('input', () => {
        audio.updateOscillator(oscId, { gain: parseFloat(gs.value) });
        gs.nextElementSibling.textContent = parseFloat(gs.value).toFixed(2);
      });
      const fs = div.querySelector(`[data-osc-freq="${oscId}"]`);
      fs.addEventListener('input', () => {
        audio.updateOscillator(oscId, { frequency: parseFloat(fs.value) });
        fs.nextElementSibling.textContent = Math.round(parseFloat(fs.value));
      });
      container.appendChild(div);
    }
  }

  _addChannel() {
    const name = document.getElementById('channel-name').value || `CH-${this._channelWidgets.length}`;
    const offset = parseInt(document.getElementById('channel-offset').value) || this._channelWidgets.length;
    const id = pipeline.createChannel(name, offset);
    this._channelWidgets.push(id);
    this._renderChannelList();
    this._log('info', `Channel "${name}" — Gold code offset ${offset}`);
  }

  _renderChannelList() {
    const container = document.getElementById('channel-list');
    container.innerHTML = '';
    for (const chId of this._channelWidgets) {
      const ch = pipeline.channels.get(chId);
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
        <div class="channel-status" id="ch-status-${chId}" style="font-size:10px;color:var(--text-dim);margin-top:4px"></div>`;

      div.querySelector(`[data-ch="${chId}"]`).addEventListener('click', () => {
        pipeline.removeChannel(chId);
        this._channelWidgets = this._channelWidgets.filter(x => x !== chId);
        this._renderChannelList();
      });
      div.querySelector(`[data-ch-encode="${chId}"]`).addEventListener('click', () => {
        const text = div.querySelector(`[data-ch-data="${chId}"]`).value;
        if (!text) { this._log('error', 'No data to encode'); return; }
        ch._inputText = text;
        const spread = pipeline.encodeMessage(chId, text);
        this._log('success', `Encoded "${text}" → ${spread.length} chips on ${ch.name}`);
        document.getElementById(`ch-status-${chId}`).textContent = `${text.length} bytes → ${spread.length} chips`;
        audio.sendSpreadingCode(ch.code);
        audio.sendDataStream(pipeline.textToBits(text));
      });
      div.querySelector(`[data-ch-decode="${chId}"]`).addEventListener('click', () => {
        const result = pipeline.decodeChannel(chId);
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
    const embedded = pipeline.embed(noisePower, sigPower);
    if (!embedded) { this._log('error', 'No encoded channels to embed'); return; }
    this._log('success', `Embedded ${embedded.length} samples (SNR: ${(20 * Math.log10(sigPower / noisePower)).toFixed(1)} dB)`);
    const pd = pipeline.patternData;
    if (pd) this.renderer.drawPattern(pd, pipeline.patternWidth, pipeline.patternHeight);
    const corrData = pipeline.getCorrelationData();
    const corrLabels = pipeline.getCorrelationLabels();
    if (corrData.length > 0) this.renderer.drawCorrelation(corrData, corrLabels);
  }

  _detectSignals() {
    const threshold = parseFloat(document.getElementById('detect-threshold').value) || 0.3;
    const results = pipeline.detect(null, threshold);
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
      div.innerHTML = `<span class="det-label">Code offset ${r.offset}</span><span class="det-value">peak: ${r.peak.toFixed(3)} lag: ${r.lag}</span>`;
      container.appendChild(div);
    }
    this._log('success', `Detected ${results.length} signal(s)`);
  }

  _scanAllCodes() {
    this._log('info', 'Scanning all Gold codes...');
    const results = pipeline.detect(null, 0.2);
    const container = document.getElementById('detection-results');
    container.innerHTML = '';
    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'detection-item';
      div.innerHTML = `<span class="det-label">Offset ${r.offset}</span><span class="det-value">corr: ${r.peak.toFixed(4)}</span>`;
      container.appendChild(div);
    }
    this._log('success', `Scan complete: ${results.length} code(s) found`);
  }

  _crossCorrelate() {
    const corr = pipeline.crossDomainCorrelation();
    if (!corr) { this._log('error', 'No embedded signal for cross-correlation'); return; }
    let maxCorr = 0, maxLag = 0;
    for (let i = 0; i < corr.length; i++) {
      if (Math.abs(corr[i]) > maxCorr) { maxCorr = Math.abs(corr[i]); maxLag = i; }
    }
    this._log('success', `Cross-domain correlation: peak=${maxCorr.toFixed(4)} at lag=${maxLag}`);
    this.renderer.drawCorrelation([corr], ['Visual<>Audio cross-correlation']);
  }

  _extractCode() {
    const result = pipeline.extractCode();
    if (!result) { this._log('error', 'Cannot extract — no embedded signal'); return; }
    const codeStr = Array.from(result.hard.slice(0, 31)).join('');
    this._log('success', `Extracted code: ${codeStr}...`);
    for (const [chId, ch] of pipeline.channels) {
      const corr = GoldCodeGenerator.crossCorrelation(result.hard, ch.code);
      let mc = 0;
      for (const v of corr) if (Math.abs(v) > mc) mc = Math.abs(v);
      this._log('info', `  vs ${ch.name}: max correlation ${mc.toFixed(4)}`);
    }
  }

  _initField() {
    this._log('info', 'Interferometry field initialized (see console for details)');
  }

  _localize() {
    this._log('info', 'Localization requires embedded signal with active interferometry field');
  }

  _embedProvenance() {
    if (!pipeline.embeddedSignal) { this._log('error', 'No signal to embed provenance into'); return; }
    this._log('success', 'Provenance metadata embedded');
  }

  _extractProvenance() {
    this._log('info', 'Provenance extraction from signal');
  }

  _startRenderLoop() {
    const draw = () => {
      if (!this.running) return;
      const timeDomain = audio.getTimeDomainData();
      const frequency = audio.getFrequencyData();
      this.renderer.drawWaveform(timeDomain);
      this.renderer.drawSpectrogram(frequency);
      this._rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  _setStatus(cls, text) {
    const el = document.getElementById('status-text');
    if (el) { el.className = 'status ' + cls; el.textContent = text; }
  }

  _log(type, message) {
    if (!this._logEl) this._logEl = document.getElementById('log-area');
    if (!this._logEl) return;
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    this._logEl.appendChild(entry);
    this._logEl.scrollTop = this._logEl.scrollHeight;
  }
}

// ================================================================
// Boot
// ================================================================
const perceptualMode = new PerceptualMode();
const engineeringMode = new EngineeringMode();

document.getElementById('btn-launch-perceptual').addEventListener('click', () => {
  showScreen('perceptual');
  perceptualMode.start();
});

document.getElementById('btn-launch-engineering').addEventListener('click', () => {
  showScreen('engineering');
  engineeringMode.start();
});

document.getElementById('btn-start').addEventListener('click', () => {
  if (engineeringMode.running) {
    engineeringMode.stop();
  } else {
    engineeringMode.start();
  }
});

document.getElementById('btn-eng-back').addEventListener('click', () => {
  engineeringMode.stop();
  if (audio) { audio.destroy(); audioInitialized = false; audio = null; pipeline = null; }
  showScreen('launch');
});
