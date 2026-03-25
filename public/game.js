const socket = io();

let GRID = 21;
let TILE = 32;
let SIZE = GRID * TILE;

let myId        = null;
let state       = null;
let prevState   = null;
let isSpectating = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens      = { lobby: $('lobby'), game: $('game'), end: $('end') };
const nameInput    = $('name-input');
const joinBtn      = $('join-btn');
const errMsg       = $('err-msg');
const joinForm     = $('join-form');
const playerListEl = $('player-list');
const playerCount  = $('player-count');
const startBtn     = $('start-btn');
const waitMsg      = $('wait-msg');
const settingsPanel = $('settings-panel');
const timerEl      = $('timer');
const scoresEl     = $('scores');
const finalEl      = $('final');
const restartBtn   = $('restart-btn');
const endWaitEl    = $('end-wait');
const feedList     = $('feed-list');
const lbList       = $('lb-list');

const canvas = $('canvas');
const ctx    = canvas.getContext('2d');
canvas.width  = SIZE;
canvas.height = SIZE;

const snorlaxImg = new Image();
snorlaxImg.src   = '/snorlax.jpeg';

// ── Character picker ─────────────────────────────────────────────────────────
let selectedCharacter = 'pete';

// Preload character images
const characterImgs = {};
for (const name of ['pete', 'francis', 'alicia', 'nigel', 'scotland', 'chardi']) {
  const img = new Image();
  img.src = `/characters/${name}.png`;
  characterImgs[name] = img;
}

document.querySelectorAll('.char-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.char-opt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedCharacter = btn.dataset.character;
  });
});

// ── Screen helper ─────────────────────────────────────────────────────────────
function show(name) {
  for (const [k, el] of Object.entries(screens))
    el.style.display = k === name ? '' : 'none';
}

// ── Socket ────────────────────────────────────────────────────────────────────
joinBtn.onclick = () => {
  const name = nameInput.value.trim();
  if (!name) return;
  errMsg.textContent = '';
  socket.emit('join', { name, character: selectedCharacter });
};
nameInput.onkeydown = e => { if (e.key === 'Enter') joinBtn.onclick(); };

startBtn.onclick = () => {
  const timer        = parseInt($('setting-timer').value)  || 300;
  const startingItems = Math.min(Math.max(parseInt($('setting-items').value) || 10, 1), 30);
  socket.emit('start_game', { timer, startingItems });
};

restartBtn.onclick = () => socket.emit('restart');

socket.on('joined', ({ playerId }) => { myId = playerId; });

socket.on('promoted_to_host', () => { if (state) renderLobby(); });

socket.on('err', msg => { errMsg.textContent = msg; });

socket.on('spectating', () => { isSpectating = true; });

socket.on('state_update', s => {
  prevState = state;
  state     = s;

  // Resize canvas if tier changed
  if (s.gridSize && s.tileSize) {
    GRID = s.gridSize;
    TILE = s.tileSize;
    SIZE = GRID * TILE;
    if (canvas.width !== SIZE) {
      canvas.width  = SIZE;
      canvas.height = SIZE;
    }
  }

  playSounds(prevState, s);
  triggerParticles(prevState, s);

  if (s.phase === 'lobby') {
    isSpectating = false;  // Can join next round
    stopMusic();
    show('lobby'); renderLobby();
  }
  else if (s.phase === 'countdown') { playMusic(); show('game');  renderHUD(); renderLeaderboard(); $('hud').style.maxWidth = (SIZE + 420) + 'px'; $('feed').style.height = SIZE + 'px'; $('leaderboard').style.height = SIZE + 'px'; }
  else if (s.phase === 'playing')   { playMusic(); show('game');  renderHUD(); renderLeaderboard(); $('hud').style.maxWidth = (SIZE + 420) + 'px'; $('feed').style.height = SIZE + 'px'; $('leaderboard').style.height = SIZE + 'px'; }
  else if (s.phase === 'ended')     { stopMusic(); show('end');   renderEnd(); }
});

// ── Input — tap-to-move, client-side rate limit mirrors server ────────────────
const BASE_COOLDOWN = 150;
let lastSent   = 0;

const KEYS = {
  ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
  w:'up', s:'down', a:'left', d:'right',
  W:'up', S:'down', A:'left', D:'right',
};

document.addEventListener('keydown', e => {
  const dir = KEYS[e.key];
  if (!dir || state?.phase !== 'playing') return;
  if (!myId || !state.players[myId]) return; // Spectators can't move
  e.preventDefault();
  const now = Date.now();
  // Mirror server: Pete has 125ms base cooldown; halve when speed-boosted
  const me      = state.players[myId];
  const baseCd  = me?.character === 'pete' ? 125 : BASE_COOLDOWN;
  const boosted = me?.speedBoostExpiry > now;
  const limit   = boosted ? Math.floor(baseCd / 2) : baseCd;
  if (now - lastSent < limit) return;
  lastSent = now;
  socket.emit('move', dir);
});

// ── RAF game loop — handles smooth carry bob + power-up pulse ─────────────────
;(function loop() {
  if (state?.phase === 'playing' || state?.phase === 'countdown') renderGame();
  requestAnimationFrame(loop);
})();

// ── Lobby render ──────────────────────────────────────────────────────────────
function renderLobby() {
  const players = state ? Object.values(state.players) : [];
  const joined  = myId && state?.players[myId];

  joinForm.style.display = joined ? 'none' : 'flex';

  playerCount.textContent = `(${players.length})`;
  playerListEl.innerHTML  = players.map(p =>
    `<li style="color:${p.color}">
       <img class="p-avatar" src="/characters/${p.character}.png" alt="${p.character}" />
       ${escHtml(p.name)}${p.id === state.hostId ? ' <span class="crown">♛</span>' : ''}
     </li>`
  ).join('');

  if (joined) {
    const iAmHost         = myId === state.hostId;
    startBtn.style.display     = iAmHost ? '' : 'none';
    waitMsg.style.display      = iAmHost ? 'none' : '';
    settingsPanel.style.display = iAmHost ? '' : 'none';
  } else {
    startBtn.style.display      = 'none';
    waitMsg.style.display       = 'none';
    settingsPanel.style.display = 'none';
  }
}

// ── Leaderboard render ───────────────────────────────────────────────────────
function renderLeaderboard() {
  if (!state) return;
  const sorted = Object.values(state.players).sort((a, b) => b.baseItems - a.baseItems);

  lbList.innerHTML = sorted.map((p, i) =>
    `<li${p.id === myId ? ' class="lb-me"' : ''} style="color:${p.color}">
       <span class="lb-rank">${i + 1}</span>
       <img class="lb-avatar" src="/characters/${p.character}.png" alt="${p.character}" />
       <span class="lb-name">${escHtml(p.name)}</span>
       <span class="lb-score">${p.baseItems}</span>
       ${p.carrying ? '<span class="lb-carry">📦</span>' : ''}
     </li>`
  ).join('');
}

// ── HUD render ────────────────────────────────────────────────────────────────
function renderHUD() {
  const m = Math.floor(state.timer / 60);
  const s = state.timer % 60;
  timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
  timerEl.style.color = state.timer <= 30 ? '#e74c3c' : '#f39c12';

  const now    = Date.now();
  const sorted = Object.values(state.players).sort((a, b) => b.baseItems - a.baseItems);

  const TOP_N  = 5;
  const myRank = sorted.findIndex(p => p.id === myId);
  const shown  = sorted.slice(0, TOP_N);
  const showMe = myRank >= TOP_N && myRank !== -1;

  function scoreHtml(p, rank) {
    const boostLeft  = p.speedBoostExpiry > now ? Math.ceil((p.speedBoostExpiry - now) / 1000) : 0;
    const shieldLeft = p.shieldExpiry     > now ? Math.ceil((p.shieldExpiry     - now) / 1000) : 0;
    const camping = p.campTicks > 5;
    return `<span class="score${p.id === myId ? ' me' : ''}" style="--c:${p.color}">
      #${rank + 1} <img class="score-avatar" src="/characters/${p.character}.png" alt="${p.character}" /> ${escHtml(p.name)} ${p.baseItems}${p.carrying ? ' 📦' : ''}${boostLeft ? ` <span class="boost-badge">⚡${boostLeft}s</span>` : ''}${shieldLeft ? ` <span class="shield-badge">🛡️${shieldLeft}s</span>` : ''}${camping ? ` <span class="camp-badge">⛺-1</span>` : ''}
    </span>`;
  }

  let html = shown.map((p, i) => scoreHtml(p, i)).join('');
  if (showMe) {
    html += `<span class="score-sep">···</span>`;
    html += scoreHtml(sorted[myRank], myRank);
  }
  if (sorted.length > TOP_N) {
    html += `<span class="score-total">(${sorted.length} players)</span>`;
  }
  if (!myId || !state.players[myId]) {
    html += `<span class="spectator-badge">Spectating</span>`;
  }
  if (state.spectators > 0) {
    html += `<span class="spectator-count">${state.spectators} watching</span>`;
  }
  scoresEl.innerHTML = html;
}

// ── End screen ────────────────────────────────────────────────────────────────
function renderEnd() {
  const sorted   = Object.values(state.players).sort((a, b) => b.baseItems - a.baseItems);
  const topScore = sorted[0]?.baseItems ?? 0;
  const tied     = sorted.filter(p => p.baseItems === topScore);

  const heading = tied.length > 1
    ? `<h2 class="tie">It's a tie!</h2>`
    : `<h2 style="color:${sorted[0].color}"><img class="winner-avatar" src="/characters/${sorted[0].character}.png" /> ${escHtml(sorted[0].name)} wins!</h2>`;

  const END_TOP = 10;
  const myRank  = sorted.findIndex(p => p.id === myId);
  const top     = sorted.slice(0, END_TOP);
  const showMe  = myRank >= END_TOP && myRank !== -1;

  function liHtml(p, rank) {
    return `<li style="color:${p.color}">
       <span class="p-rank">#${rank + 1}</span>
       <img class="p-avatar" src="/characters/${p.character}.png" alt="${p.character}" />
       ${escHtml(p.name)} — <strong>${p.baseItems}</strong> items
     </li>`;
  }

  let listHtml = top.map((p, i) => liHtml(p, i)).join('');
  if (showMe) {
    listHtml += `<li class="end-sep">···</li>`;
    listHtml += liHtml(sorted[myRank], myRank);
  }
  if (sorted.length > END_TOP) {
    listHtml += `<li class="end-total">${sorted.length} players total</li>`;
  }

  finalEl.innerHTML = heading + '<ol>' + listHtml + '</ol>';

  const iAmHost   = myId === state.hostId;
  const isViewing = !myId || !state.players[myId];
  restartBtn.style.display = iAmHost ? '' : 'none';
  endWaitEl.textContent    = isViewing ? 'Waiting for next round…' : 'Waiting for host to restart…';
  endWaitEl.style.display  = iAmHost ? 'none' : '';
}

// ── Canvas render ─────────────────────────────────────────────────────────────
function renderGame() {
  if (!state) return;
  const now     = Date.now();
  const players = Object.values(state.players);

  ctx.clearRect(0, 0, SIZE, SIZE);

  // Background
  ctx.fillStyle = '#12121f';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= GRID; i++) {
    ctx.beginPath(); ctx.moveTo(i * TILE, 0);    ctx.lineTo(i * TILE, SIZE);  ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * TILE);    ctx.lineTo(SIZE, i * TILE);  ctx.stroke();
  }

  // ── Bases ──
  const itemFont = `bold ${Math.max(Math.round(TILE * 0.55), 8)}px monospace`;
  const nameFont = `${Math.max(Math.round(TILE * 0.4), 7)}px sans-serif`;

  for (const p of players) {
    const bx = p.baseX * TILE;
    const by = p.baseY * TILE;
    const isMyBase = p.id === myId;
    const camping  = p.campTicks > 5;

    // Own base: pulsing gold beacon so you can always find it
    if (isMyBase) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 300);
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur  = 18 + pulse * 24;
      ctx.fillStyle   = `rgba(255,215,0,${0.12 + pulse * 0.15})`;
      ctx.fillRect(bx - 2, by - 2, TILE + 4, TILE + 4);
      ctx.shadowBlur  = 0;
    }

    // Camping: pulsing red warning glow
    if (camping) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 200);
      ctx.shadowColor = '#e74c3c';
      ctx.shadowBlur  = 12 + pulse * 20;
      ctx.fillStyle   = `rgba(231,76,60,${0.15 + pulse * 0.2})`;
      ctx.fillRect(bx, by, TILE, TILE);
      ctx.shadowBlur  = 0;
    }

    // Glow fill
    ctx.shadowColor = isMyBase ? '#ffd700' : p.color;
    ctx.shadowBlur  = isMyBase ? 20 : 16;
    ctx.fillStyle   = (isMyBase ? '#ffd700' : p.color) + '30';
    ctx.fillRect(bx, by, TILE, TILE);
    ctx.shadowBlur  = 0;

    // Border
    ctx.strokeStyle = isMyBase ? '#ffd700' : p.color;
    ctx.lineWidth   = isMyBase ? 3 : 2;
    ctx.strokeRect(bx + 1, by + 1, TILE - 2, TILE - 2);

    // Item count
    ctx.fillStyle    = '#fff';
    ctx.font         = itemFont;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.baseItems, bx + TILE / 2, by + TILE / 2);

    // Base name label — flip side for edge bases so it stays on-canvas
    ctx.fillStyle    = isMyBase ? '#ffd700' : p.color;
    ctx.font         = nameFont;
    ctx.textBaseline = p.baseY === 0 ? 'top' : 'bottom';
    const labelY     = p.baseY === 0 ? by + TILE + 2 : by - 2;
    ctx.fillText(p.name, bx + TILE / 2, labelY);
  }

  // ── Obstacles ──
  ctx.font         = `${Math.round(TILE * 0.72)}px serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  for (const o of state.obstacles || []) {
    ctx.fillText(o.emoji, o.x * TILE + TILE / 2, o.y * TILE + TILE / 2 + 1);
  }

  // ── Snorlax ──
  if (state.snorlax && snorlaxImg.complete) {
    ctx.drawImage(snorlaxImg, state.snorlax.x * TILE, state.snorlax.y * TILE, TILE * 2, TILE * 2);
  }

  // ── Power-ups on map ──
  ctx.font         = `${Math.max(Math.round(TILE * 0.9), 12)}px serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  if (state.powerUp) {
    const px    = state.powerUp.x * TILE + TILE / 2;
    const py    = state.powerUp.y * TILE + TILE / 2;
    const pulse = 0.5 + 0.5 * Math.sin(now / 280);
    ctx.shadowColor = '#ffe000';
    ctx.shadowBlur  = 8 + pulse * 14;
    ctx.fillText('⚡', px, py + 1);
    ctx.shadowBlur  = 0;
  }

  if (state.shieldUp) {
    const px    = state.shieldUp.x * TILE + TILE / 2;
    const py    = state.shieldUp.y * TILE + TILE / 2;
    const pulse = 0.5 + 0.5 * Math.sin(now / 280 + Math.PI); // offset from ⚡ pulse
    ctx.shadowColor = '#a78bfa';
    ctx.shadowBlur  = 8 + pulse * 14;
    ctx.fillText('🛡️', px, py + 1);
    ctx.shadowBlur  = 0;
  }

  // ── Dropped items (from camping penalty) ──
  for (const d of state.droppedItems || []) {
    const px    = d.x * TILE + TILE / 2;
    const py    = d.y * TILE + TILE / 2;
    const pulse = 0.5 + 0.5 * Math.sin(now / 350 + d.x + d.y);
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur  = 6 + pulse * 10;
    ctx.fillText('📦', px, py + 1);
    ctx.shadowBlur  = 0;
  }

  // ── Players ──
  for (const p of players) {
    const isMe    = p.id === myId;
    const boosted  = p.speedBoostExpiry > now;
    const shielded = p.shieldExpiry > now;

    // Alicia phantom: invisible to others when not carrying
    if (p.phantom && !isMe) continue;

    // Carry bob: gentle sine offset on y
    const bob = p.carrying ? Math.sin(now / 180) * 3 : 0;
    const cx  = p.x * TILE + TILE / 2;
    const cy  = p.y * TILE + TILE / 2 + bob;
    const r   = TILE * 0.36;

    // Glow — priority: shield (purple) > speed boost (cyan) > default
    ctx.shadowColor = shielded ? '#a78bfa' : boosted ? '#00e5ff' : p.color;
    ctx.shadowBlur  = (shielded || boosted) ? 22 : (isMe ? 18 : 8);

    // Circle outline only (no fill)
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = shielded ? '#a78bfa' : boosted ? '#00e5ff' : isMe ? '#ffffff' : p.color;
    ctx.lineWidth   = shielded ? 3 : 2;
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Character sprite
    const charImg = characterImgs[p.character];
    if (charImg && charImg.complete) {
      const s = TILE * 0.75;
      ctx.drawImage(charImg, cx - s / 2, cy - s / 2, s, s);
    }

    // Carrying indicator — dot(s) top-right; Francis can carry 2
    if (p.carrying) {
      const dotR = Math.max(TILE * 0.14, 2.5);
      ctx.fillStyle   = '#fff';
      ctx.shadowColor = '#fff';
      ctx.shadowBlur  = 6;
      ctx.beginPath();
      ctx.arc(cx + r * 0.62, cy - r * 0.62, dotR, 0, Math.PI * 2);
      ctx.fill();
      if (p.carrying >= 2) {
        ctx.beginPath();
        ctx.arc(cx + r * 0.62 - dotR * 2.5, cy - r * 0.62, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur  = 0;
    }

    // Name label
    ctx.fillStyle    = 'rgba(255,255,255,0.85)';
    ctx.font         = nameFont;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(p.name, cx, cy - r - 3 + bob);
  }

  // ── Particles ──
  updateAndRenderParticles();

  // ── Countdown overlay ──
  if (state.phase === 'countdown' && state.countdownTimer > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, SIZE, SIZE);

    const num   = state.countdownTimer;
    const pulse = 1 + 0.15 * Math.sin(now / 120);
    const fontSize = Math.round(SIZE * 0.25 * pulse);

    ctx.font         = `bold ${fontSize}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = '#ffd700';
    ctx.shadowBlur   = 30;
    ctx.fillStyle    = '#ffffff';
    ctx.fillText(num, SIZE / 2, SIZE / 2);
    ctx.shadowBlur   = 0;
  }
}

// ── Sound effects — Web Audio API ─────────────────────────────────────────────
let audioCtx = null;

function getAC() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function tone(freq, dur, type = 'sine', vol = 0.2, delay = 0) {
  try {
    const ac   = getAC();
    const osc  = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.type           = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ac.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + delay + dur);
    osc.start(ac.currentTime + delay);
    osc.stop(ac.currentTime + delay + dur);
  } catch (_) {}
}

function playSteal() {
  tone(880, 0.08, 'square', 0.15);
}

function playDeposit() {
  tone(600, 0.1,  'sine', 0.2);
  tone(900, 0.12, 'sine', 0.2, 0.09);
}

function playBoost() {
  try {
    const ac   = getAC();
    const osc  = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.frequency.setValueAtTime(300, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1400, ac.currentTime + 0.3);
    gain.gain.setValueAtTime(0.25, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.3);
    osc.start();
    osc.stop(ac.currentTime + 0.3);
  } catch (_) {}
}

function playTimerWarn() {
  // Two quick beeps to signal entering danger zone
  tone(880, 0.09, 'sine', 0.2);
  tone(880, 0.09, 'sine', 0.2, 0.15);
}

function playTick() {
  tone(500, 0.04, 'square', 0.07);
}

function playShield() {
  // Soft ascending chime
  tone(500, 0.1,  'sine', 0.2);
  tone(750, 0.12, 'sine', 0.2, 0.1);
  tone(1000, 0.15,'sine', 0.15, 0.2);
}

function playBounce() {
  // Descending thud — you got sent home
  tone(300, 0.12, 'square', 0.2);
  tone(150, 0.15, 'square', 0.15, 0.1);
}

function playCountdown() {
  tone(660, 0.15, 'sine', 0.25);
}

function playGo() {
  tone(880, 0.12, 'sine', 0.3);
  tone(1100, 0.15, 'sine', 0.3, 0.1);
}

function playGameEnd() {
  [900, 700, 500, 350].forEach((f, i) => tone(f, 0.22, 'sine', 0.3, i * 0.17));
}

function playSounds(prev, curr) {
  if (!prev) return;

  // Player-specific sounds (only for actual players)
  if (myId) {
    const me     = curr.players[myId];
    const prevMe = prev.players[myId];
    if (me && prevMe) {
      if (!prevMe.carrying && me.carrying)
        playSteal();
      if (prevMe.carrying && !me.carrying && curr.phase === 'playing')
        playDeposit();
      if (me.speedBoostExpiry > Date.now() && !(prevMe.speedBoostExpiry > Date.now()))
        playBoost();
      if (me.shieldExpiry > Date.now() && !(prevMe.shieldExpiry > Date.now()))
        playShield();
      const dist = Math.abs(me.x - prevMe.x) + Math.abs(me.y - prevMe.y);
      if (dist > 3 && curr.phase === 'playing')
        playBounce();
    }
  }

  // Game-wide sounds (everyone including spectators)

  // Enter last-30-seconds zone
  if (prev.timer > 30 && curr.timer <= 30 && curr.phase === 'playing')
    playTimerWarn();

  // Per-second tick in last 30s
  if (curr.phase === 'playing' && curr.timer <= 30 && curr.timer > 0 && curr.timer !== prev.timer)
    playTick();

  // Countdown beeps
  if (curr.phase === 'countdown' && prev.countdownTimer !== curr.countdownTimer && curr.countdownTimer > 0)
    playCountdown();
  if (prev.phase === 'countdown' && curr.phase === 'playing')
    playGo();

  // Game over fanfare
  if (prev.phase !== 'ended' && curr.phase === 'ended')
    playGameEnd();
}

// ── 8-bit backing track ──────────────────────────────────────────────────────
let musicPlaying  = false;
let musicMuted    = false;
let musicGain     = null;
let musicTimeout  = null;

// Fast aggressive 8-bit battle theme
const BPM       = 175;
const BEAT      = 60 / BPM;
const NOTE_FREQS = {
  // Octave 3
  A3:220.00, Bb3:233.08, B3:246.94, C3:130.81, D3:146.83, E3:164.81, F3:174.61, G3:196.00,
  // Octave 4
  A4:440.00, Bb4:466.16, B4:493.88, C4:261.63, D4:293.66, E4:329.63, F4:349.23, G4:392.00,
  // Octave 5
  A5:880.00, Bb5:932.33, B5:987.77, C5:523.25, D5:587.33, E5:659.25, F5:698.46, G5:783.99,
};

// Driving staccato melody — minor key, rapid runs, dramatic jumps
// 16 bars — A section (intense), B section (variation), C section (build), A' section (resolve)
const MELODY = [
  // A: bars 1-4 — aggressive opening riff
  ['E5',0.5],['E5',0.25],['E5',0.25],['D5',0.5],['C5',0.5],['D5',0.5],['E5',0.5],['G5',0.5],['E5',0.5],
  ['A5',0.5],['G5',0.25],['E5',0.25],['D5',0.5],['C5',0.5],['D5',0.75],['E5',0.25],['D5',0.5],['C5',0.5],
  // B: bars 5-8 — higher register, new rhythm pattern
  ['G5',0.25],['A5',0.25],['G5',0.5],['E5',0.5],['D5',0.25],['E5',0.25],['G5',0.5],['A5',0.5],['G5',0.5],
  ['E5',0.5],['D5',0.25],['C5',0.25],['D5',0.5],['E5',0.25],['E5',0.25],['G5',0.5],['E5',0.5],['D5',0.5],
  // C: bars 9-12 — building tension, descending runs
  ['A5',0.5],['A5',0.25],['G5',0.25],['E5',0.5],['D5',0.5],['C5',0.5],['D5',0.5],['E5',0.5],['G5',0.5],
  ['A5',0.75],['G5',0.25],['E5',0.25],['D5',0.25],['C5',0.5],['A4',0.5],['C5',0.5],['D5',0.25],['E5',0.25],['D5',0.5],
  // A': bars 13-16 — return with variation, dramatic ending
  ['E5',0.5],['E5',0.25],['E5',0.25],['G5',0.5],['A5',0.5],['G5',0.25],['E5',0.25],['D5',0.5],['C5',0.5],
  ['D5',0.5],['E5',0.25],['G5',0.25],['A5',0.5],['G5',0.5],['E5',0.25],['D5',0.25],['E5',0.25],['C5',0.25],['D5',0.5],['E5',0.5],
];

// Pumping bass — octave jumps and driving rhythm
const BASS = [
  // A: bars 1-4
  ['A3',0.5],['A3',0.5],['E3',0.5],['A3',0.5],['C4',0.5],['C4',0.5],['G3',0.5],['C4',0.5],
  ['F3',0.5],['F3',0.5],['C3',0.5],['F3',0.5],['G3',0.5],['G3',0.5],['D3',0.5],['G3',0.5],
  // B: bars 5-8 — syncopated variation
  ['A3',0.5],['E3',0.25],['A3',0.25],['A3',0.5],['E3',0.5],['C4',0.5],['G3',0.25],['C4',0.25],['C4',0.5],['G3',0.5],
  ['F3',0.5],['C3',0.25],['F3',0.25],['F3',0.5],['C3',0.5],['G3',0.5],['G3',0.25],['D3',0.25],['G3',0.25],['G3',0.25],['A3',0.5],
  // C: bars 9-12 — double-time pumping
  ['A3',0.25],['A3',0.25],['E3',0.25],['A3',0.25],['A3',0.25],['E3',0.25],['A3',0.25],['E3',0.25],
  ['C4',0.25],['C4',0.25],['G3',0.25],['C4',0.25],['C4',0.25],['G3',0.25],['C4',0.25],['G3',0.25],
  ['F3',0.25],['F3',0.25],['C3',0.25],['F3',0.25],['F3',0.25],['C3',0.25],['F3',0.25],['C3',0.25],
  ['G3',0.25],['G3',0.25],['D3',0.25],['G3',0.25],['G3',0.25],['D3',0.25],['G3',0.25],['A3',0.25],
  // A': bars 13-16
  ['A3',0.5],['A3',0.5],['E3',0.5],['A3',0.5],['C4',0.5],['C4',0.5],['G3',0.5],['C4',0.5],
  ['F3',0.5],['F3',0.5],['C3',0.5],['F3',0.5],['G3',0.5],['G3',0.25],['G3',0.25],['G3',0.25],['A3',0.25],
];

// Rapid arpeggiated chords — follows harmony, 16 bars
const ARP = [
  // A: bars 1-4
  ['A4',0.25],['C5',0.25],['E5',0.25],['A4',0.25], ['A4',0.25],['C5',0.25],['E5',0.25],['A4',0.25],
  ['C5',0.25],['E5',0.25],['G5',0.25],['C5',0.25], ['C5',0.25],['E5',0.25],['G5',0.25],['C5',0.25],
  ['F4',0.25],['A4',0.25],['C5',0.25],['F4',0.25], ['F4',0.25],['A4',0.25],['C5',0.25],['F4',0.25],
  ['G4',0.25],['B4',0.25],['D5',0.25],['G4',0.25], ['G4',0.25],['B4',0.25],['D5',0.25],['G4',0.25],
  // B: bars 5-8 — descending arp pattern
  ['E5',0.25],['C5',0.25],['A4',0.25],['E5',0.25], ['E5',0.25],['C5',0.25],['A4',0.25],['C5',0.25],
  ['G5',0.25],['E5',0.25],['C5',0.25],['G5',0.25], ['G5',0.25],['E5',0.25],['C5',0.25],['E5',0.25],
  ['C5',0.25],['A4',0.25],['F4',0.25],['C5',0.25], ['C5',0.25],['A4',0.25],['F4',0.25],['A4',0.25],
  ['D5',0.25],['B4',0.25],['G4',0.25],['D5',0.25], ['D5',0.25],['B4',0.25],['G4',0.25],['B4',0.25],
  // C: bars 9-12 — rapid ascending
  ['A4',0.25],['C5',0.25],['E5',0.25],['A5',0.25], ['E5',0.25],['C5',0.25],['A4',0.25],['C5',0.25],
  ['C5',0.25],['E5',0.25],['G5',0.25],['E5',0.25], ['G5',0.25],['E5',0.25],['C5',0.25],['E5',0.25],
  ['F4',0.25],['A4',0.25],['C5',0.25],['F5',0.25], ['C5',0.25],['A4',0.25],['F4',0.25],['A4',0.25],
  ['G4',0.25],['B4',0.25],['D5',0.25],['G5',0.25], ['D5',0.25],['B4',0.25],['G4',0.25],['B4',0.25],
  // A': bars 13-16 — same as A
  ['A4',0.25],['C5',0.25],['E5',0.25],['A4',0.25], ['A4',0.25],['C5',0.25],['E5',0.25],['A4',0.25],
  ['C5',0.25],['E5',0.25],['G5',0.25],['C5',0.25], ['C5',0.25],['E5',0.25],['G5',0.25],['C5',0.25],
  ['F4',0.25],['A4',0.25],['C5',0.25],['F4',0.25], ['F4',0.25],['A4',0.25],['C5',0.25],['F4',0.25],
  ['G4',0.25],['B4',0.25],['D5',0.25],['G4',0.25], ['G4',0.25],['B4',0.25],['D5',0.25],['G4',0.25],
];

// Pre-calculate loop duration in seconds
const MELODY_DUR = MELODY.reduce((s, [, b]) => s + b * BEAT, 0);

function scheduleLoop(ac, startTime) {
  // Lead melody — punchy square wave
  let t = startTime;
  for (const [note, beats] of MELODY) {
    const dur = beats * BEAT;
    const osc = ac.createOscillator();
    const g   = ac.createGain();
    osc.connect(g);
    g.connect(musicGain);
    osc.type = 'square';
    osc.frequency.value = NOTE_FREQS[note];
    g.gain.setValueAtTime(0.45, t);
    g.gain.setValueAtTime(0.45, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.01, t + dur * 0.85);
    osc.start(t);
    osc.stop(t + dur);
    t += dur;
  }

  // Driving bass — layered sawtooth + triangle for heavy low-end
  let bt = startTime;
  for (const [note, beats] of BASS) {
    const dur = beats * BEAT;
    const freq = NOTE_FREQS[note];

    // Main bass — sawtooth, loud
    const osc1 = ac.createOscillator();
    const g1   = ac.createGain();
    osc1.connect(g1);
    g1.connect(musicGain);
    osc1.type = 'sawtooth';
    osc1.frequency.value = freq;
    g1.gain.setValueAtTime(0.5, bt);
    g1.gain.exponentialRampToValueAtTime(0.01, bt + dur * 0.75);
    osc1.start(bt);
    osc1.stop(bt + dur);

    // Sub bass — triangle one octave down for rumble
    const osc2 = ac.createOscillator();
    const g2   = ac.createGain();
    osc2.connect(g2);
    g2.connect(musicGain);
    osc2.type = 'triangle';
    osc2.frequency.value = freq * 0.5;
    g2.gain.setValueAtTime(0.6, bt);
    g2.gain.exponentialRampToValueAtTime(0.01, bt + dur * 0.8);
    osc2.start(bt);
    osc2.stop(bt + dur);

    bt += dur;
  }

  // Fast arpeggio — quiet pulse wave shimmer
  let at = startTime;
  for (const [note, beats] of ARP) {
    const dur = beats * BEAT;
    const osc = ac.createOscillator();
    const g   = ac.createGain();
    osc.connect(g);
    g.connect(musicGain);
    osc.type = 'square';
    osc.frequency.value = NOTE_FREQS[note] * 0.5; // one octave down for body
    g.gain.setValueAtTime(0.12, at);
    g.gain.exponentialRampToValueAtTime(0.01, at + dur * 0.6);
    osc.start(at);
    osc.stop(at + dur);
    at += dur;
  }
}

let nextLoopStart = 0;

function playMusic() {
  if (musicPlaying) return;
  musicPlaying = true;
  const ac = getAC();

  if (!musicGain) {
    musicGain = ac.createGain();
    musicGain.connect(ac.destination);
    musicGain.gain.value = musicMuted ? 0 : 0.08;
  }

  // Schedule first two loops immediately for gapless playback
  nextLoopStart = ac.currentTime + 0.05;
  scheduleLoop(ac, nextLoopStart);
  nextLoopStart += MELODY_DUR;
  scheduleLoop(ac, nextLoopStart);
  nextLoopStart += MELODY_DUR;

  // Keep scheduling ahead — check every half-loop if we need another
  musicTimeout = setInterval(() => {
    if (!musicPlaying) return;
    const ac = getAC();
    // Always stay at least one loop ahead of current time
    while (nextLoopStart < ac.currentTime + MELODY_DUR + 0.5) {
      scheduleLoop(ac, nextLoopStart);
      nextLoopStart += MELODY_DUR;
    }
  }, (MELODY_DUR / 2) * 1000);
}

function stopMusic() {
  musicPlaying = false;
  if (musicTimeout) { clearInterval(musicTimeout); musicTimeout = null; }
}

function toggleMusic() {
  musicMuted = !musicMuted;
  if (musicGain) musicGain.gain.value = musicMuted ? 0 : 0.08;
  const btn = $('music-btn');
  if (btn) btn.textContent = musicMuted ? '🔇' : '🔊';
}

// ── Particle system ──────────────────────────────────────────────────────────
const particles = [];
let lastFrameTime = Date.now();

function spawnParticles(gx, gy, color, count) {
  const cx = gx * TILE + TILE / 2;
  const cy = gy * TILE + TILE / 2;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const speed = 40 + Math.random() * 60;
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      decay: 1.2 + Math.random() * 0.8,
      size: TILE * 0.08 + Math.random() * TILE * 0.08,
      color,
    });
  }
}

function updateAndRenderParticles() {
  const now = Date.now();
  const dt  = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    pt.x    += pt.vx * dt;
    pt.y    += pt.vy * dt;
    pt.life -= pt.decay * dt;
    if (pt.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = pt.life;
    ctx.fillStyle   = pt.color;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function triggerParticles(prev, curr) {
  if (!prev || !curr) return;
  for (const [id, p] of Object.entries(curr.players)) {
    const pp = prev.players[id];
    if (!pp) continue;
    // Steal: started carrying
    if (!pp.carrying && p.carrying) {
      // Find which base lost items
      for (const q of Object.values(curr.players)) {
        const prevQ = prev.players[q.id];
        if (prevQ && q.baseItems < prevQ.baseItems) {
          spawnParticles(q.baseX, q.baseY, '#ff4444', 12);
          break;
        }
      }
    }
    // Deposit: stopped carrying, gained base items
    if (pp.carrying && !p.carrying && p.baseItems > pp.baseItems) {
      spawnParticles(p.baseX, p.baseY, '#ffd700', 15);
    }
  }
}

// ── Kill feed (DOM-based live stream style) ──────────────────────────────────
const FEED_MAX  = 30;
const FEED_FADE = 15000; // ms before fade out

socket.on('game_event', evt => {
  let html = '';
  switch (evt.type) {
    case 'steal':
      html = `<span class="feed-actor" style="color:${evt.actorColor}">${escHtml(evt.actor)}</span> stole from <span class="feed-actor" style="color:${evt.victimColor}">${escHtml(evt.victim)}</span>`;
      break;
    case 'deposit':
      html = `<span class="feed-actor" style="color:${evt.actorColor}">${escHtml(evt.actor)}</span> deposited${evt.count > 1 ? ' x' + evt.count : ''}`;
      break;
    case 'boost':
      html = `<span class="feed-actor" style="color:${evt.actorColor}">${escHtml(evt.actor)}</span> picked up ⚡`;
      break;
    case 'shield':
      html = `<span class="feed-actor" style="color:${evt.actorColor}">${escHtml(evt.actor)}</span> picked up 🛡️`;
      break;
    case 'bounce':
      html = `<span class="feed-actor" style="color:${evt.actorColor}">${escHtml(evt.actor)}</span> bounced <span class="feed-actor" style="color:${evt.victimColor}">${escHtml(evt.victim)}</span>`;
      break;
    default: return;
  }

  const el = document.createElement('div');
  el.className = 'feed-item';
  el.innerHTML = html;
  feedList.appendChild(el);
  feedList.scrollTop = feedList.scrollHeight;

  // Fade old items
  setTimeout(() => { el.classList.add('feed-fade'); }, FEED_FADE);
  setTimeout(() => { el.remove(); }, FEED_FADE + 600);

  // Cap total items
  while (feedList.children.length > FEED_MAX) {
    feedList.firstChild.remove();
  }
});

// ── Util ──────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
