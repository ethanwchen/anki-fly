// 3D fruit fly sprite (three.js). Same API as fly_sprite.js:
//   new FlySprite(canvas); .setState(s); .update(dtMs); .draw(); .resize()
// States: idle, walk, groom, proboscis, sleep, startle, fly
//
// Geometry: anatomically detailed Drosophila body from TuragaLab/flybody (Apache-2.0),
// decimated and baked into vendor/fly.bin (see vendor/LICENSE-flybody.txt). The MuJoCo
// kinematic tree (bodies + hinge joints) is preserved so parts articulate: legs (coxa /
// femur / tibia / 5 tarsal segments), head, antennae, proboscis (rostrum / haustellum /
// labella), wings (yaw/roll/pitch), halteres and 7 abdominal segments.

const THREE = window.THREE;

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const ease01 = (t) => smooth(clamp(t, 0, 1));

// ---------- procedural textures ----------
function shadowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  r.addColorStop(0, 'rgba(0,0,0,0.55)'); r.addColorStop(0.55, 'rgba(0,0,0,0.22)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function glyphTexture(ch, color) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 44px ui-sans-serif, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
  g.fillStyle = color; g.fillText(ch, 32, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function sparkTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, 'rgba(255,240,170,1)'); r.addColorStop(0.35, 'rgba(255,220,110,0.8)'); r.addColorStop(1, 'rgba(255,200,80,0)');
  g.fillStyle = r; g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// Hexagonal ommatidia normal map for the compound eyes.
function eyeNormalMap() {
  const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(128,128,255)'; g.fillRect(0, 0, N, N);
  const cell = 16, h = cell * Math.sqrt(3) / 2;
  for (let row = -1; row < N / h + 2; row++) {
    for (let col = -1; col < N / cell + 2; col++) {
      const cx = col * cell + (row & 1 ? cell / 2 : 0), cy = row * h;
      const R = cell * 0.5;
      // radial normal: each facet is a little dome
      for (let k = 0; k < 5; k++) {
        const rr = R * (1 - k / 5), a = (k + 1) / 5;
        const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
        grad.addColorStop(0, `rgba(128,128,255,${0.0})`);
        grad.addColorStop(1, `rgba(128,128,255,${a * 0.0})`);
        void grad;
      }
      // approximate dome normals with 4 offset shaded arcs
      for (let s = 0; s < 4; s++) {
        const ang = s * Math.PI / 2;
        const nx = Math.round(128 + 60 * Math.cos(ang)), ny = Math.round(128 - 60 * Math.sin(ang));
        g.fillStyle = `rgba(${nx},${ny},240,0.55)`;
        g.beginPath(); g.arc(cx, cy, R * 0.92, ang - Math.PI / 4 - 1.2, ang - Math.PI / 4 + 1.2); g.lineTo(cx, cy); g.fill();
      }
      g.fillStyle = 'rgba(128,128,255,0.9)';
      g.beginPath(); g.arc(cx, cy, R * 0.45, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(100,100,200,0.9)'; g.lineWidth = 1.2;
      g.beginPath(); g.arc(cx, cy, R * 0.98, 0, TAU); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}

// IK-solved grooming poses (joint -> radians offset from the rest pose)
const POSE = {
  headGroomR: { coxa_abduct_T1_right: -1, coxa_twist_T1_right: 0.57, coxa_T1_right: 0.64, femur_twist_T1_right: -1, femur_T1_right: -0.01, tibia_T1_right: 0.07, tarsus_T1_right: 1.44 },
  headGroomL: { coxa_abduct_T1_left: -0.95, coxa_twist_T1_left: 0.38, coxa_T1_left: 0.41, femur_twist_T1_left: -1, femur_T1_left: -0.01, tibia_T1_left: 0.2, tarsus_T1_left: 1.44 },
  abdGroomR: { coxa_abduct_T3_right: -0.4, coxa_twist_T3_right: -0.09, coxa_T3_right: 0.76, femur_twist_T3_right: 0.44, femur_T3_right: -0.96, tibia_T3_right: -1.06, tarsus_T3_right: 0.53 },
  abdGroomL: { coxa_abduct_T3_left: 0.25, coxa_twist_T3_left: -0.16, coxa_T3_left: 0.76, femur_twist_T3_left: 0.44, femur_T3_left: -0.96, tibia_T3_left: -1.06, tarsus_T3_left: -0.2 },
};

// ---------- binary loader ----------
async function loadFlyBin(url) {
  const buf = await fetch(url).then(r => { if (!r.ok) throw new Error('fly.bin ' + r.status); return r.arrayBuffer(); });
  const dv = new DataView(buf);
  if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== 'FLY1') throw new Error('bad fly.bin');
  const hlen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
  const base = 8 + hlen;
  const parts = header.parts.map(p => {
    const q = new Uint16Array(buf, base + p.vOff, p.nv * 3);
    const pos = new Float32Array(p.nv * 3);
    const mn = p.bbmin, ext = [0, 1, 2].map(i => Math.max(p.bbmax[i] - mn[i], 1e-9));
    for (let i = 0; i < p.nv; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = mn[k] + q[i * 3 + k] / 65535 * ext[k];
    const idx = p.itype === 16 ? new Uint16Array(buf, base + p.iOff, p.ni) : new Uint32Array(buf, base + p.iOff, p.ni);
    const col = p.cOff !== undefined ? new Uint8Array(buf, base + p.cOff, p.nv * 3) : null;
    return { body: p.body, mat: p.mat, pos, idx: idx.slice(), col };
  });
  return { bodies: header.bodies, parts };
}

// ---------- the sprite ----------
export class FlySprite {
  constructor(canvas) {
    this.canvas = canvas;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.state = 'idle'; this.stateT = 0; this.prevState = 'idle'; this.blendT = 1;
    this.x = 0.52; this.dir = 1; this.t = 0;
    this.ready = false; this.failed = false;
    this.J = {};                 // joint name -> {body, i, v}
    this.bodies = [];            // Object3D per MuJoCo body
    this.wakeSway = 0;
    this.legShift = { t: 0, leg: 0, a: 0 };
    this.groomMode = 0; this.groomT = 0;
    this.antT = 0; this.antA = 0;
    this.fovY = 28;

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.fovY, 0.6, 0.5, 30);
    this.world = new THREE.Group(); this.scene.add(this.world);   // ground-level frame
    this.mover = new THREE.Group(); this.world.add(this.mover);   // translates/turns the fly
    this.lift = new THREE.Group(); this.mover.add(this.lift);     // vertical hops / crouch
    this.root = new THREE.Group(); this.lift.add(this.root);      // z-up MuJoCo -> y-up
    this.root.rotation.x = -Math.PI / 2;

    // lights: soft sky, warm key, cool rim, faint fill from below
    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x3a2a18, 0.8));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.2); key.position.set(2.5, 5, 3); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9ec2ff, 1.6); rim.position.set(-3, 3, -4); this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffe0c0, 0.5); fill.position.set(-2, -1, 3); this.scene.add(fill);

    // contact shadow
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = 0.002; this.shadow.scale.set(1.15, 0.85, 1);
    this.mover.add(this.shadow);

    // overlays: zzz + sparkles
    this.zzz = [];
    const zt = glyphTexture('z', 'rgba(205,215,255,0.95)');
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: zt, transparent: true, depthTest: false }));
      s.visible = false; this.world.add(s); this.zzz.push(s);
    }
    this.sparks = [];
    const st = sparkTexture();
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: st, transparent: true, depthTest: false, blending: THREE.AdditiveBlending }));
      s.visible = false; s.scale.set(0.12, 0.12, 1); this.world.add(s); this.sparks.push(s);
    }

    this.resize();
    loadFlyBin(new URL('vendor/fly.bin', import.meta.url)).then(d => this.build(d)).catch(e => { this.failed = true; console.error('[fly3d]', e); });
  }

  // ---------- model construction ----------
  materials() {
    const eyeN = eyeNormalMap();
    const M = {
      body: new THREE.MeshStandardMaterial({ color: 0xc99552, roughness: 0.62, metalness: 0.0 }),
      bodyVC: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.0 }),
      lowerVC: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.7 }),
      lower: new THREE.MeshStandardMaterial({ color: 0xd9b476, roughness: 0.7 }),
      black: new THREE.MeshStandardMaterial({ color: 0x1b1410, roughness: 0.75 }),
      'bristle-brown': new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.8 }),
      brown: new THREE.MeshStandardMaterial({ color: 0x3a2314, roughness: 0.6 }),
      ocelli: new THREE.MeshPhysicalMaterial({ color: 0x5a2a10, roughness: 0.15, clearcoat: 1 }),
      red: new THREE.MeshPhysicalMaterial({ color: 0xb8200c, roughness: 0.32, metalness: 0.05, clearcoat: 0.9, clearcoatRoughness: 0.25,
        normalMap: eyeN, normalScale: new THREE.Vector2(1.0, 1.0) }),
      membrane: new THREE.MeshPhysicalMaterial({ color: 0xbfd2f0, transparent: true, opacity: 0.26, roughness: 0.18, metalness: 0.0,
        side: THREE.DoubleSide, depthWrite: false, iridescence: 0.7, iridescenceIOR: 1.3, iridescenceThicknessRange: [120, 420],
        clearcoat: 0.5, clearcoatRoughness: 0.2 }),
      ghost: new THREE.MeshBasicMaterial({ color: 0xcfe0ff, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false }),
    };
    return M;
  }

  build(data) {
    const M = this.M = this.materials();
    const B = data.bodies;
    this.bodies = B.map((b, i) => {
      const o = new THREE.Group(); o.name = b.name;
      o.position.set(b.pos[0], b.pos[1], b.pos[2]);
      o.userData.q0 = new THREE.Quaternion(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
      o.userData.joints = b.joints.map((j, k) => {
        const J = { axis: new THREE.Vector3(j.axis[0], j.axis[1], j.axis[2]), ref: j.ref, v: 0, lo: j.range[0], hi: j.range[1] };
        this.J[j.name] = J; return J;
      });
      return o;
    });
    B.forEach((b, i) => (b.parent < 0 ? this.root : this.bodies[b.parent]).add(this.bodies[i]));

    const eyeGeoms = [];
    for (const p of data.parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
      g.setIndex(new THREE.BufferAttribute(p.idx, 1));
      let mat = M[p.mat] || M.body;
      if (p.col) {
        g.setAttribute('color', new THREE.BufferAttribute(p.col, 3, true));
        mat = p.mat === 'lower' ? M.lowerVC : M.bodyVC;
      }
      if (p.mat === 'red') { this.eyeUVs(g); }
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      const bname = B[p.body].name;
      mesh.name = bname + ':' + p.mat;
      this.bodies[p.body].add(mesh);
      if (p.mat === 'membrane' || p.mat === 'brown' && bname.startsWith('wing')) mesh.userData.wing = true;
    }
    // wing ghosts (translucent fan when flying)
    this.ghosts = [];
    for (const side of ['left', 'right']) {
      const wb = this.bodies[B.findIndex(b => b.name === 'wing_' + side)];
      const mem = wb.children.find(c => c.name && c.name.endsWith(':membrane'));
      for (let k = 0; k < 3; k++) {
        const gh = new THREE.Group(); gh.visible = false;
        const gm = new THREE.Mesh(mem.geometry, M.ghost); gm.frustumCulled = false; gh.add(gm);
        gh.position.copy(wb.position);
        wb.parent.add(gh);
        this.ghosts.push({ o: gh, wb, k, side });
      }
    }
    this.byName = {}; B.forEach((b, i) => this.byName[b.name] = this.bodies[i]);

    this.calibrateLegs();
    // rest pose, measure, normalize so that body length = 1 and feet at y = 0
    this.applyJoints();
    this.root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.root);
    const size = box.getSize(new THREE.Vector3());
    const L = size.x;                              // MuJoCo x = fore-aft
    const s = 1 / L;
    this.root.scale.setScalar(s);
    this.root.position.set(-(box.min.x + box.max.x) / 2 * s, -box.min.y * s, -(box.min.z + box.max.z) / 2 * s);
    this.groundY = 0;
    this.bodyH = size.y * s;
    this.ready = true;
    this.layout();
  }

  // spherical UVs per eye so the hex normal map wraps each compound eye
  eyeUVs(g) {
    const P = g.attributes.position, n = P.count;
    // eyes are the two lobes farthest apart along the head's widest axis -> find by PCA-lite: axis of max extent
    const box = new THREE.Box3().setFromBufferAttribute(P), c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    const ax = sz.x >= sz.y && sz.x >= sz.z ? 0 : (sz.y >= sz.z ? 1 : 2);
    const uv = new Float32Array(n * 2);
    const cen = [new THREE.Vector3(), new THREE.Vector3()], cnt = [0, 0];
    const cc = c.getComponent(ax), A = P.array;
    const sideOf = (i) => A[i * 3 + ax] > cc ? 1 : 0;
    for (let i = 0; i < n; i++) { const s = sideOf(i); cen[s].x += P.getX(i); cen[s].y += P.getY(i); cen[s].z += P.getZ(i); cnt[s]++; }
    cen.forEach((v, k) => v.divideScalar(Math.max(1, cnt[k])));
    const d = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const s = sideOf(i);
      d.set(P.getX(i), P.getY(i), P.getZ(i)).sub(cen[s]).normalize();
      const u = Math.atan2(d.z, d.x) / TAU, v = Math.acos(clamp(d.y, -1, 1)) / Math.PI;
      uv[i * 2] = u * 5; uv[i * 2 + 1] = v * 2.5;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  applyJoints() {
    const q = new THREE.Quaternion();
    for (const o of this.bodies) {
      const js = o.userData.joints;
      o.quaternion.copy(o.userData.q0);
      for (const j of js) { q.setFromAxisAngle(j.axis, clamp(j.ref + j.v, j.lo - 0.6, j.hi + 0.6)); o.quaternion.multiply(q); }
    }
  }

  // ---------- API ----------
  resize() {
    const w = this.canvas.clientWidth || 84, h = this.canvas.clientHeight || 140;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.layout();
  }

  layout() {
    // 3/4 view from slightly above; fly length ~1 should fill ~70% of the width.
    const aspect = this.camera.aspect;
    const wantW = 1.0 / 0.80;
    const visH = Math.max(wantW / aspect, 1.6);
    const dist = (visH / 2) / Math.tan(this.fovY / 2 * Math.PI / 180);
    this.camDist = dist;
    const el = 0.72, az = 0.95;   // elevation, azimuth
    this.camera.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    this.lookAt = new THREE.Vector3(0, 0.12 + visH * 0.13, 0);
    this.camera.lookAt(this.lookAt);
    this.visW = visH * aspect;
    this.visH = visH;
    // fly heading: screen-right (or left) turned ~25 deg toward the viewer
    this.yawR = az - 0.45; this.yawL = az + Math.PI + 0.45;
  }

  setState(s) {
    if (s !== this.state) { this.prevState = this.state; this.state = s; this.stateT = 0; this.blendT = 0; }
  }

  update(dt) {
    dt = Math.min(dt, 80);
    this.t += dt; this.stateT += dt; this.blendT = Math.min(1, this.blendT + dt / 260);
    const s = this.state;
    if (s === 'walk') {
      this.x += this.dir * dt * 0.00011;
      if (this.x > 0.72) this.dir = -1; else if (this.x < 0.28) this.dir = 1;
    } else if (s === 'fly') {
      this.x += ((0.5 + Math.sin(this.t / 900) * 0.18) - this.x) * Math.min(1, dt / 300);
    }
    if (!this.ready) return;
    this.pose(dt);
    if (this.dbg) for (const k in this.dbg) this.addJ(k, this.dbg[k]);
    this.applyJoints();
  }

  draw() {
    if (!this.ready) { this.renderer.clear(); return; }
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- posing ----------
  setJ(name, v) { const j = this.J[name]; if (j) j.v = v; }
  addJ(name, v) { const j = this.J[name]; if (j) j.v += v; }

  // Measure, per leg, which joint/sign swings the foot forward and which lifts it,
  // so gait code is independent of the model's joint conventions.
  calibrateLegs() {
    const tip = new THREE.Vector3(), inv = new THREE.Matrix4();
    const footLocal = () => {
      this.applyJoints(); this.root.updateWorldMatrix(true, true);
      return tip.set(0, 0, 0);
    };
    this.legCal = {};
    for (const side of ['left', 'right']) for (const seg of ['T1', 'T2', 'T3']) {
      const claw = this.byName[`claw_${seg}_${side}`];
      const measure = () => { this.applyJoints(); this.root.updateWorldMatrix(true, true); claw.getWorldPosition(tip); return this.root.worldToLocal(tip.clone()); };
      for (const k in this.J) this.J[k].v = 0;
      const p0 = measure();
      const probe = (name, d) => { this.J[name].v = d; const p = measure(); this.J[name].v = 0; return p.sub(p0); };
      // swing: joint whose +d moves the foot most along +x (forward)
      let best = null;
      for (const jn of [`coxa_abduct_${seg}_${side}`, `coxa_twist_${seg}_${side}`, `coxa_${seg}_${side}`]) {
        const dp = probe(jn, 0.3);
        if (!best || Math.abs(dp.x) > Math.abs(best.dx)) best = { name: jn, dx: dp.x };
      }
      const swing = { name: best.name, sign: Math.sign(best.dx) || 1 };
      const fz = probe(`femur_${seg}_${side}`, 0.3).z, tz = probe(`tibia_${seg}_${side}`, 0.3).z;
      this.legCal[`${seg}_${side}`] = { swing, femurUp: Math.sign(fz) || 1, tibiaUp: Math.sign(tz) || 1 };
    }
    for (const k in this.J) this.J[k].v = 0;
    void footLocal; void inv;
  }

  // gait helper: swing forward(+)/back(-), lift raises the foot (both in radians-ish)
  leg(seg, side, { swing = 0, lift = 0 } = {}) {
    const c = this.legCal[`${seg}_${side}`]; if (!c) return;
    this.addJ(c.swing.name, swing * c.swing.sign);
    this.addJ(`femur_${seg}_${side}`, lift * 0.7 * c.femurUp);
    this.addJ(`tibia_${seg}_${side}`, lift * 0.5 * c.tibiaUp);
  }

  // apply a named pose (joint -> angle) scaled by k
  applyPose(P, k) { for (const n in P) this.addJ(n, P[n] * k); }

  pose(dt) {
    for (const k in this.J) this.J[k].v = 0;
    const t = this.t, st = this.stateT, s = this.state;
    const T = t / 1000;
    let bodyY = 0, pitch = 0, roll = 0, yaw = 0;
    let wingBlur = 0, wingSpread = 0, wingFlat = 0;
    let shadowA = 1, shadowS = 1;
    const e = ease01(this.blendT);   // blend-in of the current state

    // ambient life: breathing, antenna twitches, haltere jitter
    const breath = Math.sin(T * TAU * 0.55) * 0.5 + 0.5;
    this.antT -= dt;
    if (this.antT <= 0) { this.antT = 900 + Math.random() * 3200; this.antA = 1; }
    this.antA = Math.max(0, this.antA - dt / 350);
    const antTw = Math.sin(this.antA * Math.PI) * 0.25;
    this.addJ('antenna_left', antTw); this.addJ('antenna_right', antTw * 0.7);
    this.addJ('antenna_abduct_left', -antTw * 0.5); this.addJ('antenna_abduct_right', antTw * 0.5);
    for (let k = 2; k <= 7; k++) this.addJ(`abdomen_${k}`, -0.03 + breath * 0.04);
    this.addJ('abdomen', -0.02 + breath * 0.03);
    this.addJ('haltere_left', Math.sin(T * 9) * 0.05); this.addJ('haltere_right', Math.cos(T * 8) * 0.05);

    if (s === 'idle') {
      bodyY = breath * 0.006;
      const L = this.legShift; L.t -= dt;
      if (L.t <= 0) { L.t = 2500 + Math.random() * 5000; L.leg = (Math.random() * 6) | 0; L.a = 1; }
      L.a = Math.max(0, L.a - dt / 650);
      if (L.a > 0) {
        const seg = ['T1', 'T2', 'T3'][L.leg % 3], side = L.leg < 3 ? 'left' : 'right', p = Math.sin(L.a * Math.PI);
        this.leg(seg, side, { lift: p * 0.6, swing: p * 0.15 });
      }
      this.addJ('head_twist', Math.sin(T * 0.7) * 0.05);
      this.addJ('head', Math.sin(T * 0.9) * 0.04);
    } else if (s === 'walk') {
      // tripod gait: {L1, R2, L3} vs {R1, L2, R3}
      const f = 3.0;                                   // steps per second
      const ph = T * f * TAU;
      bodyY = Math.abs(Math.sin(ph)) * 0.006;
      pitch = -0.02;
      for (const side of ['left', 'right']) for (const seg of ['T1', 'T2', 'T3']) {
        const tri = ((side === 'left') ^ (seg === 'T2')) ? 0 : Math.PI;
        const p = ph + tri;
        const sw = Math.sin(p), lift = Math.max(0, Math.sin(p + Math.PI / 2)) ;  // lift during protraction
        this.leg(seg, side, { swing: sw * 0.28 * e, lift: lift * (sw > -0.2 ? 0.7 : 0) * e });
      }
      this.addJ('head', Math.sin(ph * 2) * 0.02);
      roll = Math.sin(ph) * 0.012;
    } else if (s === 'groom') {
      this.groomT += dt;
      if (this.groomT > 4500) { this.groomT = 0; this.groomMode = (this.groomMode + 1) % 3; }
      const gp = this.groomT / 1000;
      const rub = Math.sin(gp * TAU * 2.6), rub2 = Math.sin(gp * TAU * 2.6 + 1.2);
      const k = e * ease01((4500 - this.groomT) / 300);   // fade in/out between modes
      if (this.groomMode === 0) {
        // front legs sweep over the head / eyes, head bows
        this.applyPose(POSE.headGroomR, k); this.applyPose(POSE.headGroomL, k);
        this.addJ('head', -0.3 * k); pitch = 0.04 * k; bodyY = -0.004 * k;
        this.addJ('tibia_T1_right', rub * 0.35 * k); this.addJ('tarsus_T1_right', -rub * 0.5 * k); this.addJ('coxa_T1_right', rub * 0.12 * k);
        this.addJ('tibia_T1_left', -rub2 * 0.35 * k); this.addJ('tarsus_T1_left', rub2 * 0.5 * k); this.addJ('coxa_T1_left', -rub2 * 0.12 * k);
        this.addJ('antenna_left', 0.25 * k + rub * 0.08); this.addJ('antenna_right', 0.25 * k - rub * 0.08);
      } else if (this.groomMode === 1) {
        // front legs rubbing each other in front of the head
        this.applyPose(POSE.headGroomR, k * 0.8); this.applyPose(POSE.headGroomL, k * 0.8);
        this.addJ('femur_T1_right', 0.35 * k + rub * 0.25 * k); this.addJ('femur_T1_left', 0.35 * k - rub * 0.25 * k);
        this.addJ('tibia_T1_right', -rub * 0.5 * k); this.addJ('tibia_T1_left', rub * 0.5 * k);
        this.addJ('head', -0.12 * k);
      } else {
        // hind leg sweeps the abdomen / wing, alternating sides; wing flicks open a little
        const side = Math.sin(gp * 0.7) > 0 ? 'right' : 'left', sgn = side === 'left' ? 1 : -1;
        this.applyPose(side === 'right' ? POSE.abdGroomR : POSE.abdGroomL, k);
        this.addJ(`tibia_T3_${side}`, rub * 0.35 * k); this.addJ(`femur_T3_${side}`, rub * 0.15 * k); this.addJ(`tarsus_T3_${side}`, -rub * 0.4 * k);
        this.addJ(`wing_yaw_${side}`, -0.3 * k - rub * 0.06 * k); this.addJ(`wing_roll_${side}`, 0.15 * k);
        for (let j = 2; j <= 7; j++) this.addJ(`abdomen_${j}`, -0.05 * k + rub * 0.02 * k);
        this.addJ('abdomen_abduct', sgn * 0.08 * k);
        roll = -sgn * 0.05 * k; bodyY = 0.003 * k;
      }
    } else if (s === 'proboscis') {
      const pulse = Math.sin(T * TAU * 1.6) * 0.5 + 0.5, x = ease01(st / 320);
      this.addJ('head', -0.45 * x); pitch = 0.08 * x; bodyY = -0.006 * x;
      this.addJ('rostrum', -0.9 * x - pulse * 0.12 * x);
      this.addJ('haustellum', -1.1 * x - pulse * 0.2 * x);
      this.addJ('labrum_left', -0.5 * x * pulse); this.addJ('labrum_right', -0.5 * x * pulse);
      for (const side of ['left', 'right']) this.leg('T1', side, { swing: 0.15 * x, lift: 0.1 * x });
      this.addJ('antenna_left', 0.2 * x); this.addJ('antenna_right', 0.2 * x);
    } else if (s === 'sleep') {
      const x = ease01(st / 900);
      const slow = Math.sin(T * TAU * 0.25) * 0.5 + 0.5;
      bodyY = -0.02 * x + slow * 0.003; pitch = 0.03 * x; wingFlat = x;
      for (const side of ['left', 'right']) for (const seg of ['T1', 'T2', 'T3']) {
        const c = this.legCal[`${seg}_${side}`];
        this.addJ(`femur_${seg}_${side}`, -0.3 * x * c.femurUp);   // legs splay / sag
        this.addJ(`tibia_${seg}_${side}`, -0.25 * x * c.tibiaUp);
        this.addJ(`tarsus_${seg}_${side}`, 0.15 * x);
      }
      this.addJ('head', -0.2 * x);
      this.addJ('antenna_left', 0.35 * x); this.addJ('antenna_right', 0.35 * x);
      for (let j = 2; j <= 7; j++) this.addJ(`abdomen_${j}`, 0.04 * x);
    } else if (s === 'startle') {
      // crouch (0-120ms), jump (120-450), land (450-700)
      const c = ease01(st / 120), j = ease01((st - 120) / 160), l = ease01((st - 450) / 250);
      const hop = j * (1 - l);
      bodyY = -0.02 * c * (1 - j) + hop * 0.2;
      pitch = -0.22 * hop; wingBlur = hop; wingSpread = hop; shadowA = 1 - hop * 0.7; shadowS = 1 + hop * 0.6;
      for (const side of ['left', 'right']) for (const seg of ['T1', 'T2', 'T3']) {
        const cc = this.legCal[`${seg}_${side}`];
        this.leg(seg, side, { lift: -c * (1 - j) * 0.6 });                                   // crouch: flex
        this.addJ(`femur_${seg}_${side}`, -0.8 * hop * cc.femurUp); this.addJ(`tibia_${seg}_${side}`, -0.9 * hop * cc.tibiaUp);  // tuck in air
      }
      this.addJ('head', 0.15 * hop);
      for (let j2 = 2; j2 <= 7; j2++) this.addJ(`abdomen_${j2}`, -0.08 * hop);
    } else if (s === 'fly') {
      const x = ease01(st / 250);
      bodyY = x * (0.13 + Math.sin(T * TAU * 0.6) * 0.025 + Math.cos(T * TAU * 1.7) * 0.006);
      pitch = -0.3 * x + Math.sin(T * 1.3) * 0.03; roll = Math.sin(T * 0.8) * 0.05;
      wingBlur = x; wingSpread = x; shadowA = 1 - x * 0.75; shadowS = 1 + x * 0.6;
      for (const side of ['left', 'right']) for (const seg of ['T1', 'T2', 'T3']) {
        const cc = this.legCal[`${seg}_${side}`];
        this.addJ(`femur_${seg}_${side}`, -0.8 * x * cc.femurUp); this.addJ(`tibia_${seg}_${side}`, -0.8 * x * cc.tibiaUp);
      }
      for (let j = 2; j <= 7; j++) this.addJ(`abdomen_${j}`, -0.06 * x);
      this.addJ('head', 0.1 * x);
    }

    // wings
    if (wingBlur > 0) {
      const flap = Math.sin(T * TAU * 27);       // aliased fast flap; ghosts give the fan look
      for (const side of ['left', 'right']) {
        this.addJ(`wing_yaw_${side}`, -1.35 * wingSpread + flap * 0.55 * wingBlur);
        this.addJ(`wing_roll_${side}`, -0.45 * wingSpread + flap * 0.35 * wingBlur);
        this.addJ(`wing_pitch_${side}`, 0.35 * wingSpread);
      }
    } else if (wingFlat > 0) {
      for (const side of ['left', 'right']) { this.addJ(`wing_roll_${side}`, -0.25 * wingFlat); this.addJ(`wing_pitch_${side}`, 0.15 * wingFlat); }
    } else {
      // resting wings: tiny settle
      const w = Math.sin(T * 0.9) * 0.01;
      this.addJ('wing_roll_left', w); this.addJ('wing_roll_right', -w);
    }
    this.wingBlur = wingBlur; this.wingSpread = wingSpread;

    // body placement
    const targetYaw = this.yawOverride !== undefined ? this.yawOverride : (this.dir > 0 ? this.yawR : this.yawL);
    if (this.yaw === undefined) this.yaw = targetYaw;
    let dy = targetYaw - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, dt / 220);
    this.mover.rotation.y = this.yaw + yaw;
    this.mover.position.x = (this.x - 0.5) * this.visW;
    this.lift.position.y = bodyY;
    this.lift.rotation.z = pitch;   // MuJoCo x forward -> pitch about z after root rotation? root maps y->z; pitch about world z is a nose-up/down of a fly facing +x
    this.lift.rotation.x = roll;
    this.shadow.material.opacity = shadowA;
    this.shadow.scale.set(1.15 * shadowS, 0.85 * shadowS, 1);

    // ghosts
    const showGhost = wingBlur > 0.2;
    for (const g of this.ghosts) {
      g.o.visible = showGhost;
      if (!showGhost) continue;
      const q = new THREE.Quaternion(), wb = g.wb;
      const js = wb.userData.joints;   // yaw, roll, pitch
      const ph = (g.k - 1) * 0.7;
      wb.quaternion.copy(wb.userData.q0);
      const sgn = 1;
      const vals = [js[0].ref + js[0].v + ph * 0.55 * sgn, js[1].ref + js[1].v + ph * 0.35, js[2].ref + js[2].v];
      const qq = wb.userData.q0.clone();
      for (let i = 0; i < 3; i++) { q.setFromAxisAngle(js[i].axis, vals[i]); qq.multiply(q); }
      g.o.quaternion.copy(qq);
      g.o.children[0].material.opacity = 0.07 * wingBlur;
    }

    // overlays
    const asleep = s === 'sleep';
    this.zzz.forEach((z, i) => {
      z.visible = asleep && st > 600;
      if (!z.visible) return;
      const ph = ((T / 1.6) + i / 3) % 1;
      z.position.set(this.mover.position.x + 0.22 + i * 0.05 + Math.sin(ph * TAU) * 0.04, 0.35 + ph * 0.45, 0.25);
      const sc = 0.12 + ph * 0.1; z.scale.set(sc, sc, 1);
      z.material.opacity = Math.sin(ph * Math.PI);
    });
    const spark = s === 'proboscis' && st < 1400;
    this.sparks.forEach((sp, i) => {
      sp.visible = spark;
      if (!spark) return;
      const a = i * TAU / 6 + T * 1.4, r = 0.35 + (st / 1400) * 0.25;
      sp.position.set(this.mover.position.x + Math.cos(a) * r, 0.35 + Math.sin(a) * r * 0.5, 0.3);
      sp.material.opacity = 0.9 * (1 - st / 1400);
    });
  }
}
