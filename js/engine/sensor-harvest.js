// Live Sensor Entropy Harvester
//
// Collects entropy from every available sensor and external source,
// feeding it into the seed crystal's accretion system.  Each source
// is independently toggleable and reports its contribution rate.
//
// Browser sensors:
//   - DeviceMotion (accelerometer + gyroscope)
//   - DeviceOrientation (tilt)
//   - Microphone (ambient acoustic noise)
//   - Touch/pointer jitter
//   - Geolocation
//   - Battery state
//
// Timing entropy:
//   - requestAnimationFrame jitter
//   - Network fetch round-trip timing
//
// External sources (WebSocket / fetch):
//   - Bitcoin blockchain transactions (wss://ws.blockchain.info/inv)
//   - NIST Randomness Beacon (public API, polled every 60s)

export class SensorHarvester {
  constructor() {
    this.sources = {
      motion:      { enabled: true,  active: false, bits: 0, label: 'Accelerometer' },
      orientation: { enabled: true,  active: false, bits: 0, label: 'Gyroscope' },
      microphone:  { enabled: false, active: false, bits: 0, label: 'Microphone' },
      touch:       { enabled: true,  active: false, bits: 0, label: 'Touch Jitter' },
      geolocation: { enabled: false, active: false, bits: 0, label: 'GPS' },
      battery:     { enabled: true,  active: false, bits: 0, label: 'Battery' },
      frameTiming: { enabled: true,  active: false, bits: 0, label: 'Frame Jitter' },
      networkTiming:{ enabled: true, active: false, bits: 0, label: 'Net Timing' },
      blockchain:  { enabled: true,  active: false, bits: 0, label: 'BTC Chain' },
      nistBeacon:  { enabled: true,  active: false, bits: 0, label: 'NIST Beacon' },
    };

    this._callbacks = [];     // entropy consumers
    this._accumulator = 0;
    this._pool = new Uint32Array(16);
    this._poolIdx = 0;

    // Sensor state
    this._motionHandler = null;
    this._orientHandler = null;
    this._touchHandler = null;
    this._micStream = null;
    this._micAnalyser = null;
    this._micCtx = null;
    this._geoWatchId = null;
    this._blockchainWs = null;
    this._nistInterval = null;
    this._frameTimingRaf = null;
    this._netTimingInterval = null;
    this._lastFrameTime = 0;
    this._running = false;
  }

  // Register a callback that receives harvested entropy
  onEntropy(callback) {
    this._callbacks.push(callback);
  }

  _emit(sourceName, value) {
    const v = value >>> 0;
    this._accumulator = (this._accumulator ^ v) >>> 0;
    this._accumulator = Math.imul(this._accumulator, 0x9e3779b9) >>> 0;

    // Mix into pool
    this._pool[this._poolIdx] ^= v;
    this._poolIdx = (this._poolIdx + 1) % this._pool.length;

    if (this.sources[sourceName]) {
      this.sources[sourceName].bits += 32;
      this.sources[sourceName].active = true;
    }

    for (const cb of this._callbacks) {
      cb(this._accumulator, sourceName);
    }
  }

  async startAll() {
    this._running = true;
    if (this.sources.motion.enabled) this._startMotion();
    if (this.sources.orientation.enabled) this._startOrientation();
    if (this.sources.microphone.enabled) this._startMicrophone();
    if (this.sources.touch.enabled) this._startTouch();
    if (this.sources.geolocation.enabled) this._startGeolocation();
    if (this.sources.battery.enabled) this._startBattery();
    if (this.sources.frameTiming.enabled) this._startFrameTiming();
    if (this.sources.networkTiming.enabled) this._startNetworkTiming();
    if (this.sources.blockchain.enabled) this._startBlockchain();
    if (this.sources.nistBeacon.enabled) this._startNistBeacon();
  }

  stopAll() {
    this._running = false;
    this._stopMotion();
    this._stopOrientation();
    this._stopMicrophone();
    this._stopTouch();
    this._stopGeolocation();
    this._stopFrameTiming();
    this._stopNetworkTiming();
    this._stopBlockchain();
    this._stopNistBeacon();
  }

  setSourceEnabled(name, enabled) {
    if (!this.sources[name]) return;
    this.sources[name].enabled = enabled;
    if (!this._running) return;

    const startMap = {
      motion: () => this._startMotion(),
      orientation: () => this._startOrientation(),
      microphone: () => this._startMicrophone(),
      touch: () => this._startTouch(),
      geolocation: () => this._startGeolocation(),
      battery: () => this._startBattery(),
      frameTiming: () => this._startFrameTiming(),
      networkTiming: () => this._startNetworkTiming(),
      blockchain: () => this._startBlockchain(),
      nistBeacon: () => this._startNistBeacon(),
    };
    const stopMap = {
      motion: () => this._stopMotion(),
      orientation: () => this._stopOrientation(),
      microphone: () => this._stopMicrophone(),
      touch: () => this._stopTouch(),
      geolocation: () => this._stopGeolocation(),
      frameTiming: () => this._stopFrameTiming(),
      networkTiming: () => this._stopNetworkTiming(),
      blockchain: () => this._stopBlockchain(),
      nistBeacon: () => this._stopNistBeacon(),
    };

    if (enabled) startMap[name]?.();
    else stopMap[name]?.();
  }

  getStatus() {
    const result = {};
    for (const [name, src] of Object.entries(this.sources)) {
      result[name] = {
        label: src.label,
        enabled: src.enabled,
        active: src.active,
        bitsHarvested: src.bits,
      };
    }
    return result;
  }

  getPoolEntropy() {
    let h = 0x811c9dc5;
    for (let i = 0; i < this._pool.length; i++) {
      h ^= this._pool[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // --- DeviceMotion (accelerometer + gyroscope) ---
  _startMotion() {
    if (this._motionHandler) return;
    this._motionHandler = (e) => {
      const a = e.acceleration || {};
      const r = e.rotationRate || {};
      const v = Math.floor(
        ((a.x || 0) * 10000) ^
        ((a.y || 0) * 10000) ^
        ((a.z || 0) * 10000) ^
        ((r.alpha || 0) * 1000) ^
        ((r.beta || 0) * 1000) ^
        ((r.gamma || 0) * 1000) ^
        (performance.now() * 1000)
      );
      this._emit('motion', v);
    };
    window.addEventListener('devicemotion', this._motionHandler);
    // Request permission on iOS 13+
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
      DeviceMotionEvent.requestPermission().catch(() => {});
    }
  }

  _stopMotion() {
    if (this._motionHandler) {
      window.removeEventListener('devicemotion', this._motionHandler);
      this._motionHandler = null;
    }
    this.sources.motion.active = false;
  }

  // --- DeviceOrientation ---
  _startOrientation() {
    if (this._orientHandler) return;
    this._orientHandler = (e) => {
      const v = Math.floor(
        ((e.alpha || 0) * 10000) ^
        ((e.beta || 0) * 10000) ^
        ((e.gamma || 0) * 10000) ^
        (performance.now() * 100)
      );
      this._emit('orientation', v);
    };
    window.addEventListener('deviceorientation', this._orientHandler);
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      DeviceOrientationEvent.requestPermission().catch(() => {});
    }
  }

  _stopOrientation() {
    if (this._orientHandler) {
      window.removeEventListener('deviceorientation', this._orientHandler);
      this._orientHandler = null;
    }
    this.sources.orientation.active = false;
  }

  // --- Microphone (ambient acoustic noise) ---
  async _startMicrophone() {
    if (this._micStream) return;
    try {
      this._micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._micCtx = new AudioContext();
      const source = this._micCtx.createMediaStreamSource(this._micStream);
      this._micAnalyser = this._micCtx.createAnalyser();
      this._micAnalyser.fftSize = 256;
      source.connect(this._micAnalyser);

      const buf = new Float32Array(this._micAnalyser.fftSize);
      const sample = () => {
        if (!this._micAnalyser || !this._running) return;
        this._micAnalyser.getFloatTimeDomainData(buf);
        // Hash the audio buffer — raw ambient noise
        let h = 0;
        for (let i = 0; i < buf.length; i += 4) {
          h ^= Math.floor(buf[i] * 0x7FFFFFFF);
        }
        this._emit('microphone', h ^ Math.floor(performance.now() * 1000));
        setTimeout(sample, 100);
      };
      sample();
      this.sources.microphone.active = true;
    } catch (e) {
      this.sources.microphone.active = false;
    }
  }

  _stopMicrophone() {
    if (this._micStream) {
      this._micStream.getTracks().forEach(t => t.stop());
      this._micStream = null;
    }
    if (this._micCtx) {
      this._micCtx.close().catch(() => {});
      this._micCtx = null;
      this._micAnalyser = null;
    }
    this.sources.microphone.active = false;
  }

  // --- Touch / Pointer jitter ---
  _startTouch() {
    if (this._touchHandler) return;
    this._touchHandler = (e) => {
      const t = e.touches?.[0] || e;
      const v = Math.floor(
        (t.clientX * 10000) ^
        (t.clientY * 10000) ^
        ((t.force || 0) * 100000) ^
        (performance.now() * 10000)
      );
      this._emit('touch', v);
    };
    window.addEventListener('touchmove', this._touchHandler, { passive: true });
    window.addEventListener('pointermove', this._touchHandler, { passive: true });
  }

  _stopTouch() {
    if (this._touchHandler) {
      window.removeEventListener('touchmove', this._touchHandler);
      window.removeEventListener('pointermove', this._touchHandler);
      this._touchHandler = null;
    }
    this.sources.touch.active = false;
  }

  // --- Geolocation ---
  _startGeolocation() {
    if (this._geoWatchId !== null) return;
    if (!navigator.geolocation) return;
    try {
      this._geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          const v = Math.floor(
            (pos.coords.latitude * 1e7) ^
            (pos.coords.longitude * 1e7) ^
            ((pos.coords.altitude || 0) * 1000) ^
            ((pos.coords.accuracy || 0) * 100) ^
            (pos.timestamp & 0xFFFFFFFF)
          );
          this._emit('geolocation', v);
          this.sources.geolocation.active = true;
        },
        () => { this.sources.geolocation.active = false; },
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
    } catch (e) {
      this.sources.geolocation.active = false;
    }
  }

  _stopGeolocation() {
    if (this._geoWatchId !== null) {
      navigator.geolocation?.clearWatch(this._geoWatchId);
      this._geoWatchId = null;
    }
    this.sources.geolocation.active = false;
  }

  // --- Battery ---
  async _startBattery() {
    try {
      if (!navigator.getBattery) return;
      const battery = await navigator.getBattery();
      const sample = () => {
        const v = Math.floor(
          (battery.level * 100000) ^
          (battery.charging ? 0xAAAAAAAA : 0x55555555) ^
          (performance.now() * 1000)
        );
        this._emit('battery', v);
        this.sources.battery.active = true;
      };
      battery.addEventListener('levelchange', sample);
      battery.addEventListener('chargingchange', sample);
      sample();
    } catch (e) {
      this.sources.battery.active = false;
    }
  }

  // --- Frame Timing Jitter ---
  _startFrameTiming() {
    if (this._frameTimingRaf) return;
    this._lastFrameTime = performance.now();
    const tick = () => {
      if (!this._running || !this.sources.frameTiming.enabled) {
        this._frameTimingRaf = null;
        return;
      }
      const now = performance.now();
      const delta = now - this._lastFrameTime;
      // The fractional microsecond jitter is the entropy
      const jitter = Math.floor((delta % 1) * 1e9);
      this._emit('frameTiming', jitter ^ Math.floor(now * 1000));
      this._lastFrameTime = now;
      this._frameTimingRaf = requestAnimationFrame(tick);
    };
    this._frameTimingRaf = requestAnimationFrame(tick);
    this.sources.frameTiming.active = true;
  }

  _stopFrameTiming() {
    if (this._frameTimingRaf) {
      cancelAnimationFrame(this._frameTimingRaf);
      this._frameTimingRaf = null;
    }
    this.sources.frameTiming.active = false;
  }

  // --- Network Timing (fetch RTT jitter) ---
  _startNetworkTiming() {
    if (this._netTimingInterval) return;
    const measure = async () => {
      try {
        const t0 = performance.now();
        // Fetch a tiny resource — we only care about the timing, not the content
        await fetch('index.html', { method: 'HEAD', cache: 'no-store' });
        const rtt = performance.now() - t0;
        const jitter = Math.floor((rtt % 1) * 1e9) ^ Math.floor(rtt * 10000);
        this._emit('networkTiming', jitter);
        this.sources.networkTiming.active = true;
      } catch (e) {
        this.sources.networkTiming.active = false;
      }
    };
    measure();
    this._netTimingInterval = setInterval(measure, 5000);
  }

  _stopNetworkTiming() {
    if (this._netTimingInterval) {
      clearInterval(this._netTimingInterval);
      this._netTimingInterval = null;
    }
    this.sources.networkTiming.active = false;
  }

  // --- Bitcoin Blockchain WebSocket (real-time transaction hashes) ---
  _startBlockchain() {
    if (this._blockchainWs) return;
    try {
      this._blockchainWs = new WebSocket('wss://ws.blockchain.info/inv');
      this._blockchainWs.onopen = () => {
        this._blockchainWs.send(JSON.stringify({ op: 'unconfirmed_sub' }));
        this.sources.blockchain.active = true;
      };
      this._blockchainWs.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          const hash = data.x?.hash || '';
          // Hash the transaction hash into 32 bits
          let h = 0x811c9dc5;
          for (let i = 0; i < hash.length; i++) {
            h ^= hash.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
          }
          this._emit('blockchain', h ^ Math.floor(performance.now() * 1000));
        } catch (err) {}
      };
      this._blockchainWs.onerror = () => {
        this.sources.blockchain.active = false;
      };
      this._blockchainWs.onclose = () => {
        this.sources.blockchain.active = false;
        this._blockchainWs = null;
        // Reconnect after delay if still enabled
        if (this._running && this.sources.blockchain.enabled) {
          setTimeout(() => this._startBlockchain(), 10000);
        }
      };
    } catch (e) {
      this.sources.blockchain.active = false;
    }
  }

  _stopBlockchain() {
    if (this._blockchainWs) {
      this._blockchainWs.close();
      this._blockchainWs = null;
    }
    this.sources.blockchain.active = false;
  }

  // --- NIST Randomness Beacon (polled every 60s) ---
  _startNistBeacon() {
    if (this._nistInterval) return;
    const fetch_beacon = async () => {
      try {
        const t0 = performance.now();
        const resp = await fetch('https://beacon.nist.gov/beacon/2.0/pulse/last');
        const rtt = performance.now() - t0;
        const data = await resp.json();
        const outputValue = data.pulse?.outputValue || '';
        // Hash the 512-bit beacon output
        let h = 0x811c9dc5;
        for (let i = 0; i < outputValue.length; i++) {
          h ^= outputValue.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        // Mix in the fetch RTT jitter
        h ^= Math.floor(rtt * 10000);
        this._emit('nistBeacon', h);
        this.sources.nistBeacon.active = true;
      } catch (e) {
        this.sources.nistBeacon.active = false;
      }
    };
    fetch_beacon();
    this._nistInterval = setInterval(fetch_beacon, 60000);
  }

  _stopNistBeacon() {
    if (this._nistInterval) {
      clearInterval(this._nistInterval);
      this._nistInterval = null;
    }
    this.sources.nistBeacon.active = false;
  }
}
