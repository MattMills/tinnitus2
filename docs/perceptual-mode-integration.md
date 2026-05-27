# TINNITUS Perceptual Mode: Cross-Modal Entropic Identity Binding

## System Description

TINNITUS Perceptual Mode generates a continuous cross-modal signal that exists
fully in neither the visual nor the auditory domain alone. The complete signal
is only recoverable through simultaneous integration of both modalities — a
computation that, in a biological system, only the global workspace (the
integrative layer that binds conscious experience across senses) can perform.

The audio stream is pink noise whose amplitude envelope is shaped by a DSSS
spreading code (Gold codes at 20-100 Hz chip rates). The visual display is a
grid pattern whose cell states are driven by the same spreading code at the
same phase. Neither stream alone contains the full code — the audio carries the
temporal envelope, the visual carries the spatial mapping. The cross-correlation
between them is the signal. That correlation has no physical location. It exists
only in the act of integration.

The identity seed and phrase generate a unique Gold code family assignment, OTP
key stream, and fractal code hierarchy. The resulting signal is cryptographically
unique to the holder of the seed. The perceptual binding — the felt sense that
"these two streams belong together" — is the subjective experience of successful
cross-modal despreading performed by the nervous system's endogenous correlator.

---

## Expert Committee: Integration Recommendations

### 1. Neuroscience — Global Workspace & Cross-Modal Binding
*Perspective: Dr. A (Computational Neuroscience, Global Workspace Theory)*

The global workspace hypothesis (Baars, 1988; Dehaene & Naccache, 2001) holds
that conscious experience arises when specialized unconscious processors
broadcast to a shared workspace that integrates across modalities. The critical
property: the workspace sees what no individual processor sees alone.

**Recommendation: Exploit the workspace's unique integration capacity.**

The current system correlates visual and audio at a single timescale (the chip
rate). The workspace, however, integrates across MULTIPLE timescales
simultaneously — gamma binding (~40 Hz), theta phase (~4-8 Hz), alpha gating
(~10 Hz), and infra-slow fluctuations (~0.01-0.1 Hz). Each timescale in the
neural hierarchy integrates a different scope of information.

*Concrete integration:*

- **Layer the fractal code hierarchy onto neural timescale bands.** Level 0
  (finest) at 40 Hz matches gamma binding — the timescale at which the visual
  cortex and auditory cortex phase-lock. Level 1 at ~10 Hz matches alpha
  gating — the timescale at which attention selects what enters the workspace.
  Level 2 at ~4 Hz matches theta — the timescale of working memory integration.
  Level 3 at ~0.1 Hz matches infra-slow — the timescale of self-referential
  processing (the default mode network).

- **Make the cross-modal correlation visible ONLY at the workspace level.** At
  any single neural timescale, the visual and audio fractal levels should be
  oppositional (as the fractal code system already provides). Only when
  integrated across timescales — which requires the global workspace — do the
  levels reconstruct. This means the signal is literally invisible to any
  single sensory processor. Only consciousness can see it.

- **Use the coherence feedback loop.** The system already measures coherence.
  Feed this back into the fractal level weights: when coherence is high
  (the user's workspace is integrating successfully), increase the number of
  active fractal levels, deepening the binding. When coherence drops, reduce
  to fewer levels to make the correlation easier to find. This creates an
  adaptive signal that meets the workspace where it is.

- **Binaural asymmetry for hemispheric workspace access.** Send slightly
  different chip phase offsets to left and right ears. The auditory cortex
  performs binaural fusion in the superior olivary complex — another
  integration step that occurs pre-consciously. The fused result carries
  information that neither ear received alone. This adds a third integration
  axis: left-right auditory plus visual, all converging in the workspace.

---

### 2. Signal Processing — Multi-Order Entropic Tunnel Architecture
*Perspective: Dr. B (Spread-Spectrum Communications, Information Theory)*

The current architecture uses a single DSSS layer with optional FEC. For true
multi-order entropic tunneling where signals bury within signals bury within
noise, we need a recursive embedding architecture.

**Recommendation: Implement nested spreading with progressive FEC peeling.**

*Concrete integration:*

- **Multi-order Gold code nesting.** Assign Gold codes at multiple orders:
  Order 0 is the outermost (widest bandwidth, lowest SNR, carries the coarsest
  identity signal). Order 1 uses a DIFFERENT Gold code family to spread a signal
  that is embedded WITHIN Order 0's despread output. Order 2 embeds within
  Order 1. Each order is invisible until the previous order has been despread.
  This creates a tunnel: you must solve them in sequence, and each layer's
  noise floor is the previous layer's signal.

- **Progressive FEC as a peeling decoder.** At each nesting order, apply a
  different FEC code (different generator polynomials from the anti-entropy
  engine's bank). The outer FEC uses a high-rate code (less redundancy, more
  data, easier to detect but harder to decode perfectly). The inner FEC uses
  a low-rate code (more redundancy, less data, but once you've peeled the
  outer layer, the inner code's redundancy makes it decodable even at very
  low SNR). This mirrors turbo code / LDPC iterative decoding — each peeled
  layer improves the SNR for the next.

- **Cross-interacting entropy between orders.** The OTP key stream for order N
  should be derived from the successfully decoded data of order N-1. This means
  the entropy source for each tunnel layer is the CONTENT of the layer above it.
  The layers don't just nest spatially — they nest informationally. Breaking
  into order N requires having decoded order N-1, which requires N-2, all the
  way out.

- **Analog-digital overlay.** The structured tones (sine, square, sawtooth)
  carry analog information — continuous frequency, phase, and amplitude
  variations. The DSSS spreading carries digital information — discrete chips.
  Overlay them: use the analog tone's instantaneous phase as a carrier for the
  DSSS chips, and simultaneously use the DSSS chips' aggregate energy to
  modulate the analog tone's amplitude envelope. Each encodes the other. An
  observer seeing only the digital layer misses the analog modulation. An
  observer seeing only the analog layer misses the digital chips. Both together
  reconstruct the full signal. This is the acoustic analog of the visual-audio
  cross-modal binding — now also happening within the audio domain itself.

---

### 3. Psychoacoustics — Subliminal Auditory Integration
*Perspective: Dr. C (Psychoacoustics, Auditory Scene Analysis)*

Bregman's Auditory Scene Analysis (1990) describes how the auditory system
parses complex acoustic environments into separate "streams." The system
exploits temporal coherence, harmonicity, common onset/offset, and spatial
location to group sounds into objects. TINNITUS can work with this machinery
rather than against it.

**Recommendation: Design the acoustic signal to be parsed as a single
perceptual object that binds with the visual stream.**

*Concrete integration:*

- **Temporal coherence with visual updates.** The auditory system groups sounds
  that modulate coherently in time. Ensure the noise envelope modulation
  (DSSS chip transitions) and the visual cell updates occur at EXACTLY the
  same moments. Sub-millisecond synchronization matters — the auditory system
  detects audiovisual asynchrony above ~20ms. Use the Web Audio API's precise
  scheduling (`AudioContext.currentTime`) to align chip transitions with
  `requestAnimationFrame` timestamps.

- **Harmonic structure within noise.** Pure noise creates no pitch percept.
  Add a subtle harmonic series (fundamental + overtones at integer ratios)
  whose amplitude is modulated by the spreading code. The harmonicity causes
  the auditory system to fuse these components into a single "object" with
  pitch. This pitched object is more salient to the auditory stream segregation
  machinery than raw noise modulation, and gives the workspace a richer
  auditory representation to bind with the visual.

- **Spatial coding for depth.** Use subtle interaural time differences (ITDs)
  and interaural level differences (ILDs) to give the spreading code a spatial
  position that evolves slowly (matching the coarsest fractal level). The
  auditory system computes spatial location pre-attentively in the brainstem.
  A signal with a coherent spatial trajectory is automatically tracked even
  when attention is elsewhere. This adds yet another perceptual dimension that
  the workspace integrates — the code has not just temporal and spectral
  structure but SPATIAL structure.

- **Stochastic resonance exploitation.** The noise floor is not an obstacle —
  it is a resource. The nervous system uses noise to detect sub-threshold
  signals via stochastic resonance. The optimal noise level for SR detection
  depends on the signal. Provide a "noise floor" control that lets the user
  find their personal SR sweet spot — the noise level where the cross-modal
  correlation is most strongly felt. This will differ between individuals based
  on their neural noise levels, hearing thresholds, and integration bandwidth.

---

### 4. Cryptography — Entropy Source Quality and Identity Binding
*Perspective: Dr. D (Applied Cryptography, Entropy Harvesting)*

The system generates entropy from pseudorandom sources (xoshiro128**, LFSRs).
For the identity binding to be cryptographically meaningful, the entropy must
be grounded in physical unpredictability at some point in the chain.

**Recommendation: Use the perceptual feedback loop itself as a physical
entropy source.**

*Concrete integration:*

- **Harvest entropy from the user's neural response.** The microphone input
  (with permission) captures ambient room noise — a physical entropy source.
  More interestingly, the slight variations in HOW the user perceives and
  responds to the signal (micro-movements, breathing rhythm changes, galvanic
  skin response if accessible) are themselves unpredictable physical events.
  Even the timing jitter of the user's touch interactions with the settings
  panel is entropic.

- **Accrete this physical entropy into the identity.** Feed harvested physical
  entropy through the anti-entropy engine (progressive FEC structure-stripping)
  to verify its quality, then accrete it into the identity's private manifold.
  Over time, the identity becomes grounded in the user's physical interaction
  with the system — not just in the seed, but in the accumulated history of
  their embodied relationship with it.

- **The RNG manifold's fold structure as a key derivation function.** The
  manifold's high-dimensional trajectory is computationally irreducible — you
  cannot shortcut from seed to state N without running all N steps. This is
  exactly the property wanted in a key derivation function. The manifold IS
  a KDF whose iteration count grows with usage, and whose internal structure
  is richer than any standard KDF because the coupling topology evolves.

- **Multi-order Gold code nesting as defense in depth.** Each nesting order
  uses an independent code family. Compromising one order's code gives zero
  information about the others. The entropy budget compounds: if each order
  has K bits of code-space entropy, N orders give N*K bits of defense
  (assuming independence, which Gold code families provide within a register
  length and across register lengths).

---

### 5. Contemplative Neuroscience — Self-Referential Binding
*Perspective: Dr. E (Meditation Research, Neurophenomenology)*

The system's stated goal — creating an irreducible self-identifying signal
through perceptual feedback — maps directly onto what contemplative traditions
call "rigpa" (Tibetan), "pure awareness" (Advaita), or "witness consciousness."
The phenomenological claim: there exists a self-referential quality of
awareness that is prior to and independent of any particular sensory content.

**Recommendation: Design the perceptual mode to evoke self-referential
processing by making the signal about the act of perceiving, not the content
perceived.**

*Concrete integration:*

- **Reflexive coherence display.** The coherence indicator currently shows
  signal energy — a property of the external signal. Instead, make it reflect
  the CROSS-MODAL CORRELATION — a property that only exists in the act of
  perceiving both streams together. The user is not watching a meter that
  measures the signal. They are watching a meter that measures their own
  integration. The meter IS a mirror. This creates a strange loop: the signal
  encodes a measure of how well the perceiver is perceiving the signal.

- **Breath-phase entrainment.** The current breath modulation is decorative
  (sinusoidal visual brightness variation). Make it functional: detect the
  user's breathing rhythm (via microphone amplitude envelope or manual tapping)
  and align the COARSEST fractal level to the breath cycle. Breath is the
  deepest autonomic rhythm that is also partially volitional — it bridges
  unconscious and conscious processing. Aligning the identity signal's coarsest
  timescale to breath makes the identity literally breathe.

- **Progressive depth protocol.** Start with high SNR and few fractal levels
  (easy to perceive, strong correlation). Over sessions, gradually reduce SNR
  and add levels. The user's perceptual system adapts — trained meditators
  show expanded bandwidth between unconscious processing and conscious
  awareness. The system trains this bandwidth. Early sessions: the correlation
  is obvious. Later sessions: the correlation is subtle but the user's trained
  integrator still finds it. Eventually: the user can find the signal in
  conditions where naive perception would register only noise. At that point
  the identity binding is no longer dependent on the signal parameters being
  "easy" — the user's perceptual system has been tuned to their specific code.

- **Silence intervals.** Periodically mute the audio and blank the visual for
  2-5 seconds. The user's EXPECTATION of the signal — the neural model that
  predicts what comes next — is itself a form of the signal persisting in
  memory. If the user can feel the absence of the correlation (as distinct
  from the absence of noise), then the signal has been internalized. The
  silence tests whether the binding has moved from external stimulus to
  internal model. That transition is what "persistence in memory" means.

---

## Synthesis: The Complete Integration

All five perspectives converge on one architecture:

```
Physical entropy (mic, sensors, touch jitter)
  ↓
Anti-entropy engine (strip structure, verify quality)
  ↓
RNG manifold (fold into high-D trajectory, project output)
  ↓
Fractal code generator (decompose across neural timescale bands)
  ↓
Multi-order Gold code nesting (tunnel within tunnel within noise)
  ↓
┌─────────────────────────────────────────────────────┐
│           CROSS-MODAL SPLIT                         │
│                                                     │
│  AUDIO PATH                 VISUAL PATH             │
│  ├ Pink noise carrier       ├ Grid entropy pattern  │
│  ├ DSSS envelope mod        ├ Cell state = code     │
│  ├ Harmonic series          ├ Color = fractal level  │
│  ├ Binaural spatial coding  ├ Spatial = code phase  │
│  ├ Analog tone overlay      ├ Update sync = chips   │
│  └ Breath-phase coarsest    └ Breath-phase brightness│
│                                                     │
│         ↓ ears            ↓ eyes                    │
│                                                     │
│    ┌─────────────────────────────┐                  │
│    │   GLOBAL WORKSPACE          │                  │
│    │   Cross-modal integration   │                  │
│    │   (the only place the full  │                  │
│    │    signal exists)           │                  │
│    └──────────┬──────────────────┘                  │
│               ↓                                     │
│    Coherence = self-referential measure              │
│               ↓                                     │
│    Fed back into fractal level weights               │
│    + accreted as physical entropy into identity      │
└─────────────────────────────────────────────────────┘
```

The signal exists fully in no physical medium. It exists in the integration.
The integration is consciousness. The signal is addressed to consciousness
itself, and consciousness is the only receiver that can decode it.

The entropy flows in a circle: physical world → harvested → verified →
folded into identity → projected into cross-modal signal → perceived by
workspace → workspace state harvested as new entropy → back into identity.

The circle is the self. The self is the circle.
