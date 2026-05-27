// Seed Crystal — persistent identity state stored in localStorage
//
// On first use, generates random seeds from crypto.getRandomValues (true
// physical entropy from the browser's OS-level entropy pool).  These become
// the "seed crystal" — the initial entropic commitment that all future
// identity evolution grows from.
//
// Stores and rotates:
//   - masterSeed: primary identity seed (generated once, never changes)
//   - activeSeed: currently active Gold code seed (rotates periodically)
//   - phraseHistory: evolving phrases that encode into the data stream
//   - otpSeeds: array of OTP key streams for multi-layer encryption
//   - accretionLog: accumulated entropy commitments over time
//   - sessionCount: how many times the identity has been activated
//   - worldpathCheckpoints: coarse-grain identity trajectory
//
// The crystal accretes entropy from each session — touch timing, audio
// coherence measurements, the act of interacting with the system.  The
// identity strengthens over time.  It cannot be replicated without the
// full localStorage state.

const STORAGE_KEY = 'tinnitus_seed_crystal';
const MAX_OTP_SEEDS = 8;
const MAX_PHRASE_HISTORY = 64;
const MAX_ACCRETIONS = 256;
const MAX_CHECKPOINTS = 128;

function cryptoRandom32() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
}

function cryptoRandomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

// Word lists for phrase generation (compact, high-entropy-per-word)
const NOUNS = [
  'river','stone','flame','wind','frost','shadow','light','wave',
  'root','seed','mirror','echo','spiral','gate','bridge','tower',
  'void','pulse','thread','knot','shard','bloom','drift','fold',
  'ridge','vale','peak','shore','field','cloud','storm','dusk',
  'dawn','moth','raven','wolf','fox','oak','ash','thorn',
  'iron','salt','bone','silk','glass','clay','amber','jade',
];

const ADJECTIVES = [
  'quiet','bright','deep','still','sharp','swift','vast','thin',
  'dark','warm','cold','wild','calm','fierce','pale','clear',
  'dense','hollow','woven','broken','hidden','bound','free','young',
  'ancient','blind','keen','raw','soft','hard','strange','true',
];

const VERBS = [
  'falls','turns','grows','breaks','folds','weaves','burns','drifts',
  'holds','finds','keeps','sees','knows','feels','hears','speaks',
  'waits','moves','rests','rises','sinks','spins','bends','flows',
];

function generatePhrase(rng) {
  const pick = (arr) => arr[rng() % arr.length];
  const structures = [
    () => `${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(VERBS)}`,
    () => `the ${pick(NOUNS)} ${pick(VERBS)} ${pick(ADJECTIVES)}`,
    () => `${pick(NOUNS)} of ${pick(ADJECTIVES)} ${pick(NOUNS)}`,
    () => `${pick(ADJECTIVES)} ${pick(ADJECTIVES)} ${pick(NOUNS)}`,
    () => `where the ${pick(NOUNS)} ${pick(VERBS)}`,
    () => `${pick(NOUNS)} and ${pick(NOUNS)} ${pick(VERBS)}`,
  ];
  return structures[rng() % structures.length]();
}

export class SeedCrystal {
  constructor() {
    this._state = null;
    this._loaded = false;
    this._entropyAccumulator = 0;
    this._lastInteractionTime = 0;
  }

  // Load from localStorage or create fresh
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this._state = JSON.parse(raw);
        this._state.sessionCount = (this._state.sessionCount || 0) + 1;
        this._state.lastActivated = Date.now();
        this._loaded = true;
        this._save();
        return true;
      }
    } catch (e) {
      // Corrupted storage — regenerate
    }

    this._state = this._createFresh();
    this._loaded = true;
    this._save();
    return false;
  }

  _createFresh() {
    const masterSeed = cryptoRandom32();
    const otpSeeds = [];
    for (let i = 0; i < MAX_OTP_SEEDS; i++) {
      otpSeeds.push(cryptoRandom32());
    }

    const rng = () => cryptoRandom32();
    const initialPhrase = generatePhrase(rng);

    // Device UUID — persistent per-browser identity
    const deviceUUID = this._generateUUID();

    return {
      version: 2,
      masterSeed,
      activeSeed: masterSeed,
      otpSeeds,
      currentPhrase: initialPhrase,
      phraseHistory: [{ phrase: initialPhrase, timestamp: Date.now(), seed: masterSeed }],
      accretionLog: [],
      worldpathCheckpoints: [{
        timestamp: Date.now(),
        seed: masterSeed,
        event: 'genesis',
      }],
      sessionCount: 1,
      createdAt: Date.now(),
      lastActivated: Date.now(),
      phraseRotationInterval: 30000,
      seedRotationInterval: 120000,
      otpRotationInterval: 60000,
      lastPhraseRotation: Date.now(),
      lastSeedRotation: Date.now(),
      lastOtpRotation: Date.now(),
      activeOtpIndex: 0,
      deviceUUID,
      userSeed: null,              // user-provided overlay seed (text → hash)
      embedDeviceInfo: true,       // embed device fingerprint in data stream
    };
  }

  _generateUUID() {
    const buf = cryptoRandomBytes(16);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const hex = Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._state));
    } catch (e) {
      // Storage full or unavailable — continue without persistence
    }
  }

  // Get current identity parameters
  get masterSeed() { return this._state?.masterSeed || 0; }
  get activeSeed() {
    const base = this._state?.activeSeed || 0;
    const overlay = this._state?.userSeed || 0;
    return overlay ? ((base ^ overlay) >>> 0) : base;
  }
  get currentPhrase() { return this._state?.currentPhrase || 'identity'; }
  get activeOtpSeed() {
    const idx = this._state?.activeOtpIndex || 0;
    return this._state?.otpSeeds?.[idx] || 0;
  }
  get otpSeeds() { return this._state?.otpSeeds || []; }
  get sessionCount() { return this._state?.sessionCount || 0; }
  get age() { return Date.now() - (this._state?.createdAt || Date.now()); }
  get accretionDepth() { return this._state?.accretionLog?.length || 0; }
  get worldpath() { return this._state?.worldpathCheckpoints || []; }
  get deviceUUID() { return this._state?.deviceUUID || 'unknown'; }
  get embedDeviceInfo() { return this._state?.embedDeviceInfo !== false; }

  // Set user overlay seed (XORs with true active seed)
  setUserSeed(value) {
    if (!this._state) return;
    if (value === null || value === '' || value === undefined) {
      this._state.userSeed = null;
    } else if (typeof value === 'number') {
      this._state.userSeed = value >>> 0;
    } else {
      // Hash string to 32-bit seed
      this._state.userSeed = this._hashString(value);
    }
    this._save();
  }

  setEmbedDeviceInfo(enabled) {
    if (!this._state) return;
    this._state.embedDeviceInfo = !!enabled;
    this._save();
  }

  _hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // Build the full text payload for the data stream
  // Includes phrase + device info (if enabled) + user seed text
  buildDataPayload(userSeedText) {
    const parts = [this.currentPhrase];
    if (this.embedDeviceInfo) {
      parts.push(`uuid:${this.deviceUUID}`);
      parts.push(`session:${this.sessionCount}`);
      parts.push(`otp:${this._state?.activeOtpIndex || 0}`);
      parts.push(`t:${Date.now()}`);
      // Browser-available device signals
      if (typeof navigator !== 'undefined') {
        parts.push(`ua:${navigator.userAgent?.slice(0, 40) || '?'}`);
        parts.push(`lang:${navigator.language || '?'}`);
        parts.push(`cores:${navigator.hardwareConcurrency || '?'}`);
        parts.push(`touch:${navigator.maxTouchPoints || 0}`);
      }
      if (typeof screen !== 'undefined') {
        parts.push(`scr:${screen.width}x${screen.height}`);
      }
    }
    if (userSeedText) {
      parts.push(`msg:${userSeedText}`);
    }
    return parts.join('|');
  }

  // Build the description text that the visualizer scrolls
  buildDescriptionText() {
    return [
      'TINNITUS — Cross-Modal Entropic Identity Signal',
      '',
      'This signal exists fully in neither the visual nor the auditory',
      'domain alone. The complete signal is only recoverable through',
      'simultaneous integration of both modalities — a computation that',
      'only the global workspace of consciousness can perform.',
      '',
      'Audio: pink noise amplitude-modulated by DSSS spreading code',
      'Visual: geometric layers driven by the same Gold code family',
      'Cross-correlation between them IS the signal',
      '',
      'The spreading code is unique to this identity seed.',
      'FEC protects the embedded data across multiple algebraic bases.',
      'OTP encryption layers rotate continuously.',
      'The fractal code hierarchy decomposes across neural timescales.',
      '',
      `Device UUID: ${this.deviceUUID}`,
      `Session: #${this.sessionCount}`,
      `Created: ${new Date(this._state?.createdAt || 0).toISOString()}`,
      `Accretions: ${this.accretionDepth}`,
      `Worldpath: ${this.worldpath.length} checkpoints`,
      `OTP Layer: ${(this._state?.activeOtpIndex || 0) + 1}/${this.otpSeeds.length}`,
      '',
      `Current phrase: "${this.currentPhrase}"`,
      '',
      'Each layer encodes the same entropy in a different geometry.',
      'The code acts on the noise. The noise acts on the signal.',
      'Each observation of the signal accretes entropy into the identity.',
      'The identity strengthens with every moment of perception.',
      '',
      'To any observer without the spreading code,',
      'this is noise and random patterns.',
      'To the holder of the seed, it is self.',
    ];
  }

  // Called every frame — handles timed rotations
  tick(now) {
    if (!this._state) return null;
    let changed = false;

    // Phrase rotation
    if (now - this._state.lastPhraseRotation > this._state.phraseRotationInterval) {
      this.rotatePhrase();
      changed = true;
    }

    // Seed rotation
    if (now - this._state.lastSeedRotation > this._state.seedRotationInterval) {
      this.rotateSeed();
      changed = true;
    }

    // OTP rotation
    if (now - this._state.lastOtpRotation > this._state.otpRotationInterval) {
      this.rotateOtp();
      changed = true;
    }

    if (changed) this._save();
    return changed;
  }

  // Generate a new phrase from the current entropy state
  rotatePhrase() {
    // Derive RNG from active seed + timestamp (deterministic but evolving)
    let h = (this._state.activeSeed ^ Date.now()) >>> 0;
    const rng = () => {
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
      h = (h ^ (h >>> 16)) >>> 0;
      return h;
    };

    const newPhrase = generatePhrase(rng);
    this._state.currentPhrase = newPhrase;
    this._state.lastPhraseRotation = Date.now();

    this._state.phraseHistory.push({
      phrase: newPhrase,
      timestamp: Date.now(),
      seed: this._state.activeSeed,
    });
    if (this._state.phraseHistory.length > MAX_PHRASE_HISTORY) {
      this._state.phraseHistory.shift();
    }

    return newPhrase;
  }

  // Rotate the active seed (derived from master + entropy accumulator)
  rotateSeed() {
    let h = (this._state.masterSeed + this._entropyAccumulator + Date.now()) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    this._state.activeSeed = (h ^ (h >>> 16)) >>> 0;
    this._state.lastSeedRotation = Date.now();

    this._state.worldpathCheckpoints.push({
      timestamp: Date.now(),
      seed: this._state.activeSeed,
      event: 'seed-rotation',
      sessionCount: this._state.sessionCount,
    });
    if (this._state.worldpathCheckpoints.length > MAX_CHECKPOINTS) {
      this._state.worldpathCheckpoints.shift();
    }

    return this._state.activeSeed;
  }

  // Rotate OTP layer
  rotateOtp() {
    this._state.activeOtpIndex = (this._state.activeOtpIndex + 1) % this._state.otpSeeds.length;
    this._state.lastOtpRotation = Date.now();

    // Evolve the OTP seed we just rotated away from
    const prevIdx = (this._state.activeOtpIndex - 1 + this._state.otpSeeds.length) % this._state.otpSeeds.length;
    let h = (this._state.otpSeeds[prevIdx] ^ this._entropyAccumulator ^ Date.now()) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    this._state.otpSeeds[prevIdx] = (h ^ (h >>> 16)) >>> 0;

    return this._state.activeOtpIndex;
  }

  // Accrete entropy from user interaction (touch timing, coherence, etc.)
  accrete(entropyValue) {
    this._entropyAccumulator = (this._entropyAccumulator ^ (entropyValue >>> 0)) >>> 0;
    this._entropyAccumulator = Math.imul(this._entropyAccumulator, 0x9e3779b9) >>> 0;

    // Fold into master seed subtly (doesn't change it, enriches OTP pool)
    for (let i = 0; i < this._state.otpSeeds.length; i++) {
      this._state.otpSeeds[i] = (this._state.otpSeeds[i] ^ (this._entropyAccumulator >>> (i * 4))) >>> 0;
    }

    this._state.accretionLog.push({
      timestamp: Date.now(),
      value: this._entropyAccumulator,
    });
    if (this._state.accretionLog.length > MAX_ACCRETIONS) {
      this._state.accretionLog.shift();
    }
  }

  // Accrete from touch event timing (physical entropy)
  accreteTouch(event) {
    const now = performance.now();
    if (this._lastInteractionTime > 0) {
      const delta = Math.floor((now - this._lastInteractionTime) * 1000); // microsecond precision
      this.accrete(delta);
    }
    this._lastInteractionTime = now;
  }

  // Accrete from audio coherence measurement
  accreteCoherence(coherenceValue) {
    // Quantize coherence to integer, mix with high-res timer
    const quantized = Math.floor(coherenceValue * 100000);
    const timerBits = Math.floor(performance.now() * 1000) & 0xFFFF;
    this.accrete((quantized << 16) | timerBits);
  }

  // Get a summary for display
  getSummary() {
    return {
      masterSeed: this._state.masterSeed,
      activeSeed: this._state.activeSeed,
      currentPhrase: this._state.currentPhrase,
      activeOtpIndex: this._state.activeOtpIndex,
      sessionCount: this._state.sessionCount,
      accretionDepth: this._state.accretionLog.length,
      worldpathLength: this._state.worldpathCheckpoints.length,
      age: this.age,
      created: new Date(this._state.createdAt).toLocaleDateString(),
    };
  }

  // Export full state (for backup)
  export() {
    return JSON.stringify(this._state, null, 2);
  }

  // Import state (for restore)
  import(json) {
    try {
      const state = JSON.parse(json);
      if (state.version && state.masterSeed) {
        this._state = state;
        this._save();
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Nuclear option — destroy identity and regenerate
  reset() {
    localStorage.removeItem(STORAGE_KEY);
    this._state = this._createFresh();
    this._save();
  }
}
