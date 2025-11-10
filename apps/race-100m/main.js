import * as THREE from 'three';
import { GVRM } from 'gvrm';

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.01, 500);
camera.position.set(0, 10, -18);
camera.lookAt(0, 1.2, 20);

// Lights
const hemi = new THREE.HemisphereLight(0xffffff, 0x223355, 0.6);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(20, 30, -20);
scene.add(dir);

// Track parameters
const lanes = [ -4.5, -1.5, 1.5, 4.5 ]; // x positions (4 lanes)
const laneColors = [ '#ef4444', '#22c55e', '#3b82f6', '#eab308' ];
const startZ = 0;
const finishZ = 100; // 100 meters

// Ground and lines
addGroundAndLines();

// UI
const $countdown = document.getElementById('countdown');
const $timer = document.getElementById('raceTimer');
const $scores = document.getElementById('scores');
const $start = document.getElementById('btnStart');
const $reset = document.getElementById('btnReset');
const $settings = document.getElementById('btnSettings');
const $settingsPanel = document.getElementById('settingsPanel');
const $saveNames = document.getElementById('btnSaveNames');
const $finishFlash = document.getElementById('finishFlash');
const $nameInputs = [1,2,3,4].map(i => /** @type {HTMLInputElement} */(document.getElementById('name'+i)));

// Runners
/** @typedef {{ id:string, gvrm:any, object:THREE.Object3D, rot0:THREE.Euler, speed:number, finished:boolean, tFinish:number|null, lane:number, color:string }} Runner */
/** @type {Runner[]} */
let runners = [];
let raceStarted = false;
let tStart = 0;
let audio; // lazy-initialized WebAudio engine
const NAMES_KEY = 'race100m:names';
const PB_KEY = 'race100m:pb';
let names = loadNames();
let pbs = loadPBs();

// Load runners
await loadRunners();
updateScores();

// Start/Reset UI
$start.addEventListener('click', () => startRace());
$reset.addEventListener('click', () => resetRace());
$settings.addEventListener('click', () => {
  $settingsPanel.style.display = $settingsPanel.style.display === 'none' || !$settingsPanel.style.display ? 'block' : 'none';
  // populate
  $nameInputs.forEach((inp, i) => inp.value = names[i] || `Lane ${i+1}`);
});
$saveNames.addEventListener('click', () => {
  names = $nameInputs.map(inp => inp.value.trim() || inp.placeholder || '');
  saveNames();
  $settingsPanel.style.display = 'none';
  updateScores();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') startRace();
});

// Render loop
let lastT = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  runners.forEach(r => r.gvrm.update());

  // Compute camera target to keep all lanes in view
  const avgZ = runners.length ? runners.reduce((s, r) => s + r.object.position.z, 0) / runners.length : 0;
  fitCameraToTrack(avgZ);

  if (raceStarted) {
    const elapsed = (now - tStart) / 1000;
    $timer.textContent = `Time: ${elapsed.toFixed(2)}s`;

    for (const r of runners) {
      if (r.finished) continue;
      // advance
      r.object.position.z += r.speed * dt;
      if (r.object.position.z >= finishZ) {
        r.object.position.z = finishZ;
        r.finished = true;
        r.tFinish = elapsed;
        // slow down animation on finish
        if (r.gvrm?.character?.action) r.gvrm.character.action.timeScale = 0.6;
        flashFinish();
        updateScores();
      }
    }

    // stop timer when all finished
    if (runners.every(r => r.finished)) {
      raceStarted = false;
      finalizePBs();
    }
  }

  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

async function loadRunners() {
  // Clear scene runners if any
  for (const r of runners) scene.remove(r.object);
  runners = [];

  const sources = [
    '../../assets/sample6.gvrm',
    '../../assets/sample7.gvrm',
    '../../assets/sample8.gvrm',
    '../../assets/sample9.gvrm',
  ];

  const promises = sources.map((src, i) => (async () => {
    const gvrm = await GVRM.load(src, scene, camera, renderer);
    const object = gvrm.character.currentVrm.scene;
    const rot0 = object.rotation0.clone();

    // Place at lane and start line
    object.position.set(lanes[i], 0, startZ);
    // Face forward along +Z (keep original base rotation)
    object.rotation.y = rot0.y;

    // Load and speed-up walking animation to mimic running
    await gvrm.changeFBX('../../assets/Walking.fbx');
    if (gvrm?.character?.action) {
      gvrm.character.action.play();
      gvrm.character.action.timeScale = 2.2; // faster legs
    }

    // Runner speed [m/s]
    const speed = 6.5 + Math.random() * 2.2; // ~6.5–8.7 m/s

    return /** @type {Runner} */({
      id: `lane${i+1}`,
      gvrm, object, rot0,
      speed, finished: false, tFinish: null,
      lane: i + 1, color: laneColors[i]
    });
  })());

  runners = await Promise.all(promises);
}

// Keep all lanes in horizontal FOV regardless of aspect ratio
const trackMinX = Math.min(...lanes) - 1.8;
const trackMaxX = Math.max(...lanes) + 1.8;
const trackWidth = trackMaxX - trackMinX; // meters
function fitCameraToTrack(avgZ) {
  const canvas = renderer.domElement;
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const halfWidth = (trackWidth / 2) * 1.1; // small margin
  let d = halfWidth / (Math.tan(vFov / 2) * aspect);
  d = THREE.MathUtils.clamp(d, 7, 16); // even closer to runners

  // Focus on the slowest (rearmost) runner and keep only a small look-ahead
  let focusZ = avgZ;
  if (runners.length) {
    const tailZ = Math.min(...runners.map(r => r.object.position.z));
    focusZ = tailZ;
  }
  const targetZ = focusZ + 2; // minimal look-ahead
  const targetY = Math.max(5, d * 0.28);
  const pos = new THREE.Vector3(0, targetY, targetZ - d * 0.8);
  camera.position.lerp(pos, 0.12); // a bit snappier to keep them in view
  camera.lookAt(0, 1.6, targetZ);
}

function startRace() {
  if (raceStarted) return;
  ensureAudio();
  countdown([ '3', '2', '1', 'GO!' ], 700, (label) => playCountBeep(label)).then(() => {
    playGunshot();
    tStart = performance.now();
    raceStarted = true;
  });
}

function resetRace() {
  raceStarted = false;
  $timer.textContent = 'Time: 0.00s';
  runners.forEach((r, i) => {
    r.object.position.set(lanes[i], 0, startZ);
    r.finished = false;
    r.tFinish = null;
    if (r.gvrm?.character?.action) r.gvrm.character.action.timeScale = 2.2;
  });
  updateScores();
}

function updateScores() {
  // Sort by finished time ascending; unfinished at end.
  const sorted = [...runners].sort((a, b) => {
    if (a.tFinish == null && b.tFinish == null) return 0;
    if (a.tFinish == null) return 1;
    if (b.tFinish == null) return -1;
    return a.tFinish - b.tFinish;
  });
  $scores.innerHTML = '';
  sorted.forEach((r, idx) => {
    const div = document.createElement('div');
    div.className = 'chip';
    const name = names[r.lane - 1] || `Lane ${r.lane}`;
    const medal = r.tFinish != null && idx < 3 ? ['🥇','🥈','🥉'][idx] : '';
    const pb = pbs[name];
    const tStr = r.tFinish == null ? '—' : `${r.tFinish.toFixed(2)}s`;
    const pbStr = pb != null ? ` (PB ${pb.toFixed(2)}s)` : '';
    div.innerHTML = `<span class="lane" style="background:${r.color}"></span>${name}: ${tStr} ${medal}${pbStr}`;
    $scores.appendChild(div);
  });
}

function countdown(labels, ms, onTick) {
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      if (i >= labels.length) { $countdown.classList.remove('visible'); resolve(); return; }
      const label = labels[i++];
      $countdown.textContent = label;
      $countdown.classList.add('visible');
      try { onTick && onTick(label); } catch {}
      setTimeout(() => { $countdown.classList.remove('visible'); setTimeout(step, 120); }, ms);
    };
    step();
  });
}

function addGroundAndLines() {
  // Track ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 120, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x0b1220, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, 60);
  scene.add(ground);

  // Lane separator lines
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
  const z0 = -5, z1 = 110;
  lanes.forEach((x) => {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x - 1.5, 0.01, z0),
      new THREE.Vector3(x - 1.5, 0.01, z1)
    ]);
    const geo2 = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x + 1.5, 0.01, z0),
      new THREE.Vector3(x + 1.5, 0.01, z1)
    ]);
    scene.add(new THREE.Line(geo, lineMat));
    scene.add(new THREE.Line(geo2, lineMat));
  });

  // Start and finish lines
  const mStart = new THREE.LineBasicMaterial({ color: 0x22c55e });
  const mFinish = new THREE.LineBasicMaterial({ color: 0xef4444 });
  const startGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-7.2, 0.02, startZ), new THREE.Vector3(7.2, 0.02, startZ)
  ]);
  const finishGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-7.2, 0.02, finishZ), new THREE.Vector3(7.2, 0.02, finishZ)
  ]);
  scene.add(new THREE.Line(startGeo, mStart));
  scene.add(new THREE.Line(finishGeo, mFinish));

  // Lane dots at start with colors
  lanes.forEach((x, i) => {
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.18, 24),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(laneColors[i]) })
    );
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(x, 0.03, startZ - 0.6);
    scene.add(dot);
  });
}

// ---- Names & PBs ----
function loadNames() {
  try { const raw = localStorage.getItem(NAMES_KEY); if (!raw) return ['Lane 1','Lane 2','Lane 3','Lane 4']; const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length>=4) return arr.slice(0,4); } catch {}
  return ['Lane 1','Lane 2','Lane 3','Lane 4'];
}
function saveNames() {
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch {}
}
function loadPBs() {
  try { const raw = localStorage.getItem(PB_KEY); if (!raw) return {}; const obj = JSON.parse(raw); if (obj && typeof obj === 'object') return obj; } catch {}
  return {};
}
function savePBs() {
  try { localStorage.setItem(PB_KEY, JSON.stringify(pbs)); } catch {}
}
function finalizePBs() {
  for (const r of runners) {
    if (r.tFinish == null) continue;
    const name = names[r.lane - 1] || `Lane ${r.lane}`;
    const prev = pbs[name];
    if (prev == null || r.tFinish < prev) {
      pbs[name] = r.tFinish;
    }
  }
  savePBs();
  updateScores();
}

// ---- Finish flash overlay ----
let finishFlashTimer;
function flashFinish() {
  clearTimeout(finishFlashTimer);
  $finishFlash.classList.add('show');
  finishFlashTimer = setTimeout(() => $finishFlash.classList.remove('show'), 180);
}

// ---- WebAudio: countdown beep + start gun ----
function ensureAudio() {
  if (audio) return audio;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain();
  master.gain.value = 0.5; master.connect(ctx.destination);
  audio = { ctx, master };
  return audio;
}
function playCountBeep(label) {
  if (!audio) return; const { ctx, master } = audio;
  // 3/2/1 short sine, GO! higher blip
  const isGo = /go/i.test(label);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const t0 = ctx.currentTime;
  osc.type = 'sine';
  osc.frequency.value = isGo ? 880 : 660;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.5, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
  osc.connect(gain).connect(master);
  osc.start();
  osc.stop(t0 + 0.22);
}
function playGunshot() {
  if (!audio) return; const { ctx, master } = audio;
  // Noise burst + quick decay -> pseudo starter pistol
  const bufferSize = 0.15 * ctx.sampleRate;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.22));
  const noise = ctx.createBufferSource(); noise.buffer = buffer;
  const bandpass = ctx.createBiquadFilter(); bandpass.type = 'bandpass'; bandpass.frequency.value = 1800; bandpass.Q.value = 0.7;
  const gain = ctx.createGain(); gain.gain.value = 1.0;
  noise.connect(bandpass).connect(gain).connect(master);
  const t0 = ctx.currentTime; noise.start(t0); noise.stop(t0 + 0.18);
}
