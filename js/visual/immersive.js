// Immersive 3D Fractal Worldpath Renderer
//
// A continuously shifting fractal geometry where:
//   - The geometric structure itself changes (tetrahedron → cube → octahedron →
//     dodecahedron → icosahedron → stellated → subdivided → wireframe)
//   - The fractal subdivision depth evolves over time
//   - Our viewpoint is a "bubble" following the entropic worldpath through
//     the high-D projection space
//   - The public data stream defines the geometry
//   - The identity seeds define where we are looking from
//   - Edges and faces are colored by the spreading code

export class ImmersiveRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._w = 0;
    this._h = 0;
    this._time = 0;

    // Camera (bubble) state
    this._camX = 0;
    this._camY = 0;
    this._camZ = -4;
    this._camRx = 0;
    this._camRy = 0;
    this._camRz = 0;
    this._camVx = 0;
    this._camVy = 0;
    this._camVz = 0;

    // Geometry state
    this._geoPhase = 0;        // which solid (continuous, morphs between)
    this._subdivPhase = 0;     // fractal depth (continuous)
    this._stylePhase = 0;      // wireframe vs solid vs points
    this._vertices = [];
    this._edges = [];
    this._faces = [];

    // Identity / code
    this._camera = new Float32Array(19);
    this._cameraVel = new Float32Array(19);
    this._publicVec = new Float32Array(19);
    this._code = null;
    this._data = null;
    this._coherence = 0;

    // Worldpath
    this._trail = [];
    this._maxTrail = 300;

    this._resize();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = rect.width;
    this._h = rect.height;
  }

  resize() { this._resize(); }

  setIdentityVector(otpSeeds, uuid, activeSeed) {
    for (let i = 0; i < Math.min(otpSeeds.length, this._camera.length); i++) {
      this._camera[i] = ((otpSeeds[i] >>> 0) & 0xFFFF) / 0xFFFF;
    }
    if (uuid) {
      let h = 0x811c9dc5;
      for (let i = 0; i < uuid.length; i++) { h ^= uuid.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      for (let i = otpSeeds.length; i < this._camera.length; i++) {
        const hh = Math.imul(h, 0x9e3779b9 + i) >>> 0;
        this._camera[i] = (hh & 0xFFFF) / 0xFFFF;
      }
    }
    const sv = activeSeed >>> 0;
    for (let i = 0; i < this._cameraVel.length; i++) {
      const h = Math.imul(sv, 0x85ebca6b + i * 0x517cc1b7) >>> 0;
      this._cameraVel[i] = ((h & 0xFFFF) / 0xFFFF - 0.5) * 0.002;
    }
  }

  setPublicVector(vec) {
    if (vec) this._publicVec.set(vec.subarray(0, this._publicVec.length));
  }

  setCodeState(code, data) { this._code = code; this._data = data; }
  setCoherence(v) { this._coherence = v; }

  render(dt) {
    this._time += dt;
    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;

    // Evolve camera along worldpath
    for (let i = 0; i < this._camera.length; i++) {
      this._camera[i] = (this._camera[i] + this._cameraVel[i] * dt * 60 + 1) % 1;
    }

    // Camera position derived from first 3 identity dimensions
    const targetX = (this._camera[0] - 0.5) * 3;
    const targetY = (this._camera[1] - 0.5) * 3;
    const targetZ = -3 + (this._camera[2] - 0.5) * 2;
    this._camX += (targetX - this._camX) * dt * 0.5;
    this._camY += (targetY - this._camY) * dt * 0.5;
    this._camZ += (targetZ - this._camZ) * dt * 0.5;

    // Camera rotation from identity + public data interaction
    this._camRx += dt * 0.15 * (this._publicVec[0] - 0.5);
    this._camRy += dt * 0.2 * (this._publicVec[1] - 0.5);
    this._camRz += dt * 0.08 * (this._publicVec[9] - 0.5);

    // Record trail
    this._trail.push({ x: this._camX, y: this._camY, z: this._camZ });
    if (this._trail.length > this._maxTrail) this._trail.shift();

    // Evolve geometry phase from public data
    this._geoPhase += dt * 0.04 * (1 + this._publicVec[3]);
    this._subdivPhase = 1 + Math.sin(this._time * 0.1) * 0.5 + this._publicVec[9] * 0.5;
    this._stylePhase += dt * 0.03 * (1 + this._publicVec[5]);

    // Generate geometry
    this._generateGeometry();

    // Clear
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Draw trail
    this._drawTrail(ctx, w, h);

    // Draw edges (sorted by depth)
    this._drawGeometry(ctx, w, h);

    // Coherence at bottom
    const barW = w * 0.2;
    const barX = (w - barW) / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(barX, h - 14, barW, 2);
    ctx.fillStyle = `hsl(${120 * this._coherence}, 80%, 50%)`;
    ctx.fillRect(barX, h - 14, barW * this._coherence, 2);
  }

  _generateGeometry() {
    const geoIdx = this._geoPhase % 5;
    const geoA = Math.floor(geoIdx);
    const geoB = (geoA + 1) % 5;
    const blend = geoIdx - geoA;

    const vertsA = PLATONIC_SOLIDS[geoA].v;
    const edgesA = PLATONIC_SOLIDS[geoA].e;
    const vertsB = PLATONIC_SOLIDS[geoB].v;

    // Morph vertices between solids
    const n = Math.max(vertsA.length, vertsB.length);
    this._vertices = [];
    for (let i = 0; i < n; i++) {
      const a = vertsA[i % vertsA.length];
      const b = vertsB[i % vertsB.length];
      this._vertices.push([
        a[0] * (1 - blend) + b[0] * blend,
        a[1] * (1 - blend) + b[1] * blend,
        a[2] * (1 - blend) + b[2] * blend,
      ]);
    }

    // Build edges from current solid
    this._edges = edgesA.map(e => [e[0] % n, e[1] % n]);

    // Fractal subdivision: add midpoints as extra vertices
    if (this._subdivPhase > 1.2) {
      const extraVerts = [];
      const extraEdges = [];
      const nBase = this._vertices.length;
      for (let i = 0; i < this._edges.length; i++) {
        const [a, b] = this._edges[i];
        const va = this._vertices[a];
        const vb = this._vertices[b];
        const mid = [
          (va[0] + vb[0]) / 2,
          (va[1] + vb[1]) / 2,
          (va[2] + vb[2]) / 2,
        ];
        // Normalize to sphere surface for geodesic effect
        const len = Math.sqrt(mid[0] ** 2 + mid[1] ** 2 + mid[2] ** 2) || 1;
        mid[0] /= len; mid[1] /= len; mid[2] /= len;
        const midIdx = nBase + i;
        extraVerts.push(mid);
        extraEdges.push([a, midIdx], [midIdx, b]);
      }
      this._vertices.push(...extraVerts);
      this._edges.push(...extraEdges);
    }

    // Apply code-driven vertex displacement
    const code = this._code;
    if (code) {
      for (let i = 0; i < this._vertices.length; i++) {
        const cIdx = (i + Math.floor(this._time * 40)) % code.length;
        const chip = code[cIdx];
        const disp = chip ? 0.05 : -0.05;
        const v = this._vertices[i];
        const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) || 1;
        v[0] += (v[0] / len) * disp;
        v[1] += (v[1] / len) * disp;
        v[2] += (v[2] / len) * disp;
      }
    }
  }

  _project(v, w, h) {
    // Apply camera rotation
    let [x, y, z] = v;
    x -= this._camX;
    y -= this._camY;
    z -= this._camZ;

    // Rotate Y
    let x1 = x * Math.cos(this._camRy) + z * Math.sin(this._camRy);
    let z1 = -x * Math.sin(this._camRy) + z * Math.cos(this._camRy);
    // Rotate X
    let y1 = y * Math.cos(this._camRx) - z1 * Math.sin(this._camRx);
    let z2 = y * Math.sin(this._camRx) + z1 * Math.cos(this._camRx);
    // Rotate Z
    let x2 = x1 * Math.cos(this._camRz) - y1 * Math.sin(this._camRz);
    let y2 = x1 * Math.sin(this._camRz) + y1 * Math.cos(this._camRz);

    const perspective = 4;
    const d = perspective / Math.max(0.1, perspective + z2);
    return {
      sx: w / 2 + x2 * d * w * 0.3,
      sy: h / 2 + y2 * d * h * 0.3,
      z: z2,
      d,
    };
  }

  _drawGeometry(ctx, w, h) {
    const style = (this._stylePhase % 3);
    const code = this._code;
    const pub = this._publicVec;

    // Project all vertices
    const projected = this._vertices.map(v => this._project(v, w, h));

    // Sort edges by average depth (back to front)
    const sortedEdges = this._edges
      .map((e, i) => ({ e, i, z: (projected[e[0]]?.z || 0) + (projected[e[1]]?.z || 0) }))
      .sort((a, b) => b.z - a.z);

    for (const { e, i } of sortedEdges) {
      const p0 = projected[e[0]];
      const p1 = projected[e[1]];
      if (!p0 || !p1) continue;
      if (p0.z > 10 || p1.z > 10) continue;

      const cIdx = code ? (i + Math.floor(this._time * 30)) % code.length : 0;
      const chip = code ? code[cIdx] : 0;
      const pubIdx = i % pub.length;
      const hue = (pub[pubIdx] * 360 + this._camera[pubIdx % this._camera.length] * 120 + chip * 60 + this._time * 8) % 360;
      const depth = Math.max(0.05, 1 - Math.abs((p0.z + p1.z) / 2) * 0.15);
      const light = 30 + chip * 20;

      if (style < 1) {
        // Wireframe
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.strokeStyle = `hsla(${hue}, 60%, ${light}%, ${depth})`;
        ctx.lineWidth = Math.max(0.5, 1.5 * p0.d);
        ctx.stroke();
      } else if (style < 2) {
        // Wireframe + vertex points
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.strokeStyle = `hsla(${hue}, 50%, ${light}%, ${depth * 0.5})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
        // Vertex glow
        const r = Math.max(1, 3 * p0.d);
        ctx.beginPath();
        ctx.arc(p0.sx, p0.sy, r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 70%, ${light + 20}%, ${depth})`;
        ctx.fill();
      } else {
        // Thick glowing edges
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.strokeStyle = `hsla(${hue}, 70%, ${light + 10}%, ${depth * 0.3})`;
        ctx.lineWidth = Math.max(2, 6 * p0.d);
        ctx.stroke();
        ctx.strokeStyle = `hsla(${hue}, 80%, ${light + 25}%, ${depth})`;
        ctx.lineWidth = Math.max(0.5, 1.5 * p0.d);
        ctx.stroke();
      }
    }
  }

  _drawTrail(ctx, w, h) {
    if (this._trail.length < 2) return;
    ctx.beginPath();
    for (let i = 0; i < this._trail.length; i++) {
      const t = this._trail[i];
      const p = this._project([t.x, t.y, t.z], w, h);
      if (i === 0) ctx.moveTo(p.sx, p.sy);
      else ctx.lineTo(p.sx, p.sy);
    }
    ctx.strokeStyle = 'hsla(160, 70%, 50%, 0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Bubble at current position
    const last = this._trail[this._trail.length - 1];
    const p = this._project([last.x, last.y, last.z], w, h);
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, 4 + this._coherence * 6, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(${120 * this._coherence}, 80%, 60%, 0.6)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// Platonic solid vertex/edge definitions (unit sphere)
const PHI = (1 + Math.sqrt(5)) / 2;
const INV_PHI = 1 / PHI;

function normalize(verts) {
  return verts.map(v => {
    const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    return [v[0] / len, v[1] / len, v[2] / len];
  });
}

const PLATONIC_SOLIDS = [
  { // Tetrahedron
    v: normalize([[1,1,1],[-1,-1,1],[-1,1,-1],[1,-1,-1]]),
    e: [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]],
  },
  { // Cube
    v: normalize([[-1,-1,-1],[-1,-1,1],[-1,1,-1],[-1,1,1],[1,-1,-1],[1,-1,1],[1,1,-1],[1,1,1]]),
    e: [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]],
  },
  { // Octahedron
    v: normalize([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]),
    e: [[0,2],[0,3],[0,4],[0,5],[1,2],[1,3],[1,4],[1,5],[2,4],[2,5],[3,4],[3,5]],
  },
  { // Dodecahedron (approximate)
    v: normalize([
      [1,1,1],[1,1,-1],[1,-1,1],[1,-1,-1],[-1,1,1],[-1,1,-1],[-1,-1,1],[-1,-1,-1],
      [0,INV_PHI,PHI],[0,INV_PHI,-PHI],[0,-INV_PHI,PHI],[0,-INV_PHI,-PHI],
      [INV_PHI,PHI,0],[INV_PHI,-PHI,0],[-INV_PHI,PHI,0],[-INV_PHI,-PHI,0],
      [PHI,0,INV_PHI],[PHI,0,-INV_PHI],[-PHI,0,INV_PHI],[-PHI,0,-INV_PHI],
    ]),
    e: [[0,8],[0,12],[0,16],[1,9],[1,12],[1,17],[2,10],[2,13],[2,16],[3,11],[3,13],[3,17],
        [4,8],[4,14],[4,18],[5,9],[5,14],[5,19],[6,10],[6,15],[6,18],[7,11],[7,15],[7,19],
        [8,10],[9,11],[12,14],[13,15],[16,17],[18,19]],
  },
  { // Icosahedron
    v: normalize([
      [0,1,PHI],[0,1,-PHI],[0,-1,PHI],[0,-1,-PHI],
      [1,PHI,0],[1,-PHI,0],[-1,PHI,0],[-1,-PHI,0],
      [PHI,0,1],[PHI,0,-1],[-PHI,0,1],[-PHI,0,-1],
    ]),
    e: [[0,2],[0,4],[0,6],[0,8],[0,10],[1,3],[1,4],[1,6],[1,9],[1,11],
        [2,5],[2,7],[2,8],[2,10],[3,5],[3,7],[3,9],[3,11],[4,6],[4,8],
        [4,9],[5,7],[5,8],[5,9],[6,10],[6,11],[7,10],[7,11],[8,9],[10,11]],
  },
];
