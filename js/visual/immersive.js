// Immersive 3D Fractal Worldpath Renderer
//
// The viewer is INSIDE a nested fractal geometry looking outward.
// Multiple concentric shells of morphing platonic solids surround
// the viewpoint. The identity seeds control the camera ORIENTATION
// (where we look within the geometry), not position. The geometry
// fills the screen — we are the bubble at the center.
//
// The public data stream determines the geometry structure.
// The identity determines our perspective through it.
// The code chips modulate the geometry's breathing.

export class ImmersiveRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._w = 0;
    this._h = 0;
    this._time = 0;

    // Camera rotation (we stay at origin, geometry surrounds us)
    this._rotX = 0;
    this._rotY = 0;
    this._rotZ = 0;
    this._rotVx = 0;
    this._rotVy = 0;
    this._rotVz = 0;

    // Identity / code
    this._camera = new Float32Array(19);
    this._cameraVel = new Float32Array(19);
    this._publicVec = new Float32Array(19);
    this._code = null;
    this._data = null;
    this._coherence = 0;

    // Geometry shells — multiple nested layers
    this._shells = [];
    this._geoPhase = 0;
    this._stylePhase = 0;

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
    // Identity determines rotation velocity — our path through orientation space
    const sv = activeSeed >>> 0;
    this._rotVx = ((Math.imul(sv, 0x85ebca6b) >>> 0) & 0xFFFF) / 0xFFFF * 0.06 - 0.03;
    this._rotVy = ((Math.imul(sv, 0xc2b2ae35) >>> 0) & 0xFFFF) / 0xFFFF * 0.08 - 0.04;
    this._rotVz = ((Math.imul(sv, 0x517cc1b7) >>> 0) & 0xFFFF) / 0xFFFF * 0.04 - 0.02;
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

    // Evolve camera orientation along the identity worldpath
    for (let i = 0; i < this._camera.length; i++) {
      this._camera[i] = (this._camera[i] + this._cameraVel[i] * dt + 1) % 1;
    }
    this._rotX += this._rotVx * dt;
    this._rotY += this._rotVy * dt;
    this._rotZ += this._rotVz * dt;

    // Public data slowly modulates rotation (shared drift everyone sees)
    this._rotX += dt * 0.02 * (this._publicVec[0] - 0.5);
    this._rotY += dt * 0.03 * (this._publicVec[1] - 0.5);

    // Evolve geometry phase
    this._geoPhase += dt * 0.035 * (1 + this._publicVec[3] * 0.5);
    this._stylePhase += dt * 0.025;

    // Clear
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Generate and draw nested shells (outermost first for depth ordering)
    const numShells = 4;
    for (let shell = numShells - 1; shell >= 0; shell--) {
      this._drawShell(ctx, w, h, shell, numShells, dt);
    }

    // Coherence glow at center (we are here)
    const glowR = 8 + this._coherence * 20;
    const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, glowR);
    grad.addColorStop(0, `hsla(${120 * this._coherence}, 80%, 60%, 0.3)`);
    grad.addColorStop(1, `hsla(${120 * this._coherence}, 80%, 60%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Coherence bar
    const barW = w * 0.2;
    const barX = (w - barW) / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(barX, h - 14, barW, 2);
    ctx.fillStyle = `hsl(${120 * this._coherence}, 80%, 50%)`;
    ctx.fillRect(barX, h - 14, barW * this._coherence, 2);
  }

  _drawShell(ctx, w, h, shellIdx, numShells, dt) {
    const pub = this._publicVec;
    const code = this._code;

    // Each shell uses a different solid, offset in phase
    const geoIdx = (this._geoPhase + shellIdx * 1.2) % 5;
    const geoA = Math.floor(geoIdx);
    const geoB = (geoA + 1) % 5;
    const blend = geoIdx - geoA;

    const vertsA = SOLIDS[geoA].v;
    const edgesA = SOLIDS[geoA].e;
    const vertsB = SOLIDS[geoB].v;

    // Shell radius — inner shells are closer/smaller, outer are larger
    const baseRadius = 1.5 + shellIdx * 1.8;
    const breathMod = Math.sin(this._time * 0.3 + shellIdx * 0.7) * 0.15;
    const radius = baseRadius + breathMod;

    // Shell-specific rotation offset (each shell rotates slightly differently)
    const shellRotX = this._rotX + shellIdx * 0.4;
    const shellRotY = this._rotY + shellIdx * 0.3;
    const shellRotZ = this._rotZ + shellIdx * 0.2;

    // Morph vertices between solids
    const n = Math.max(vertsA.length, vertsB.length);
    const verts = [];
    for (let i = 0; i < n; i++) {
      const a = vertsA[i % vertsA.length];
      const b = vertsB[i % vertsB.length];
      verts.push([
        (a[0] * (1 - blend) + b[0] * blend) * radius,
        (a[1] * (1 - blend) + b[1] * blend) * radius,
        (a[2] * (1 - blend) + b[2] * blend) * radius,
      ]);
    }

    // Fractal subdivision for outer shells
    let edges = edgesA.map(e => [e[0] % n, e[1] % n]);
    if (shellIdx >= 2) {
      const extra = [];
      const extraEdges = [];
      const base = verts.length;
      for (let i = 0; i < edges.length; i++) {
        const [a, b] = edges[i];
        if (a >= verts.length || b >= verts.length) continue;
        const va = verts[a], vb = verts[b];
        const mid = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
        const len = Math.sqrt(mid[0] ** 2 + mid[1] ** 2 + mid[2] ** 2) || 1;
        mid[0] = mid[0] / len * radius;
        mid[1] = mid[1] / len * radius;
        mid[2] = mid[2] / len * radius;
        extra.push(mid);
        extraEdges.push([a, base + i], [base + i, b]);
      }
      verts.push(...extra);
      edges.push(...extraEdges);
    }

    // Code-driven vertex displacement
    if (code) {
      for (let i = 0; i < verts.length; i++) {
        const cIdx = (i + Math.floor(this._time * 30) + shellIdx * 7) % code.length;
        const chip = code[cIdx];
        const disp = (chip ? 0.08 : -0.08) * (1 + this._coherence * 0.5);
        const v = verts[i];
        const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) || 1;
        v[0] += (v[0] / len) * disp;
        v[1] += (v[1] / len) * disp;
        v[2] += (v[2] / len) * disp;
      }
    }

    // Project vertices (camera at origin looking outward)
    const fov = Math.min(w, h) * 0.8;
    const projected = verts.map(v => {
      const [rx, ry, rz] = this._rotate(v, shellRotX, shellRotY, shellRotZ);
      const d = rz + 6; // offset so everything is in front
      if (d < 0.1) return null;
      return {
        sx: w / 2 + (rx / d) * fov,
        sy: h / 2 + (ry / d) * fov,
        z: d,
      };
    });

    // Sort edges back-to-front
    const sorted = edges
      .filter(e => projected[e[0]] && projected[e[1]])
      .sort((a, b) => {
        const zA = (projected[a[0]].z + projected[a[1]].z);
        const zB = (projected[b[0]].z + projected[b[1]].z);
        return zB - zA;
      });

    // Rendering style cycles
    const style = Math.floor(this._stylePhase + shellIdx * 0.5) % 3;
    const shellAlpha = 0.15 + (1 - shellIdx / numShells) * 0.5;

    for (let i = 0; i < sorted.length; i++) {
      const [a, b] = sorted[i];
      const p0 = projected[a];
      const p1 = projected[b];
      if (!p0 || !p1) continue;
      if (p0.sx < -100 || p0.sx > w + 100 || p0.sy < -100 || p0.sy > h + 100) continue;

      const cIdx = code ? (i + Math.floor(this._time * 20) + shellIdx * 11) % code.length : 0;
      const chip = code ? code[cIdx] : 0;
      const pubIdx = (i + shellIdx * 5) % pub.length;
      const hue = (pub[pubIdx] * 200 + this._camera[pubIdx % this._camera.length] * 160 +
                   chip * 50 + shellIdx * 70 + this._time * 6) % 360;
      const depth = Math.max(0.1, 1 - (p0.z + p1.z - 8) * 0.08);
      const alpha = depth * shellAlpha;
      const light = 30 + chip * 25;

      if (style === 0) {
        // Clean wireframe
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.strokeStyle = `hsla(${hue}, 55%, ${light}%, ${alpha})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else if (style === 1) {
        // Glowing edges
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.strokeStyle = `hsla(${hue}, 60%, ${light}%, ${alpha * 0.3})`;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.strokeStyle = `hsla(${hue}, 70%, ${light + 20}%, ${alpha})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        // Wireframe + vertex dots
        ctx.beginPath();
        ctx.moveTo(p0.sx, p0.sy);
        ctx.lineTo(p1.sx, p1.sy);
        ctx.strokeStyle = `hsla(${hue}, 45%, ${light}%, ${alpha * 0.4})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
        const r = Math.max(1.5, 3 / p0.z);
        ctx.beginPath();
        ctx.arc(p0.sx, p0.sy, r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${hue}, 70%, ${light + 15}%, ${alpha})`;
        ctx.fill();
      }
    }
  }

  _rotate(v, rx, ry, rz) {
    let [x, y, z] = v;
    // Y
    let x1 = x * Math.cos(ry) + z * Math.sin(ry);
    let z1 = -x * Math.sin(ry) + z * Math.cos(ry);
    // X
    let y1 = y * Math.cos(rx) - z1 * Math.sin(rx);
    let z2 = y * Math.sin(rx) + z1 * Math.cos(rx);
    // Z
    let x2 = x1 * Math.cos(rz) - y1 * Math.sin(rz);
    let y2 = x1 * Math.sin(rz) + y1 * Math.cos(rz);
    return [x2, y2, z2];
  }
}

// Platonic solids — vertices normalized to unit sphere
const PHI = (1 + Math.sqrt(5)) / 2;
const INV = 1 / PHI;

function norm(verts) {
  return verts.map(v => {
    const l = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    return [v[0] / l, v[1] / l, v[2] / l];
  });
}

const SOLIDS = [
  { v: norm([[1,1,1],[-1,-1,1],[-1,1,-1],[1,-1,-1]]),
    e: [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]] },
  { v: norm([[-1,-1,-1],[-1,-1,1],[-1,1,-1],[-1,1,1],[1,-1,-1],[1,-1,1],[1,1,-1],[1,1,1]]),
    e: [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]] },
  { v: norm([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]),
    e: [[0,2],[0,3],[0,4],[0,5],[1,2],[1,3],[1,4],[1,5],[2,4],[2,5],[3,4],[3,5]] },
  { v: norm([[1,1,1],[1,1,-1],[1,-1,1],[1,-1,-1],[-1,1,1],[-1,1,-1],[-1,-1,1],[-1,-1,-1],
             [0,INV,PHI],[0,INV,-PHI],[0,-INV,PHI],[0,-INV,-PHI],
             [INV,PHI,0],[INV,-PHI,0],[-INV,PHI,0],[-INV,-PHI,0],
             [PHI,0,INV],[PHI,0,-INV],[-PHI,0,INV],[-PHI,0,-INV]]),
    e: [[0,8],[0,12],[0,16],[1,9],[1,12],[1,17],[2,10],[2,13],[2,16],[3,11],[3,13],[3,17],
        [4,8],[4,14],[4,18],[5,9],[5,14],[5,19],[6,10],[6,15],[6,18],[7,11],[7,15],[7,19],
        [8,10],[9,11],[12,14],[13,15],[16,17],[18,19]] },
  { v: norm([[0,1,PHI],[0,1,-PHI],[0,-1,PHI],[0,-1,-PHI],
             [1,PHI,0],[1,-PHI,0],[-1,PHI,0],[-1,-PHI,0],
             [PHI,0,1],[PHI,0,-1],[-PHI,0,1],[-PHI,0,-1]]),
    e: [[0,2],[0,4],[0,6],[0,8],[0,10],[1,3],[1,4],[1,6],[1,9],[1,11],
        [2,5],[2,7],[2,8],[2,10],[3,5],[3,7],[3,9],[3,11],[4,6],[4,8],
        [4,9],[5,7],[5,8],[5,9],[6,10],[6,11],[7,10],[7,11],[8,9],[10,11]] },
];
