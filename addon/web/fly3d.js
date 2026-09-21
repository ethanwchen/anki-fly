// 3D fruit fly sprite (three.js). Same API as fly_sprite.js:
//   new FlySprite(canvas); .setState(s); .update(dtMs); .draw(); .resize()
// States: idle, walk, groom, proboscis, sleep, startle, fly (free-standing)
//         study, pressAgain, pressHard, pressGood, pressEasy, celebrate, dance, zoomies, crashout, sulk, sleepDesk, still (scene 'study')
//         think, write, sleepDesk, still (scene 'exam'); setScene('study'|'exam'|null)
//
// Geometry: anatomically detailed Drosophila body from TuragaLab/flybody (Apache-2.0),
// decimated and baked into vendor/fly.bin (see vendor/LICENSE-flybody.txt). The MuJoCo
// kinematic tree (bodies + hinge joints) is preserved so parts articulate: legs (coxa /
// femur / tibia / 5 tarsal segments), head, antennae, proboscis (rostrum / haustellum /
// labella), wings (yaw/roll/pitch), halteres and 7 abdominal segments.

import { FlySprite as FlySprite2D } from './fly_sprite.js';

const THREE = window.THREE;

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
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
      // each facet is a little dome: approximate its normals with 4 tilted quadrant wedges
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

// scene states (the fly stays at its desk), auto-chains and how 'sleep' maps when a scene is set
const SCENE_STATES = new Set(['study', 'pressAgain', 'pressHard', 'pressGood', 'pressEasy', 'celebrate', 'dance', 'zoomies', 'crashout', 'sulk', 'think', 'write', 'sleepDesk', 'still']);
const PRESS = { pressAgain: 'again', pressHard: 'hard', pressGood: 'good', pressEasy: 'easy' };
const ALL_STATES = new Set(['idle', 'walk', 'groom', 'proboscis', 'sleep', 'startle', 'fly', ...SCENE_STATES]);
const CHAIN = { pressAgain: ['study', 700], pressHard: ['study', 700], pressGood: ['study', 700], pressEasy: ['study', 700], celebrate: ['study', 800], dance: ['study', 2200], zoomies: ['study', 3000], crashout: ['sulk', 2800], write: ['think', 800] };

function cardTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 80;
  const g = c.getContext('2d');
  g.fillStyle = '#f7f4ea'; g.fillRect(0, 0, 128, 80);
  g.strokeStyle = '#d9534f'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 18); g.lineTo(128, 18); g.stroke();
  g.strokeStyle = '#9fb7d9'; g.lineWidth = 1;
  for (let y = 34; y < 80; y += 12) { g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke(); }
  g.strokeStyle = '#3b3f4a'; g.lineWidth = 1.6; g.beginPath();
  g.moveTo(10, 30); g.bezierCurveTo(30, 22, 50, 38, 70, 30); g.bezierCurveTo(85, 25, 100, 34, 118, 29); g.stroke();
  g.beginPath(); g.moveTo(10, 42); g.bezierCurveTo(30, 36, 45, 48, 60, 42); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function paperTexture() {
  const c = document.createElement('canvas'); c.width = 160; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#fbfaf5'; g.fillRect(0, 0, 160, 128);
  g.fillStyle = '#22252e'; g.font = 'bold 20px ui-sans-serif, system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('EXAM', 80, 24);
  g.strokeStyle = '#22252e'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(20, 30); g.lineTo(140, 30); g.stroke();
  g.strokeStyle = '#c9d3e6'; g.lineWidth = 1;
  for (let y = 48; y < 128; y += 14) { g.beginPath(); g.moveTo(14, y); g.lineTo(146, y); g.stroke(); }
  g.fillStyle = '#3b3f4a'; g.font = '9px ui-sans-serif, system-ui, sans-serif'; g.textAlign = 'left';
  g.fillText('1.  ____________', 16, 45); g.fillText('2.  ____________', 16, 59); g.fillText('3.  ____________', 16, 73);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

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
    if (!THREE) return FlySprite.fallback(canvas, 'three.js not loaded');
    try { this.init(canvas); } catch (e) { return FlySprite.fallback(canvas, e && e.message); }
  }
  static fallback(canvas, why) {
    console.warn('[fly3d] falling back to 2D sprite:', why);
    return new FlySprite2D(canvas);
  }
  init(canvas) {
    this.canvas = canvas;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.state = 'idle'; this.stateT = 0; this.prevState = 'idle'; this.blendT = 1;
    this.x = 0.52; this.dir = 1; this.t = 0;
    this.ready = false; this.failed = false;
    this.J = {};                 // joint name -> {body, i, v}
    this.bodies = [];            // Object3D per MuJoCo body
    this.legShift = { t: 0, leg: 0, a: 0 };
    this.groomMode = 0; this.groomT = 0;
    this.antT = 0; this.antA = 0;
    this.fovY = 28;
    this.sceneName = null; this.sceneGroup = null; this.props = {}; this.reach = {};
    this.tapT = 2000; this.tapA = 0; this.needsRender = true; this.lastRequested = 'idle';

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.fovY, 0.6, 0.5, 30);
    this.world = new THREE.Group(); this.scene.add(this.world);   // ground-level frame
    this.stage = new THREE.Group(); this.world.add(this.stage);   // desk props, oriented like the fly
    this.mover = new THREE.Group(); this.world.add(this.mover);   // translates/turns the fly
    this.lift = new THREE.Group(); this.mover.add(this.lift);     // vertical hops / crouch
    this.root = new THREE.Group(); this.lift.add(this.root);      // z-up MuJoCo -> y-up
    this.root.rotation.x = -Math.PI / 2;

    // lights: soft sky, warm key, cool rim, faint fill from below
    this.hemi = new THREE.HemisphereLight(0xdfe6ff, 0x3a2a18, 0.8); this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xfff1dc, 2.2); this.key.position.set(2.5, 5, 3); this.scene.add(this.key);
    this.rimL = new THREE.DirectionalLight(0x9ec2ff, 1.6); this.rimL.position.set(-3, 3, -4); this.scene.add(this.rimL);
    this.fillL = new THREE.DirectionalLight(0xffe0c0, 0.5); this.fillL.position.set(-2, -1, 3); this.scene.add(this.fillL);
    this.baseLights = { hemi: 0.8, key: 2.2, rim: 1.6, fill: 0.5 };

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
      s.visible = false; s.renderOrder = 10; this.world.add(s); this.zzz.push(s);
    }
    this.sparks = [];
    const st = sparkTexture();
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: st, transparent: true, depthTest: false, blending: THREE.AdditiveBlending }));
      s.visible = false; s.renderOrder = 10; s.scale.set(0.12, 0.12, 1); this.world.add(s); this.sparks.push(s);
    }

    this.resize();
    loadFlyBin(new URL('vendor/fly.bin', import.meta.url)).then(d => this.build(d)).catch(e => { this.failed = true; console.warn('[fly3d]', e); });
  }

  // ---------- scenes ----------
  setScene(name) {
    name = name || null;
    if (name === this.sceneName) return;
    if (this.sceneGroup) { this.stage.remove(this.sceneGroup); this.sceneGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    if (this.lampLight) { this.scene.remove(this.lampLight); this.lampLight = null; }
    this.sceneGroup = null; this.props = {}; this.reach = {}; this.sceneName = name;
    if (name === 'study') this.buildStudy(); else if (name === 'exam') this.buildExam();
    // dark-room mood in scenes: dim the ambient/key lights so the lamp pool carries the picture
    const L = this.baseLights, k = name ? 0.5 : 1;
    this.hemi.intensity = L.hemi * k; this.key.intensity = L.key * (name ? 0.7 : 1); this.rimL.intensity = L.rim * (name ? 0.12 : 1); this.hemi.color.set(name ? 0xd8c8b0 : 0xdfe6ff); this.fillL.intensity = L.fill * k;
    if (name && !SCENE_STATES.has(this.state)) this.setState(this.state === 'sleep' ? 'sleepDesk' : 'study');
    this.needsRender = true;
    this.layout();
  }

  // stage frame: x = fly forward, z = fly right, y up; desk top is y = 0
  buildStudy() {
    const G = this.sceneGroup = new THREE.Group(); this.stage.add(G);
    const wood = new THREE.MeshStandardMaterial({ color: 0x3a2010, roughness: 0.5, metalness: 0.05 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 1.5), wood); desk.position.set(0.15, -0.06, 0); G.add(desk);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.05, 1.5), new THREE.MeshStandardMaterial({ color: 0x2c1d14, roughness: 0.8 }));
    edge.position.set(0.15, -0.145, 0); G.add(edge);
    this.fitPoints = [[0.48, 0.1, 0.42], [0.55, 0.1, 0.12], [0.55, 0.1, -0.1], [0.48, 0.1, -0.4], [0.32, 0.1, 0.42], [0.34, 0.08, -0.66], [-0.04, 0.08, -0.7], [0.0, 0.08, -0.46]];
    // index cards: a small stack, top one face up with writing
    const cardMat = new THREE.MeshStandardMaterial({ color: 0xf2eee2, roughness: 0.9 });
    const stack = new THREE.Group(); stack.position.set(0.14, 0, -0.56); stack.rotation.y = 0.35; G.add(stack);
    for (let i = 0; i < 5; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.012, 0.26), cardMat);
      c.position.set((Math.sin(i * 2.1)) * 0.012, 0.006 + i * 0.012, (Math.cos(i * 1.7)) * 0.012); c.rotation.y = (i - 2) * 0.05; stack.add(c);
    }
    const top = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.26), new THREE.MeshStandardMaterial({ map: cardTexture(), roughness: 0.9 }));
    top.rotation.x = -Math.PI / 2; top.position.set(0, 0.0125 + 5 * 0.012, 0); stack.add(top);
    this.props.card = stack;
    // two buttons: red (Again) and green (Good)
    const mkButton = (color, x, z) => {
      const g = new THREE.Group(); g.position.set(x, 0, z); G.add(g);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.035, 20), new THREE.MeshStandardMaterial({ color: 0x3a3d46, roughness: 0.6, metalness: 0.3 }));
      base.position.y = 0.0175; g.add(base);
      const capMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, clearcoat: 0.6, emissive: color, emissiveIntensity: 0.05 });
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.066, 0.074, 0.05, 20), capMat); cap.position.y = 0.035 + 0.025; g.add(cap);
      return { g, cap, capMat, restY: cap.position.y };
    };
    // Anki order left -> right on screen (+z is screen-left): Again, Hard, Good, Easy, in a slight arc toward the fly
    this.buttonPos = { again: [0.4, 0.34], hard: [0.47, 0.12], good: [0.47, -0.1], easy: [0.4, -0.32] };
    const BTN = { again: 0xe5484d, hard: 0xe0a53a, good: 0x5fbf6b, easy: 0x4f8ff0 };
    for (const b in BTN) this.props[b] = mkButton(BTN[b], this.buttonPos[b][0], this.buttonPos[b][1]);
    // warm pool of light over the desk (the lamp itself is off-screen)
    this.lampLight = new THREE.PointLight(0xffc98a, 9, 2.4, 1.8);
    G.add(this.lampLight); this.lampLight.position.set(-0.05, 0.5, -0.05);
    this.lampWorldLight = true;
    // fly heading for this scene: 3/4 toward the viewer
    this.sceneYaw = this.az - Math.PI / 2 + 0.55;   // az - pi/2 faces the camera; +0.55 turns it toward screen-right
    this.reachSide = { again: 'left', hard: 'left' };   // targets on the fly's left (+z) use the left front leg
    this.reachTargets = {
      again: () => this.stageToWorld(0.4, 0.09, 0.34),
      hard: () => this.stageToWorld(0.47, 0.09, 0.12),
      good: () => this.stageToWorld(0.47, 0.09, -0.1),
      easy: () => this.stageToWorld(0.4, 0.09, -0.32),
      card: () => this.stageToWorld(0.16, 0.09, -0.44),
    };
  }

  buildExam() {
    const G = this.sceneGroup = new THREE.Group(); this.stage.add(G);
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 1.5), new THREE.MeshStandardMaterial({ color: 0x2c3a33, roughness: 0.7 }));
    top.position.set(0.3, -0.06, 0); G.add(top);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.05, 1.5), new THREE.MeshStandardMaterial({ color: 0x1a241f, roughness: 0.9 }));
    rim.position.set(0.3, -0.145, 0); G.add(rim);
    this.lampLight = new THREE.PointLight(0xfff0d0, 3.5, 2.8, 1.6); this.lampLight.position.set(0.1, 0.7, -0.1); G.add(this.lampLight);
    this.fitPoints = [[1.05, 0.01, -0.2], [1.05, 0.01, 0.45], [0.4, 0.01, 0.45], [0.55, 0.4, 0.06]];
    // exam sheet
    // sheet squared to the viewer (its x axis parallel to the camera's right vector) so the header reads
    const paper = new THREE.Group(); paper.position.set(0.72, 0.006, 0.12); paper.rotation.y = Math.PI / 2 - 0.6; G.add(paper);
    const sheet = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.01, 0.58), new THREE.MeshStandardMaterial({ color: 0xfbfaf5, roughness: 0.95 })); paper.add(sheet);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.58), new THREE.MeshStandardMaterial({ map: paperTexture(), roughness: 0.95 }));
    face.rotation.x = -Math.PI / 2; face.position.y = 0.0055; paper.add(face);
    this.props.paper = paper;
    // pencil: tip at the group origin, shaft along +z; oriented each frame toward the holding claw
    const pencil = new THREE.Group(); G.add(pencil); this.props.pencil = pencil;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), new THREE.MeshStandardMaterial({ color: 0xe8b62a, roughness: 0.6 }));
    shaft.rotation.x = Math.PI / 2; shaft.position.z = 0.3; pencil.add(shaft);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.06, 6), new THREE.MeshStandardMaterial({ color: 0xd8c9a6, roughness: 0.7 }));
    tip.rotation.x = -Math.PI / 2; tip.position.z = 0.03; pencil.add(tip);
    const lead = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.02, 6), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    lead.rotation.x = -Math.PI / 2; lead.position.z = 0.01; pencil.add(lead);
    const eraser = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.05, 6), new THREE.MeshStandardMaterial({ color: 0xe58a9a, roughness: 0.8 }));
    eraser.rotation.x = Math.PI / 2; eraser.position.z = 0.575; pencil.add(eraser);
    const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 6), new THREE.MeshStandardMaterial({ color: 0xb8b8c0, metalness: 0.7, roughness: 0.4 }));
    ferrule.rotation.x = Math.PI / 2; ferrule.position.z = 0.54; pencil.add(ferrule);
    this.pencilTip = new THREE.Vector3(0.62, 0.012, 0.05);   // stage coords, on the paper
    this.sceneYaw = this.az - Math.PI / 2 + 0.6;
    this.reachTargets = { pencil: () => this.stageToWorld(0.55, 0.2, 0.06) };
  }

  // Place the camera (fixed elevation/azimuth) so the fly plus the scene's key props fit with an 8% margin.
  fitScene(el, az) {
    const f = new THREE.Vector3(-Math.sin(az) * Math.cos(el), -Math.sin(el), -Math.cos(az) * Math.cos(el));   // view direction
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, f).normalize();
    const rotY = new THREE.Matrix4().makeRotationY(this.sceneYaw);
    const pts = [];
    const B = this.flyBox;
    for (const x of [B.min.x, B.max.x]) for (const y of [B.min.y, B.max.y]) for (const z of [B.min.z, B.max.z]) pts.push(new THREE.Vector3(x, y, z).applyMatrix4(rotY));
    for (const p of this.fitPoints || []) pts.push(new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(rotY));
    const tanY = Math.tan(this.fovY / 2 * Math.PI / 180), tanX = tanY * this.camera.aspect, m = 0.93;
    let L = new THREE.Vector3(0, 0.1, 0);
    for (let pass = 0; pass < 3; pass++) {
      let d = 0, xmin = 1e9, xmax = -1e9, ymin = 1e9, ymax = -1e9;
      const q = new THREE.Vector3();
      for (const P of pts) {
        q.copy(P).sub(L);
        const x = q.dot(right), y = q.dot(up), z = q.dot(f);
        d = Math.max(d, Math.abs(x) / (tanX * m) - z, Math.abs(y) / (tanY * m) - z);
      }
      // recentre: measure projected extents at that distance and shift the look point
      for (const P of pts) {
        q.copy(P).sub(L);
        const depth = q.dot(f) + d, sx = q.dot(right) / depth, sy = q.dot(up) / depth;
        xmin = Math.min(xmin, sx); xmax = Math.max(xmax, sx); ymin = Math.min(ymin, sy); ymax = Math.max(ymax, sy);
      }
      L = L.clone().addScaledVector(right, (xmin + xmax) / 2 * d).addScaledVector(up, (ymin + ymax) / 2 * d);
      this.camDist = d;
    }
    this.lookAt = L;
    this.camera.position.copy(L).addScaledVector(f, -this.camDist);
    this.camera.lookAt(L);
    this.visH = 2 * this.camDist * tanY; this.visW = this.visH * this.camera.aspect;
  }

  stageToWorld(x, y, z) { this.stage.updateWorldMatrix(true, false); return this.stage.localToWorld(new THREE.Vector3(x, y, z)); }

  // coordinate-descent IK: pose (joint -> offset) that brings the claw of a leg to a world-space target
  solveReach(seg, side, target) {
    const names = [`coxa_abduct_${seg}_${side}`, `coxa_twist_${seg}_${side}`, `coxa_${seg}_${side}`, `femur_twist_${seg}_${side}`, `femur_${seg}_${side}`, `tibia_${seg}_${side}`, `tarsus_${seg}_${side}`];
    const claw = this.byName[`claw_${seg}_${side}`];
    const vals = {}; for (const n of names) vals[n] = 0;
    const tip = new THREE.Vector3();
    const cost = () => {
      for (const k in this.J) this.J[k].v = 0;
      for (const n of names) this.J[n].v = vals[n];
      this.applyJoints(); this.root.updateWorldMatrix(true, true);
      claw.getWorldPosition(tip);
      let c = tip.distanceTo(target);
      for (const n of names) { const j = this.J[n], a = j.ref + vals[n]; if (a < j.lo) c += (j.lo - a) * 0.5; if (a > j.hi) c += (a - j.hi) * 0.5; }
      return c;
    };
    let best = cost(), step = 0.5;
    for (let it = 0; it < 40; it++) {
      let improved = false;
      for (const n of names) for (const d of [step, -step]) {
        vals[n] += d; const c = cost();
        if (c < best - 1e-6) { best = c; improved = true; } else vals[n] -= d;
      }
      if (!improved) step *= 0.6;
      if (step < 0.01) break;
    }
    for (const k in this.J) this.J[k].v = 0;
    return vals;
  }

  // lazily solve the reach poses for the current scene (needs the fly parked in its scene pose)
  ensureReach() {
    if (!this.ready || !this.sceneName || this.reach.done) return;
    this.mover.rotation.y = this.sceneYaw; this.mover.position.x = 0; this.lift.position.y = 0; this.lift.rotation.set(0, 0, 0);
    this.stage.rotation.y = this.sceneYaw; this.stage.updateWorldMatrix(true, true);
    this.mover.updateWorldMatrix(true, true);
    for (const k in this.reachTargets) this.reach[k] = this.solveReach('T1', (this.reachSide || {})[k] || 'right', this.reachTargets[k]());
    this.reach.done = true;
    // parking pose for the pencil-holding leg is the same solve
  }

  // ---------- model construction ----------
  materials() {
    const eyeN = eyeNormalMap();
    const M = {
      body: new THREE.MeshStandardMaterial({ color: 0x8c6230, roughness: 0.62, metalness: 0.0 }),
      bodyVC: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.0 }),
      lowerVC: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.7 }),
      lower: new THREE.MeshStandardMaterial({ color: 0xb08a55, roughness: 0.7 }),
      black: new THREE.MeshStandardMaterial({ color: 0x1b1410, roughness: 0.75 }),
      'bristle-brown': new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.8 }),
      brown: new THREE.MeshStandardMaterial({ color: 0x2e1a0e, roughness: 0.6 }),
      ocelli: new THREE.MeshPhysicalMaterial({ color: 0x5a2a10, roughness: 0.15, clearcoat: 1 }),
      red: new THREE.MeshPhysicalMaterial({ color: 0xb8321e, roughness: 0.3, metalness: 0.05, clearcoat: 0.9, clearcoatRoughness: 0.25,
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
    this.flyBox = new THREE.Box3(new THREE.Vector3(-0.5, 0, -(box.max.z - box.min.z) / 2 * s), new THREE.Vector3(0.5, size.y * s, (box.max.z - box.min.z) / 2 * s));
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
    const aspect = this.camera.aspect;
    let visH, el, az, look;
    if (this.sceneName === 'study') {
      visH = 1.55; el = 0.72; az = 0.85; look = new THREE.Vector3(0.12, 0.1, 0.02);
    } else if (this.sceneName === 'exam') {
      visH = 1.25; el = 0.7; az = 0.95; look = new THREE.Vector3(0.3, 0.06, 0.12);
    } else {
      // free-standing: 3/4 view from slightly above; fly length ~1 fills ~80% of the width
      const wantW = 1.0 / 0.80;
      visH = Math.max(wantW / aspect, 1.6); el = 0.72; az = 0.95; look = new THREE.Vector3(0, 0.12 + visH * 0.13, 0);
    }
    const dist = (visH / 2) / Math.tan(this.fovY / 2 * Math.PI / 180);
    this.camDist = dist; this.az = az;
    this.camera.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    this.lookAt = look;
    this.camera.lookAt(this.lookAt);
    this.visW = visH * aspect;
    this.visH = visH;
    if (this.sceneName === 'study') this.sceneYaw = az - Math.PI / 2 + 0.55;
    if (this.sceneName === 'exam') this.sceneYaw = az - Math.PI / 2 + 0.6;
    if (this.sceneName && this.ready) this.fitScene(el, az);
    this.reach = {};   // camera/heading changed: re-solve reaches lazily
    this.needsRender = true;
    // fly heading when free: screen-right (or left) turned ~25 deg toward the viewer
    this.yawR = az - 0.45; this.yawL = az + Math.PI + 0.45;
  }

  // Repeated calls with the same name are idempotent, even after an auto-chain (pressGood -> study)
  // has already moved on, so a caller that sets the state every frame does not restart the animation.
  setState(s) {
    if (!ALL_STATES.has(s)) s = 'idle';
    if (s === this.lastRequested) return;
    this.lastRequested = s;
    this._go(s);
  }
  _go(s) {
    if (this.sceneName && s === 'sleep') s = 'sleepDesk';
    if (!this.sceneName && SCENE_STATES.has(s)) s = s === 'sleepDesk' ? 'sleep' : 'idle';
    if (s !== this.state) { this.prevState = this.state; this.state = s; this.stateT = 0; this.blendT = 0; this.needsRender = true; }
  }

  update(dt) {
    dt = Math.min(dt, 80);
    const s = this.state;
    if (s === 'still') { if (!this.ready) return; if (!this.stillPosed) { this.pose(0); this.applyJoints(); this.stillPosed = true; this.needsRender = true; } return; }
    this.stillPosed = false;
    this.t += dt; this.stateT += dt; this.blendT = Math.min(1, this.blendT + dt / 260);
    const chain = CHAIN[s];
    if (chain && this.stateT >= chain[1]) { this._go(chain[0]); }
    if (s === 'walk') {
      this.x += this.dir * dt * 0.00011;
      const lo = this.sceneName ? 0.36 : 0.28, hi = this.sceneName ? 0.64 : 0.72;
      if (this.x > hi) this.dir = -1; else if (this.x < lo) this.dir = 1;
    } else if (s === 'fly') {
      this.x += ((0.5 + Math.sin(this.t / 900) * 0.09) - this.x) * Math.min(1, dt / 300);
    } else if (SCENE_STATES.has(s)) {
      this.x += (0.5 - this.x) * Math.min(1, dt / 300);
    }
    if (!this.ready) return;
    this.ensureReach();
    this.pose(dt);
    if (this.dbg) for (const k in this.dbg) this.addJ(k, this.dbg[k]);   // dev hook: extra joint offsets
    this.applyJoints();
    this.needsRender = true;
  }

  draw() {
    if (!this.ready) { this.renderer.clear(); return; }
    if (!this.needsRender) return;          // 'still' renders once, then idles
    this.renderer.render(this.scene, this.camera);
    this.needsRender = this.state !== 'still';
  }

  // ---------- posing ----------
  setJ(name, v) { const j = this.J[name]; if (j) j.v = v; }
  addJ(name, v) { const j = this.J[name]; if (j) j.v += v; }

  // Measure, per leg, which joint/sign swings the foot forward and which lifts it,
  // so gait code is independent of the model's joint conventions.
  calibrateLegs() {
    const tip = new THREE.Vector3();
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

    const still = s === 'still';
    // ambient life: breathing, antenna twitches, haltere jitter (none at all when 'still')
    const breath = still ? 0.5 : Math.sin(T * TAU * 0.55) * 0.5 + 0.5;
    this.antT -= dt;
    if (this.antT <= 0) { this.antT = 900 + Math.random() * 3200; this.antA = 1; }
    this.antA = Math.max(0, this.antA - dt / 350);
    const antTw = still ? 0 : Math.sin(this.antA * Math.PI) * 0.25;
    this.addJ('antenna_left', antTw); this.addJ('antenna_right', antTw * 0.7);
    this.addJ('antenna_abduct_left', -antTw * 0.5); this.addJ('antenna_abduct_right', antTw * 0.5);
    for (let k = 2; k <= 7; k++) this.addJ(`abdomen_${k}`, -0.03 + breath * 0.04);
    this.addJ('abdomen', -0.02 + breath * 0.03);
    if (!still) { this.addJ('haltere_left', Math.sin(T * 9) * 0.05); this.addJ('haltere_right', Math.cos(T * 8) * 0.05); }
    let pressBtn = null, pressAmt = 0, pencilHold = 0, scribble = null;

    if (SCENE_STATES.has(s)) {
      // ---- desk states ----
      const R = this.reach;
      if (s === 'study' || s === 'still' || PRESS[s] || s === 'celebrate') {
        // looking down at the face-up card
        this.addJ('head', -0.32); this.addJ('head_abduct', 0.18);
        bodyY = still ? 0 : breath * 0.005;
        if (s === 'study') {
          this.tapT -= dt;
          if (this.tapT <= 0) { this.tapT = 2600 + Math.random() * 4000; this.tapA = 1; }
          this.tapA = Math.max(0, this.tapA - dt / 700);
          if (this.tapA > 0 && R.card) {
            const k = Math.sin(this.tapA * Math.PI), tap = Math.max(0, Math.sin(this.tapA * TAU * 2)) * 0.12;
            this.applyPose(R.card, k); this.addJ('tibia_T1_right', tap * k);
          }
          if (!still) { this.addJ('head_twist', Math.sin(T * 0.6) * 0.06); this.addJ('head', Math.sin(T * 0.45) * 0.03); }
        } else if (PRESS[s]) {
          // reach (0-250) -> press (250-450) -> return (450-700); reluctant (slow, slumped) when pressing from 'sulk'
          const sulky = this.prevState === 'sulk' && s === 'pressAgain';
          const ts = sulky ? st * 700 / 1400 : st;
          const reach = ease01(ts / 250) * (1 - ease01((ts - 450) / 250));
          pressAmt = ease01((ts - 250) / 90) * (1 - ease01((ts - 420) / 120));
          if (sulky) { bodyY -= 0.02; this.addJ('head', -0.25); for (const sd2 of ['left', 'right']) { this.addJ(`wing_roll_${sd2}`, -0.2); this.addJ(`antenna_${sd2}`, 0.35); } }
          pressBtn = PRESS[s];
          const P = R[pressBtn]; if (P) this.applyPose(P, reach);
          const sd = (this.reachSide || {})[pressBtn] || 'right';
          this.addJ(`tibia_T1_${sd}`, pressAmt * 0.18 * reach); this.addJ(`femur_T1_${sd}`, pressAmt * 0.08 * reach);
          const bz = this.buttonPos[pressBtn][1];
          this.addJ('head', 0.12 * reach); this.addJ('head_abduct', (-0.25 + bz * 0.6) * reach);   // watch the button
          pitch = 0.03 * reach; bodyY -= 0.006 * pressAmt;
        } else if (s === 'celebrate') {
          const k = ease01(st / 80) * (1 - ease01((st - 550) / 250));
          const hop = Math.max(0, Math.sin(clamp(st - 60, 0, 480) / 480 * Math.PI));
          bodyY += hop * 0.11; wingSpread = k * 0.55;
          const flick = Math.sin(st / 1000 * TAU * 6) * 0.15 * k;
          this.addJ('wing_yaw_left', flick); this.addJ('wing_yaw_right', flick);
          this.addJ('head', 0.45 * k); pitch = -0.08 * hop;
          for (const side of ['left', 'right']) this.leg('T1', side, { lift: hop * 0.5, swing: 0.2 * hop });
          for (let j = 2; j <= 7; j++) this.addJ(`abdomen_${j}`, -0.05 * k);
          shadowA = 1 - hop * 0.4; shadowS = 1 + hop * 0.3;
        }
      } else if (s === 'think' || s === 'write') {
        pencilHold = 1;
        if (R.pencil) this.applyPose(R.pencil, 1);
        this.addJ('head', -0.25); this.addJ('head_abduct', 0.15);
        bodyY = breath * 0.004;
        if (s === 'think') {
          // pencil tapping, head sway
          const tap = Math.max(0, Math.sin(T * TAU * 1.4)) ** 3;
          this.addJ('tibia_T1_right', -tap * 0.12); this.addJ('femur_T1_right', tap * 0.05);
          this.addJ('head_twist', Math.sin(T * 0.9) * 0.12); this.addJ('head', Math.sin(T * 0.5) * 0.05 + 0.08 * Math.max(0, Math.sin(T * 0.25)));
          scribble = { x: 0, z: 0, down: 1 - tap * 0.6 };
        } else {
          // scribbling: fast small strokes advancing along a line
          const u = st / 800, f = T * TAU;
          const sx = Math.sin(f * 7) * 0.02 + u * 0.16, sz = Math.cos(f * 5.3) * 0.025 - 0.08 + u * 0.05;
          this.addJ('tibia_T1_right', Math.sin(f * 7) * 0.05); this.addJ('femur_T1_right', Math.cos(f * 5.3) * 0.03);
          this.addJ('coxa_abduct_T1_right', Math.sin(f * 3.5) * 0.04);
          this.addJ('head', 0.04 * Math.sin(f * 1.2)); this.addJ('head_abduct', 0.1 * u);
          scribble = { x: sx, z: sz, down: 1 };
        }
      } else if (s === 'dance') {
        // rapid hops with wing flicks, side-to-side wiggle, head bob, front legs up
        const k = ease01(st / 120) * (1 - ease01((st - 2000) / 200));
        const hopF = 4.2, hp = (st / 1000) * hopF;
        const hop = Math.max(0, Math.sin(hp * TAU)) ** 1.5;
        bodyY = hop * 0.09 * k; roll = Math.sin(hp * TAU * 0.5) * 0.22 * k; yaw = Math.sin(hp * TAU * 0.5) * 0.25 * k;
        pitch = -0.1 * hop * k;
        wingSpread = k * 0.5 + hop * 0.35 * k;
        const flick = Math.cos(hp * TAU) * 0.3 * k;
        this.addJ('wing_yaw_left', flick); this.addJ('wing_yaw_right', -flick);
        this.addJ('head', (0.4 + Math.sin(hp * TAU * 2) * 0.2) * k); this.addJ('head_twist', Math.sin(hp * TAU) * 0.15 * k);
        for (const side of ['left', 'right']) { const sg = side === 'left' ? 1 : -1; this.leg('T1', side, { lift: (0.8 + Math.sin(hp * TAU + sg) * 0.3) * k, swing: (0.3 + Math.sin(hp * TAU * 0.5) * 0.2 * sg) * k }); this.leg('T2', side, { lift: hop * 0.3 * k }); this.leg('T3', side, { lift: hop * 0.35 * k }); }
        for (let j = 2; j <= 7; j++) this.addJ(`abdomen_${j}`, (-0.05 + Math.sin(hp * TAU) * 0.04) * k);
        shadowA = 1 - hop * 0.35; shadowS = 1 + hop * 0.25;
      } else if (s === 'zoomies') {
        // sprint tight laps around the desk spot; ends back at the spot facing the viewer
        const laps = 2, dur = 3000, u = clamp(st / dur, 0, 1), ramp = ease01(st / 300) * (1 - ease01((st - dur + 400) / 400));
        const ang = smooth(u) * TAU * laps, R0 = 0.2 * ramp;
        this.lap = { x: Math.cos(ang) * R0 - R0, z: Math.sin(ang) * R0, yaw: -(ang + Math.PI / 2), w: ramp };
        const ph = (st / 1000) * 6.0 * TAU;   // 2x walk gait
        bodyY = Math.abs(Math.sin(ph)) * 0.008 * ramp;
        roll = 0.28 * ramp; pitch = -0.05 * ramp;   // banked turn
        for (const side of ['left', 'right']) for (const seg of ['T1', 'T2', 'T3']) {
          const tri = ((side === 'left') ^ (seg === 'T2')) ? 0 : Math.PI, p = ph + tri, sw = Math.sin(p), lift = Math.max(0, Math.sin(p + Math.PI / 2));
          this.leg(seg, side, { swing: sw * 0.32 * ramp, lift: lift * (sw > -0.2 ? 0.75 : 0) * ramp });
        }
        this.addJ('head', 0.15 * ramp); this.addJ('head_abduct', 0.3 * ramp);
        wingSpread = 0.12 * ramp;
      } else if (s === 'crashout') {
        // frantic spin (0-900) -> flop onto back (900-1300) -> twitch (1300-2200) -> slowly get up (2200-2800)
        const spinK = ease01(st / 100) * (1 - ease01((st - 800) / 200));
        const flop = ease01((st - 900) / 350) * (1 - ease01((st - 2200) / 600));
        const buzz = Math.sin(st * 0.9) * Math.sin(st * 0.37);
        yaw = (st / 1000) * TAU * 2.2 * spinK; roll = Math.PI * flop + Math.sin(st * 0.02) * 0.12 * spinK;
        // rolled onto its back: the roll pivot is at the feet, so lift the body by its height to keep it on the desk
        bodyY = spinK * (0.03 + Math.abs(buzz) * 0.04) + Math.sin(Math.PI * flop / 2) ** 2 * this.bodyH * 0.62;
        wingBlur = spinK * (0.6 + 0.4 * buzz); wingSpread = spinK * (0.6 + 0.3 * buzz) + flop * 0.9;
        const flail = spinK * 0.9 + flop * 0.35, tw = flop * (Math.max(0, Math.sin(st * 0.05)) > 0.7 ? 1 : 0);
        for (const side of ['left', 'right']) for (const seg of ['T1', 'T2', 'T3']) {
          const ph2 = st * 0.03 + (side === 'left' ? 1.3 : 0) + (seg === 'T2' ? 2 : seg === 'T3' ? 4 : 0);
          this.leg(seg, side, { lift: (Math.sin(ph2) * 0.5 + 0.7) * flail + tw * 0.4, swing: Math.cos(ph2 * 1.3) * 0.35 * flail });
        }
        this.addJ('head', Math.sin(st * 0.04) * 0.3 * spinK - 0.2 * flop); this.addJ('head_twist', Math.sin(st * 0.03) * 0.25 * spinK);
        for (let j = 2; j <= 7; j++) this.addJ(`abdomen_${j}`, Math.sin(st * 0.05 + j) * 0.05 * spinK + 0.06 * flop);
        this.addJ('antenna_left', 0.3 * spinK); this.addJ('antenna_right', 0.3 * spinK);
        shadowA = 1 - spinK * 0.2;
      } else if (s === 'sulk') {
        // slumped low, head down, wings drooped, antennae flat, slow breathing with an occasional heavy sigh
        const x = ease01(st / 900);
        const slow = Math.sin(T * TAU * 0.18) * 0.5 + 0.5;
        const sighPh = (T % 7) / 7, sigh = sighPh < 0.35 ? Math.sin(sighPh / 0.35 * Math.PI) : 0;
        bodyY = -0.03 * x + slow * 0.003 + sigh * 0.01; pitch = 0.1 * x - sigh * 0.03;
        this.addJ('head', (-0.45 - sigh * 0.1) * x); this.addJ('head_twist', Math.sin(T * 0.3) * 0.04);
        for (const side of ['left', 'right']) { this.addJ(`wing_roll_${side}`, -0.3 * x); this.addJ(`wing_yaw_${side}`, 0.12 * x); this.addJ(`antenna_${side}`, 0.45 * x); }
        for (const side of ['left', 'right']) for (const seg of ['T1', 'T2', 'T3']) {
          const c = this.legCal[`${seg}_${side}`];
          this.addJ(`femur_${seg}_${side}`, -0.22 * x * c.femurUp); this.addJ(`tibia_${seg}_${side}`, -0.2 * x * c.tibiaUp);
        }
        for (let j = 2; j <= 7; j++) this.addJ(`abdomen_${j}`, (0.03 + sigh * 0.09 - slow * 0.02) * x);
      } else if (s === 'sleepDesk') {
        const x = ease01(st / 1100);
        const slow = Math.sin(T * TAU * 0.22) * 0.5 + 0.5;
        bodyY = -0.05 * x + slow * 0.003; pitch = 0.24 * x; wingFlat = x;
        this.addJ('head', -0.55 * x); this.addJ('head_abduct', 0.12 * x);
        for (const side of ['left', 'right']) for (const seg of ['T1', 'T2', 'T3']) {
          const c = this.legCal[`${seg}_${side}`];
          this.addJ(`femur_${seg}_${side}`, -0.32 * x * c.femurUp);
          this.addJ(`tibia_${seg}_${side}`, -0.28 * x * c.tibiaUp);
          this.addJ(`tarsus_${seg}_${side}`, 0.15 * x);
        }
        for (const side of ['left', 'right']) this.leg('T1', side, { swing: 0.35 * x });   // front legs stretched forward on the desk
        this.addJ('antenna_left', 0.4 * x); this.addJ('antenna_right', 0.4 * x);
        for (let j = 2; j <= 7; j++) this.addJ(`abdomen_${j}`, 0.04 * x);
      }
    } else if (s === 'idle') {
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
    if (wingBlur > 0 || wingSpread > 0) {
      const flap = Math.sin(T * TAU * 27);       // aliased fast flap; ghosts give the fan look
      for (const side of ['left', 'right']) {
        this.addJ(`wing_yaw_${side}`, -1.25 * wingSpread + flap * 0.32 * wingBlur);
        this.addJ(`wing_roll_${side}`, -0.4 * wingSpread + flap * 0.2 * wingBlur);
        this.addJ(`wing_pitch_${side}`, 0.35 * wingSpread);
      }
    } else if (wingFlat > 0) {
      for (const side of ['left', 'right']) { this.addJ(`wing_roll_${side}`, -0.25 * wingFlat); this.addJ(`wing_pitch_${side}`, 0.15 * wingFlat); }
    } else if (!still) {
      // resting wings: tiny settle
      const w = Math.sin(T * 0.9) * 0.01;
      this.addJ('wing_roll_left', w); this.addJ('wing_roll_right', -w);
    }
    this.wingBlur = wingBlur; this.wingSpread = wingSpread;

    // body placement
    const inScene = SCENE_STATES.has(s) && this.sceneName;
    const targetYaw = this.yawOverride !== undefined ? this.yawOverride : inScene ? this.sceneYaw : (this.dir > 0 ? this.yawR : this.yawL);
    if (this.yaw === undefined || still) this.yaw = targetYaw;
    let dy = targetYaw - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, dt / 220);
    const lap = s === 'zoomies' && this.lap ? this.lap : null;
    this.mover.rotation.y = lap ? this.sceneYaw + (lap.yaw - 0) * lap.w + yaw : this.yaw + yaw;
    if (lap) this.yaw = this.sceneYaw;
    if (this.sceneName) this.stage.rotation.y = this.sceneYaw;
    // props: buttons depress + glow, pencil follows the holding claw
    for (const b of ['again', 'hard', 'good', 'easy']) {
      const B = this.props[b]; if (!B) continue;
      const a = pressBtn === b ? pressAmt : 0;
      B.cap.position.y = B.restY - 0.028 * a;
      B.capMat.emissiveIntensity = 0.05 + 0.9 * a;
    }
    if (this.props.pencil) {
      const pc = this.props.pencil;
      if (pencilHold) {
        pc.visible = true;
        const tipS = this.pencilTip.clone();
        if (scribble) { tipS.x += scribble.x; tipS.z += scribble.z; tipS.y += (1 - scribble.down) * 0.06; }
        pc.position.copy(tipS);
        this.mover.updateWorldMatrix(true, true);
        const cw = this.byName.claw_T1_right.getWorldPosition(new THREE.Vector3());
        this.stage.updateWorldMatrix(true, false);
        pc.lookAt(cw);   // aims the pencil's +z (its shaft) from the tip on the paper toward the holding claw
      } else {
        // pencil lying on the paper
        pc.visible = true; pc.position.set(this.pencilTip.x + 0.25, 0.03, this.pencilTip.z + 0.28); pc.rotation.set(0, 1.2, 0);
      }
    }
    this.mover.position.x = (this.x - 0.5) * this.visW;
    this.mover.position.z = 0;
    if (lap) { const c = Math.cos(this.sceneYaw), sn = Math.sin(this.sceneYaw); this.mover.position.x += lap.x * c + lap.z * sn; this.mover.position.z += -lap.x * sn + lap.z * c; }
    this.lift.position.y = bodyY;
    this.lift.rotation.z = pitch;   // MuJoCo x forward -> pitch about z after root rotation? root maps y->z; pitch about world z is a nose-up/down of a fly facing +x
    this.lift.rotation.x = roll;
    const deskK = this.sceneName ? 0.7 : 1;
    this.shadow.material.opacity = shadowA * (this.sceneName ? 0.6 : 1);
    this.shadow.scale.set(1.15 * shadowS * deskK, 0.85 * shadowS * deskK, 1);

    // ghosts
    const showGhost = wingBlur > 0.2;
    for (const g of this.ghosts) {
      g.o.visible = showGhost;
      if (!showGhost) continue;
      const q = new THREE.Quaternion(), wb = g.wb;
      const js = wb.userData.joints;   // yaw, roll, pitch
      const ph = (g.k - 1) * 0.5;
      wb.quaternion.copy(wb.userData.q0);
      const sgn = 1;
      const vals = [js[0].ref + js[0].v + ph * 0.55 * sgn, js[1].ref + js[1].v + ph * 0.35, js[2].ref + js[2].v];
      const qq = wb.userData.q0.clone();
      for (let i = 0; i < 3; i++) { q.setFromAxisAngle(js[i].axis, vals[i]); qq.multiply(q); }
      g.o.quaternion.copy(qq);
      g.o.children[0].material.opacity = 0.07 * wingBlur;
    }

    // overlays, anchored to the head
    const asleep = s === 'sleep' || s === 'sleepDesk';
    const spark = s === 'proboscis' && st < 1400;
    if (asleep || spark) { this.mover.updateWorldMatrix(true, true); this.byName.head.getWorldPosition(this.headW || (this.headW = new THREE.Vector3())); }
    const hw = this.headW || new THREE.Vector3();
    this.zzz.forEach((z, i) => {
      z.visible = asleep && st > 600;
      if (!z.visible) return;
      const ph = ((T / 1.6) + i / 3) % 1;
      z.position.set(hw.x + 0.05 + ph * 0.12 * this.dir + Math.sin(ph * TAU) * 0.03, hw.y + 0.12 + ph * 0.4, hw.z + 0.15);
      const sc = 0.12 + ph * 0.1; z.scale.set(sc, sc, 1);
      z.material.opacity = Math.sin(ph * Math.PI);
    });
    this.sparks.forEach((sp, i) => {
      sp.visible = spark;
      if (!spark) return;
      const a = i * TAU / 6 + T * 1.4, r = 0.18 + (st / 1400) * 0.2;
      sp.position.set(hw.x + Math.cos(a) * r, hw.y + 0.05 + Math.sin(a) * r * 0.6, hw.z + 0.2);
      sp.material.opacity = 0.9 * (1 - st / 1400);
    });
  }
}
