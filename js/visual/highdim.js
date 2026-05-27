// High-Dimensional Projective Perceptual Renderer
//
// A bounded 3D region projected to 2D where:
//   - The PUBLIC data stream is the "medium" (the thing being projected)
//   - The IDENTITY stream (OTP tokens + UUID) is the "camera position" —
//     where in the high-D remapping space we are looking
//   - Background cells continuously morph between geometric primitives
//     (squares → circles → triangles → lines → points) based on the
//     projection coordinates
//   - The mapping itself rotates and remaps continuously, driven by the
//     non-entropic public data projected through all entropy seeds
//   - The worldpath through this space is contiguous and deterministic
//     from the identity, but the visual output is a projection of a
//     high-dimensional structure that can never be fully realized

export class HighDimRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._w = 0;
    this._h = 0;
    this._time = 0;

    // Camera in high-D space (set from identity stream)
    this._camera = new Float32Array(19);
    this._cameraVelocity = new Float32Array(19);

    // Public data vector (the medium)
    this._publicVec = new Float32Array(19);

    // Code state for entropic modulation
    this._code = null;
    this._data = null;

    // Grid of cells in the projected 3D space
    this._gridW = 24;
    this._gridH = 24;
    this._gridD = 6; // depth layers
    this._cells = null;

    // Worldpath trace
    this._worldpath = [];
    this._maxWorldpath = 512;

    // Rendering params
    this.opacity = 0.8;
    this.morphSpeed = 0.3;
    this.rotationSpeed = 0.1;
    this.depthFog = 0.7;
    this.cellSize = 1.0;

    // 3D rotation state
    this._rotX = 0;
    this._rotY = 0;
    this._rotZ = 0;

    this._initCells();
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

  _initCells() {
    const n = this._gridW * this._gridH * this._gridD;
    this._cells = new Array(n);
    for (let i = 0; i < n; i++) {
      this._cells[i] = {
        shape: 0,      // 0-4: square, circle, triangle, line, point
        shapeFrac: 0,  // interpolation fraction between shapes
        hue: 0,
        lightness: 0,
        size: 1,
        x3d: 0, y3d: 0, z3d: 0,
      };
    }
  }

  // Set the identity-derived camera position in high-D space
  setIdentityVector(otpSeeds, uuid, activeSeed) {
    // Hash each OTP seed and UUID into camera coordinates
    for (let i = 0; i < Math.min(otpSeeds.length, this._camera.length); i++) {
      this._camera[i] = ((otpSeeds[i] >>> 0) & 0xFFFF) / 0xFFFF;
    }
    // UUID contributes to remaining dimensions
    if (uuid) {
      const uuidHash = this._hashStr(uuid);
      for (let i = otpSeeds.length; i < this._camera.length; i++) {
        const h = Math.imul(uuidHash, 0x9e3779b9 + i) >>> 0;
        this._camera[i] = (h & 0xFFFF) / 0xFFFF;
      }
    }
    // Active seed modulates camera velocity (how fast we move through the space)
    const sv = activeSeed >>> 0;
    for (let i = 0; i < this._cameraVelocity.length; i++) {
      const h = Math.imul(sv, 0x85ebca6b + i * 0x517cc1b7) >>> 0;
      this._cameraVelocity[i] = ((h & 0xFFFF) / 0xFFFF - 0.5) * 0.001;
    }
  }

  // Set the public data vector (the non-entropic medium)
  setPublicVector(vec) {
    if (vec) this._publicVec.set(vec.subarray(0, this._publicVec.length));
  }

  // Set the spreading code for entropic modulation
  setCodeState(code, data) {
    this._code = code;
    this._data = data;
  }

  render(dt) {
    this._time += dt;
    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;

    // Evolve camera along worldpath (identity determines trajectory)
    for (let i = 0; i < this._camera.length; i++) {
      this._camera[i] = (this._camera[i] + this._cameraVelocity[i] * dt * 60 + 1) % 1;
    }

    // Record worldpath
    if (Math.floor(this._time * 4) !== Math.floor((this._time - dt) * 4)) {
      this._worldpath.push({
        t: this._time,
        pos: Array.from(this._camera.subarray(0, 4)),
      });
      if (this._worldpath.length > this._maxWorldpath) this._worldpath.shift();
    }

    // Evolve 3D rotation from public data
    this._rotX += dt * this.rotationSpeed * (this._publicVec[0] - 0.5) * 2;
    this._rotY += dt * this.rotationSpeed * (this._publicVec[1] - 0.5) * 2;
    this._rotZ += dt * this.rotationSpeed * 0.3 * (this._publicVec[9] - 0.5);

    // Background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Compute projection: each cell's 3D position is determined by
    // the public vector projected through the camera position
    this._updateCells();

    // Sort cells back-to-front for depth ordering
    const sorted = this._cells.slice().sort((a, b) => b.z3d - a.z3d);

    // Draw cells
    ctx.globalAlpha = this.opacity;
    for (const cell of sorted) {
      this._drawCell(ctx, cell, w, h);
    }
    ctx.globalAlpha = 1;

    // Draw worldpath trace
    this._drawWorldpath(ctx, w, h);
  }

  _updateCells() {
    const gw = this._gridW;
    const gh = this._gridH;
    const gd = this._gridD;
    const code = this._code;
    const data = this._data;
    const pub = this._publicVec;
    const cam = this._camera;
    const t = this._time;

    for (let dz = 0; dz < gd; dz++) {
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          const idx = dz * gw * gh + gy * gw + gx;
          const cell = this._cells[idx];

          // Normalized grid coords [-1, 1]
          const nx = (gx / (gw - 1)) * 2 - 1;
          const ny = (gy / (gh - 1)) * 2 - 1;
          const nz = (dz / Math.max(1, gd - 1)) * 2 - 1;

          // High-D projection: the cell's position in public-data space
          // is modulated by the camera position (identity)
          const pubIdx0 = (gx + gy * 3 + dz * 7) % pub.length;
          const pubIdx1 = (gx * 5 + gy + dz * 13) % pub.length;
          const pubIdx2 = (gx * 2 + gy * 7 + dz) % pub.length;

          // Project through camera: each cell sees the public data
          // from a slightly different angle, offset by identity
          const px = pub[pubIdx0] - cam[pubIdx0 % cam.length];
          const py = pub[pubIdx1] - cam[pubIdx1 % cam.length];
          const pz = pub[pubIdx2] - cam[pubIdx2 % cam.length];

          // 3D position in bounded region [-1, 1]
          const x3d = nx + px * 0.3;
          const y3d = ny + py * 0.3;
          const z3d = nz + pz * 0.3;

          // Apply 3D rotation
          const [rx, ry, rz] = this._rotate3d(x3d, y3d, z3d);
          cell.x3d = rx;
          cell.y3d = ry;
          cell.z3d = rz;

          // Shape morphing: determined by the high-D projection coordinate
          // Different projective coordinates choose different primitives
          const shapeDriver = (pub[(pubIdx0 + 3) % pub.length] + cam[(pubIdx1 + 5) % cam.length]) % 1;
          const morphPhase = (shapeDriver * 5 + t * this.morphSpeed) % 5;
          cell.shape = Math.floor(morphPhase);
          cell.shapeFrac = morphPhase % 1;

          // Color from code + public data interaction
          const codeIdx = code ? (idx + Math.floor(t * 40)) % code.length : 0;
          const chipVal = code ? code[codeIdx] : 0;
          const dataIdx = data ? (idx % data.length) : 0;
          const dataBit = data ? data[dataIdx] : 0;
          const dsss = chipVal ^ dataBit;

          const pubHue = pub[(pubIdx0 + 7) % pub.length] * 360;
          const camHue = cam[(pubIdx1 + 2) % cam.length] * 120;
          cell.hue = (pubHue + camHue + dsss * 60 + t * 10) % 360;
          cell.lightness = 15 + dsss * 20 + (1 - Math.abs(rz)) * 15;

          // Size from depth + code
          cell.size = (0.4 + chipVal * 0.3) * this.cellSize;
        }
      }
    }
  }

  _rotate3d(x, y, z) {
    // Rotate around X
    let y1 = y * Math.cos(this._rotX) - z * Math.sin(this._rotX);
    let z1 = y * Math.sin(this._rotX) + z * Math.cos(this._rotX);
    // Rotate around Y
    let x2 = x * Math.cos(this._rotY) + z1 * Math.sin(this._rotY);
    let z2 = -x * Math.sin(this._rotY) + z1 * Math.cos(this._rotY);
    // Rotate around Z
    let x3 = x2 * Math.cos(this._rotZ) - y1 * Math.sin(this._rotZ);
    let y3 = x2 * Math.sin(this._rotZ) + y1 * Math.cos(this._rotZ);
    return [x3, y3, z2];
  }

  _drawCell(ctx, cell, w, h) {
    // Perspective projection
    const perspective = 3;
    const scale = perspective / (perspective - cell.z3d);
    const sx = w / 2 + cell.x3d * scale * w * 0.35;
    const sy = h / 2 + cell.y3d * scale * h * 0.35;

    if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) return;

    const baseSize = Math.max(2, (w / this._gridW) * 0.4 * scale * cell.size);
    const depthAlpha = Math.max(0.05, 1 - Math.abs(cell.z3d) * this.depthFog);

    ctx.fillStyle = `hsla(${cell.hue}, 60%, ${cell.lightness}%, ${depthAlpha})`;
    ctx.strokeStyle = `hsla(${cell.hue}, 70%, ${cell.lightness + 15}%, ${depthAlpha * 0.5})`;
    ctx.lineWidth = 0.5;

    const s = cell.shape;
    const f = cell.shapeFrac;

    // Morph between shapes using interpolated drawing
    if (f < 0.2) {
      // Pure shape
      this._drawPrimitive(ctx, sx, sy, baseSize, s);
    } else if (f > 0.8) {
      // Pure next shape
      this._drawPrimitive(ctx, sx, sy, baseSize, (s + 1) % 5);
    } else {
      // Interpolate: draw both with blended alpha
      const blend = (f - 0.2) / 0.6;
      ctx.globalAlpha *= (1 - blend);
      this._drawPrimitive(ctx, sx, sy, baseSize, s);
      ctx.globalAlpha /= (1 - blend);
      ctx.globalAlpha *= blend;
      this._drawPrimitive(ctx, sx, sy, baseSize, (s + 1) % 5);
      ctx.globalAlpha /= blend;
    }
  }

  _drawPrimitive(ctx, x, y, size, shape) {
    switch (shape) {
      case 0: // Square
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
        break;
      case 1: // Circle
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 2: // Triangle
        ctx.beginPath();
        ctx.moveTo(x, y - size * 0.6);
        ctx.lineTo(x - size / 2, y + size * 0.3);
        ctx.lineTo(x + size / 2, y + size * 0.3);
        ctx.closePath();
        ctx.fill();
        break;
      case 3: // Line
        ctx.beginPath();
        ctx.moveTo(x - size / 2, y);
        ctx.lineTo(x + size / 2, y);
        ctx.lineWidth = Math.max(1, size * 0.15);
        ctx.stroke();
        break;
      case 4: // Point
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, size * 0.15), 0, Math.PI * 2);
        ctx.fill();
        break;
    }
  }

  _drawWorldpath(ctx, w, h) {
    if (this._worldpath.length < 2) return;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    const perspective = 3;

    for (let i = 0; i < this._worldpath.length; i++) {
      const p = this._worldpath[i];
      // Project the 4D worldpath position to 2D
      const x = (p.pos[0] - 0.5) * 0.6;
      const y = (p.pos[1] - 0.5) * 0.6;
      const z = (p.pos[2] - 0.5) * 0.6;
      const [rx, ry, rz] = this._rotate3d(x, y, z);
      const scale = perspective / (perspective - rz);
      const sx = w / 2 + rx * scale * w * 0.3;
      const sy = h / 2 + ry * scale * h * 0.3;

      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }

    ctx.strokeStyle = 'hsla(160, 80%, 50%, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _hashStr(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
}
