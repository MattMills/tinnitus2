# TINNITUS

Cross-modal entropic identity signal toolkit. Generates synchronized audio and visual patterns that encode the same spreading code structure — the complete signal exists only in the act of integrating both modalities simultaneously.

**[Live Demo](https://mattmills.github.io/tinnitus2/)** — open on phone with earbuds for perceptual mode.

## What it does

TINNITUS embeds data into noise using spread-spectrum techniques (DSSS with Gold codes), then presents that noise-embedded signal through both audio and visual channels simultaneously. The spreading code shapes the noise itself — the code IS the noise structure. Neither channel alone contains the full signal. Cross-modal integration is required to perceive the correlation.

The system auto-generates a unique identity seed from physical entropy, stores it in the browser, and continuously accretes entropy from every available sensor — accelerometer, gyroscope, microphone, touch timing, GPS, Bitcoin transactions, NIST randomness beacon. The identity strengthens with every moment of use.

## Two modes

### Perceptual Mode (phone + earbuds)
Full-screen immersive experience. 9 visual layers encode the same entropic data stream in different geometries — grid, concentric rings, code circle, waveform ring, spirals, particles, frequency bars, Lissajous curves, and a scrolling text overlay. Audio is pink noise amplitude-modulated by the DSSS spreading code at chip rates tuned for unconscious cross-modal integration (20-100 Hz).

- **Seed crystal** auto-generates on first use from `crypto.getRandomValues`
- **Phrase** rotates every 30 seconds, **seed** every 2 minutes, **OTP layer** every 60 seconds
- **User seed overlay** — type any text to XOR an intentional signal on top of the entropic base
- **Device fingerprint** (UUID, screen, cores, touch points) embedded in the data stream
- **10 live entropy sources** feeding the identity continuously
- Every layer has independent enable/opacity/scale controls

### Engineering Mode (desktop)
Full signal processing workbench with noise generators (white/pink/brown), tone oscillators (sine/square/sawtooth/triangle), DSSS modulator, multi-channel encoding, real-time spectrogram/waveform/pattern/correlation displays, detection, and code extraction.

## Architecture

```
22 source files, ~7,200 lines, zero dependencies, pure browser ES modules
```

### Signal Processing (`js/signal/`)
| Module | Purpose |
|--------|---------|
| `gold-codes.js` | Gold code generator from maximal-length LFSR pairs (5/7/10-bit registers) |
| `fec.js` | Rate-1/2 convolutional encoder (K=3) with Viterbi decoder + block interleaver |
| `otp.js` | xoshiro128** PRNG-based one-time pad with encrypt/decrypt/seek |
| `spreader.js` | Full DSSS pipeline: data → FEC → interleave → OTP → spread/despread |
| `fractal-codes.js` | Multi-scale Gold code decomposition using GF(2^8) Shamir secret sharing |
| `meta-layer.js` | RNG-driven code configuration evolution at geometrically spaced timescales |
| `entropy-engine.js` | Progressive FEC stacking — finds structure at 8 algebraic bases, replaces with entropy |
| `rng-manifold.js` | N-dimensional self-interacting RNG with topology twisting and worldpath recording |

### Audio (`js/audio/`)
| Module | Purpose |
|--------|---------|
| `noise-processor.js` | AudioWorklet: white, pink (Voss-McCartney), brown noise generation |
| `dsss-processor.js` | AudioWorklet: real-time DSSS chip modulation, outputs silence when cleared |
| `engine.js` | Web Audio graph — DSSS modulates noise via GainNode AudioParam connection |

### Engine (`js/engine/`)
| Module | Purpose |
|--------|---------|
| `correlator.js` | Radix-2 FFT, O(N log N) cross-correlation, Gold code detection, code extraction |
| `pipeline.js` | Multi-channel encode/embed/detect/extract orchestration |
| `interferometry.js` | N-source spatial field — signal superposition encodes receiver position |
| `provenance.js` | Spatial-temporal fingerprint embedding and worldpath tracking |
| `seed-crystal.js` | localStorage identity persistence with auto-rotating seeds/phrases/OTP |
| `identity-mesh.js` | Holographic identity from shared rules + private accreted entropy |
| `sensor-harvest.js` | 10 live entropy sources: sensors, timing jitter, blockchain, NIST beacon |

### Visual (`js/visual/`)
| Module | Purpose |
|--------|---------|
| `visualizer.js` | 9-layer renderer: grid, rings, spirals, particles, bars, Lissajous, text stream |
| `renderer.js` | Engineering mode: spectrogram, waveform, entropy pattern, correlation display |
| `perceptual.js` | Audio tuner for perceptual mode (noise modulation depth, tone, levels) |

## Entropy Sources

| Source | API | Rate | Default |
|--------|-----|------|---------|
| Accelerometer | DeviceMotion | ~60 Hz | On |
| Gyroscope | DeviceOrientation | ~60 Hz | On |
| Microphone | MediaDevices | 10 Hz | Off |
| Touch jitter | touchmove/pointermove | Per-event | On |
| GPS | Geolocation | Per-update | Off |
| Battery | Battery API | On-change | On |
| Frame jitter | requestAnimationFrame | ~60 Hz | On |
| Network timing | fetch HEAD RTT | Every 5s | On |
| Bitcoin chain | WebSocket blockchain.info | ~3/s | On |
| NIST Beacon | REST beacon.nist.gov | Every 60s | On |

## Running locally

```bash
# Any static file server works — no build step
python3 -m http.server 8080
# Open http://localhost:8080
```

## How the audio-visual binding works

1. A Gold code family is generated from the identity seed
2. The current phrase is encoded: text → FEC → interleave → OTP → DSSS spread
3. The spread signal amplitude-modulates pink noise through a Web Audio GainNode
4. The same Gold code drives visual layer cell states, ring rotations, spiral tightness
5. The cross-correlation between audio envelope and visual pattern IS the signal
6. That correlation has no physical location — it exists only in the act of integration

## Key concepts

**Spreading code modulates noise** — the DSSS chips shape the noise amplitude envelope. No separate chirp. The code is the noise structure.

**Fractal code hierarchy** — Gold codes decomposed across timescales using Shamir secret sharing. Fewer than K-of-N levels produce anti-correlated garbage. Only the full integration reconstructs.

**Progressive anti-entropy** — stacked FEC decoders find structure at different algebraic bases and replace it with verified randomness. Each layer strips a different class of predictability.

**Self-interacting RNG manifold** — N coupled PRNGs whose topology evolves. The trajectory through state space is deterministic from the seed but computationally irreducible.

**Holographic identity** — shared deterministic rules + private accreted entropy. The exchange pattern between identities IS the identity proof. Strengthens over time.

**Interferometry** — N broadcast sources create a spatial interference field. The effective Gold code at any position is unique. Captured signals self-report their capture geometry.

## Documentation

- [`docs/perceptual-mode-integration.md`](docs/perceptual-mode-integration.md) — Expert committee analysis on cross-modal entropic identity binding from neuroscience, signal processing, psychoacoustics, cryptography, and contemplative neuroscience perspectives.
