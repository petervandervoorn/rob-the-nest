const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static('public'));

const MOVE_COOLDOWN  = 150; // ms (halved when speed-boosted)
const BOOST_DURATION = 10000; // ms
const BOOST_RESPAWN  = 20000; // ms after pickup before it reappears

const VALID_TIMERS = [60, 120, 180, 300, 600];
const DEFAULT_DURATION = 300;
const DEFAULT_ITEMS    = 10;

// ── Tier system ───────────────────────────────────────────────────────────────
// tileSize is sent to the client so the canvas scales to ~680px regardless of tier
const TIERS = [
  { maxPlayers:   8, gridSize: 21, tileSize: 32, obstacles: 18 },
  { maxPlayers:  20, gridSize: 31, tileSize: 22, obstacles: 35 },
  { maxPlayers:  50, gridSize: 41, tileSize: 19, obstacles: 55 },
  { maxPlayers: 100, gridSize: 55, tileSize: 14, obstacles: 75 },
];
const MAX_PLAYERS = TIERS[TIERS.length - 1].maxPlayers;

function getTier(playerCount) {
  return TIERS.find(t => playerCount <= t.maxPlayers) ?? TIERS[TIERS.length - 1];
}

// Evenly space N bases around the perimeter of a gridSize×gridSize grid
function generateBasePositions(count, gridSize) {
  const max       = gridSize - 1;
  const perimeter = 4 * max;
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * perimeter;
    if      (t <= max)     return { x: Math.round(t),               y: 0   };
    else if (t <= 2 * max) return { x: max,                          y: Math.round(t - max)       };
    else if (t <= 3 * max) return { x: max - Math.round(t - 2*max), y: max };
    else                   return { x: 0,                            y: max - Math.round(t - 3*max) };
  });
}

// Assign base positions to all current players based on tier (used at start + restart)
function assignPositions(tier) {
  const positions = generateBasePositions(Object.keys(state.players).length, tier.gridSize);
  let slot = 0;
  for (const p of Object.values(state.players)) {
    const base = positions[slot++];
    p.x = base.x;  p.y = base.y;
    p.baseX = base.x;  p.baseY = base.y;
  }
}

// Golden-angle HSL spacing for max visual distinction across 100 players
const COLORS = Array.from({ length: 100 }, (_, i) =>
  `hsl(${Math.round(i * 137.5) % 360}, 70%, 55%)`
);

const VALID_CHARACTERS = new Set(['pete', 'francis', 'alicia', 'nigel', 'scotland', 'chardi']);

const DIR_DELTA = {
  up:    { dx:  0, dy: -1 },
  down:  { dx:  0, dy:  1 },
  left:  { dx: -1, dy:  0 },
  right: { dx:  1, dy:  0 },
};

const OBSTACLE_EMOJIS = ['🧱', '🪨'];

function generateObstacles(players, gridSize, count) {
  // Block base tiles + a 2-tile buffer so players always have room to manoeuvre
  const blocked = new Set();
  for (const p of Object.values(players)) {
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -2; dy <= 2; dy++)
        blocked.add(`${p.baseX + dx},${p.baseY + dy}`);
  }

  const obstacles = [];
  let attempts = 0;
  while (obstacles.length < count && attempts < 500) {
    attempts++;
    const x = 1 + Math.floor(Math.random() * (gridSize - 2));
    const y = 1 + Math.floor(Math.random() * (gridSize - 2));
    const key = `${x},${y}`;
    if (!blocked.has(key)) {
      blocked.add(key);
      obstacles.push({ x, y, emoji: OBSTACLE_EMOJIS[Math.floor(Math.random() * OBSTACLE_EMOJIS.length)] });
    }
  }
  return obstacles;
}

function spawnSnorlax() {
  const g = state.gridSize;
  const blocked = new Set();
  for (const p of Object.values(state.players)) {
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -2; dy <= 2; dy++)
        blocked.add(`${p.baseX + dx},${p.baseY + dy}`);
  }
  for (const o of state.obstacles) blocked.add(`${o.x},${o.y}`);

  let attempts = 0;
  while (attempts < 500) {
    attempts++;
    const x = 1 + Math.floor(Math.random() * (g - 3));
    const y = 1 + Math.floor(Math.random() * (g - 3));
    if (!blocked.has(`${x},${y}`)   && !blocked.has(`${x+1},${y}`) &&
        !blocked.has(`${x},${y+1}`) && !blocked.has(`${x+1},${y+1}`)) {
      state.snorlax = { x, y };
      return;
    }
  }
}

function moveSnorlax() {
  if (state.phase !== 'playing' || !state.snorlax) return;
  const g = state.gridSize;
  const { x: sx, y: sy } = state.snorlax;
  const dirs = [{ dx:0,dy:-1 }, { dx:0,dy:1 }, { dx:-1,dy:0 }, { dx:1,dy:0 }];
  for (let i = dirs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
  }

  const bases   = new Set(Object.values(state.players).map(p => `${p.baseX},${p.baseY}`));
  const current = new Set([`${sx},${sy}`,`${sx+1},${sy}`,`${sx},${sy+1}`,`${sx+1},${sy+1}`]);

  for (const { dx, dy } of dirs) {
    const nx = sx + dx, ny = sy + dy;
    if (nx < 0 || nx > g - 2 || ny < 0 || ny > g - 2) continue;
    const newTiles = [`${nx},${ny}`,`${nx+1},${ny}`,`${nx},${ny+1}`,`${nx+1},${ny+1}`];
    const blocked  = newTiles.some(t => !current.has(t) && (state.obstacleSet.has(t) || bases.has(t) || state.posMap.has(t)));
    if (!blocked) {
      state.snorlax = { x: nx, y: ny };
      state.dirty = true;
      return;
    }
  }
}

function makeState() {
  return {
    phase:        'lobby',
    players:      {},
    timer:        DEFAULT_DURATION,
    hostId:       null,
    nextSlot:     0,
    powerUp:      null,
    shieldUp:     null,
    obstacles:    [],
    obstacleSet:  new Set(),
    posMap:       new Map(),   // "x,y" -> player id
    snorlax:      null,
    droppedItems: [],
    dirty:        false,
    gridSize:     TIERS[0].gridSize,
    tileSize:     TIERS[0].tileSize,
    settings:     { duration: DEFAULT_DURATION, startingItems: DEFAULT_ITEMS },
  };
}

function spawnDroppedItem(nearX, nearY) {
  const g       = state.gridSize;
  const blocked = new Set();
  for (const o of state.obstacles) blocked.add(`${o.x},${o.y}`);
  for (const p of Object.values(state.players)) {
    blocked.add(`${p.x},${p.y}`);
    blocked.add(`${p.baseX},${p.baseY}`);
  }
  if (state.snorlax) {
    const { x: sx, y: sy } = state.snorlax;
    for (let dx = 0; dx <= 1; dx++)
      for (let dy = 0; dy <= 1; dy++)
        blocked.add(`${sx + dx},${sy + dy}`);
  }
  for (const d of state.droppedItems) blocked.add(`${d.x},${d.y}`);
  if (state.powerUp)  blocked.add(`${state.powerUp.x},${state.powerUp.y}`);
  if (state.shieldUp) blocked.add(`${state.shieldUp.x},${state.shieldUp.y}`);

  // Try rings expanding outward from the base, starting far enough that
  // the camper can't immediately nip out and reclaim the item
  for (let r = 5; r <= 10; r++) {
    const candidates = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring edge only
        const x = nearX + dx, y = nearY + dy;
        if (x < 0 || x >= g || y < 0 || y >= g) continue;
        if (!blocked.has(`${x},${y}`)) candidates.push({ x, y });
      }
    }
    if (candidates.length > 0) {
      state.droppedItems.push(candidates[Math.floor(Math.random() * candidates.length)]);
      return;
    }
  }

  // Fallback: anywhere on the grid
  for (let tries = 0; tries < 300; tries++) {
    const x = Math.floor(Math.random() * g);
    const y = Math.floor(Math.random() * g);
    if (!blocked.has(`${x},${y}`)) { state.droppedItems.push({ x, y }); return; }
  }
}

let state           = makeState();
let ticker          = null;
let gameTick        = null;
let powerUpTimer    = null;
let shieldUpTimer   = null;
let snorlaxInterval = null;

function snapshot() {
  const players = {};
  for (const [id, p] of Object.entries(state.players)) {
    players[id] = {
      id:               p.id,
      name:             p.name,
      character:        p.character,
      color:            p.color,
      x:                p.x,
      y:                p.y,
      baseX:            p.baseX,
      baseY:            p.baseY,
      carrying:         p.carrying,
      baseItems:        p.baseItems,
      speedBoostExpiry: p.speedBoost,
      shieldExpiry:     p.shield,
      campTicks:        p.campTicks,
    };
  }
  return {
    phase:     state.phase,
    players,
    timer:     state.timer,
    hostId:    state.hostId,
    powerUp:      state.powerUp,
    shieldUp:     state.shieldUp,
    obstacles:    state.obstacles,
    snorlax:      state.snorlax,
    droppedItems: state.droppedItems,
    gridSize:     state.gridSize,
    tileSize:     state.tileSize,
  };
}

// ── Spawn-near helper (used for shield bounces) ───────────────────────────────
function findSpawnNear(baseX, baseY, excludeId) {
  const g = state.gridSize;
  for (let r = 0; r <= 4; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring edge only
        const x = baseX + dx, y = baseY + dy;
        if (x < 0 || x >= g || y < 0 || y >= g) continue;
        if (state.obstacles.some(o => o.x === x && o.y === y)) continue;
        if (state.snorlax && x >= state.snorlax.x && x <= state.snorlax.x + 1 &&
                             y >= state.snorlax.y && y <= state.snorlax.y + 1) continue;
        if (Object.values(state.players).some(p => p.id !== excludeId && p.x === x && p.y === y)) continue;
        return { x, y };
      }
    }
  }
  return { x: baseX, y: baseY };
}

// ── Power-up ──────────────────────────────────────────────────────────────────
function spawnPowerUp() {
  if (state.phase !== 'playing') return;
  const g = state.gridSize;

  const blocked = new Set();
  for (const p of Object.values(state.players)) {
    blocked.add(`${p.baseX},${p.baseY}`);
    blocked.add(`${p.x},${p.y}`);
  }
  for (const o of state.obstacles) blocked.add(`${o.x},${o.y}`);

  let x, y, tries = 0;
  do {
    x = 1 + Math.floor(Math.random() * (g - 2));
    y = 1 + Math.floor(Math.random() * (g - 2));
    tries++;
  } while (blocked.has(`${x},${y}`) && tries < 300);

  state.powerUp = { x, y };
  state.dirty = true;
}

// ── Shield pickup ─────────────────────────────────────────────────────────────
function spawnShieldUp() {
  if (state.phase !== 'playing') return;
  const g = state.gridSize;

  const blocked = new Set();
  for (const p of Object.values(state.players)) {
    blocked.add(`${p.baseX},${p.baseY}`);
    blocked.add(`${p.x},${p.y}`);
  }
  for (const o of state.obstacles) blocked.add(`${o.x},${o.y}`);
  if (state.powerUp) blocked.add(`${state.powerUp.x},${state.powerUp.y}`);

  let x, y, tries = 0;
  do {
    x = 1 + Math.floor(Math.random() * (g - 2));
    y = 1 + Math.floor(Math.random() * (g - 2));
    tries++;
  } while (blocked.has(`${x},${y}`) && tries < 300);

  state.shieldUp = { x, y };
  state.dirty = true;
}

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  // JOIN
  socket.on('join', ({ name: rawName, character: rawChar } = {}) => {
    const name      = String(rawName ?? '').trim().slice(0, 16) || 'Player';
    const character = VALID_CHARACTERS.has(rawChar) ? rawChar : 'pete';

    if (state.phase !== 'lobby')
      return socket.emit('err', 'Game already in progress');
    if (Object.keys(state.players).length >= MAX_PLAYERS)
      return socket.emit('err', `Game is full (max ${MAX_PLAYERS})`);
    if (Object.values(state.players).some(p => p.name === name))
      return socket.emit('err', 'Name already taken');

    const slot = state.nextSlot++;

    state.players[socket.id] = {
      id:         socket.id,
      name,
      character,
      color:      COLORS[slot % COLORS.length],
      x:          0,
      y:          0,
      baseX:      0,
      baseY:      0,
      carrying:   false,
      baseItems:  state.settings.startingItems,
      speedBoost: 0,
      shield:     0,
      lastMove:   0,
      campTicks:  0,
    };

    if (!state.hostId) state.hostId = socket.id;

    socket.emit('joined', { playerId: socket.id });
    io.emit('state_update', snapshot());
  });

  // START
  socket.on('start_game', ({ timer: rawTimer, startingItems: rawItems } = {}) => {
    if (socket.id !== state.hostId || state.phase !== 'lobby') return;
    if (Object.keys(state.players).length < 2)
      return socket.emit('err', 'Need at least 2 players to start');

    const duration      = VALID_TIMERS.includes(+rawTimer) ? +rawTimer : DEFAULT_DURATION;
    const startingItems = Math.min(Math.max(parseInt(rawItems) || DEFAULT_ITEMS, 1), 30);

    state.settings = { duration, startingItems };

    const tier       = getTier(Object.keys(state.players).length);
    state.gridSize   = tier.gridSize;
    state.tileSize   = tier.tileSize;

    // Assign positions and items now that we know the tier
    assignPositions(tier);
    for (const p of Object.values(state.players)) p.baseItems = startingItems;

    state.obstacles = generateObstacles(state.players, tier.gridSize, tier.obstacles);
    state.obstacleSet = new Set(state.obstacles.map(o => `${o.x},${o.y}`));

    // Build position map from assigned positions
    state.posMap.clear();
    for (const p of Object.values(state.players)) {
      state.posMap.set(`${p.x},${p.y}`, p.id);
    }

    state.phase     = 'playing';
    state.timer     = duration;
    spawnSnorlax();
    snorlaxInterval = setInterval(moveSnorlax, 2000);

    ticker = setInterval(() => {
      // Camping penalty: players within 2 tiles of own base lose items after 5s grace
      for (const p of Object.values(state.players)) {
        const dist = Math.abs(p.x - p.baseX) + Math.abs(p.y - p.baseY);
        if (dist <= 2) {
          p.campTicks++;
          if (p.campTicks > 5 && p.campTicks % 3 === 0 && p.baseItems > 0) {
            p.baseItems--;
            spawnDroppedItem(p.baseX, p.baseY);
          }
        } else {
          p.campTicks = 0;
        }
      }

      state.timer--;
      if (state.timer <= 0) {
        state.timer   = 0;
        state.phase   = 'ended';
        state.powerUp  = null;
        state.shieldUp = null;
        state.snorlax  = null;
        clearInterval(ticker); ticker = null;
        if (gameTick)        { clearInterval(gameTick);          gameTick        = null; }
        if (powerUpTimer)    { clearTimeout(powerUpTimer);      powerUpTimer    = null; }
        if (shieldUpTimer)   { clearTimeout(shieldUpTimer);     shieldUpTimer   = null; }
        if (snorlaxInterval) { clearInterval(snorlaxInterval);  snorlaxInterval = null; }
      }
      io.emit('state_update', snapshot());
    }, 1000);

    // Fast game tick: batch-broadcast state changes at 10 Hz instead of per-move
    gameTick = setInterval(() => {
      if (state.dirty && state.phase === 'playing') {
        io.emit('state_update', snapshot());
        state.dirty = false;
      }
    }, 100);

    spawnPowerUp();
    spawnShieldUp();
    io.emit('state_update', snapshot());
  });

  // MOVE
  socket.on('move', dir => {
    if (state.phase !== 'playing') return;
    const p = state.players[socket.id];
    if (!p) return;

    const now      = Date.now();
    const boosted  = p.speedBoost > now;
    const cooldown = boosted ? Math.floor(MOVE_COOLDOWN / 2) : MOVE_COOLDOWN;
    if (now - p.lastMove < cooldown) return;

    const delta = DIR_DELTA[dir];
    if (!delta) return;

    const nx = p.x + delta.dx;
    const ny = p.y + delta.dy;

    if (nx < 0 || nx >= state.gridSize || ny < 0 || ny >= state.gridSize) return;
    const nKey = `${nx},${ny}`;
    if (state.obstacleSet.has(nKey)) return;
    if (state.snorlax && nx >= state.snorlax.x && nx <= state.snorlax.x + 1 &&
                         ny >= state.snorlax.y && ny <= state.snorlax.y + 1) return;

    // Check if another player occupies the target tile via posMap
    const occupantId = state.posMap.get(nKey);
    const occupant   = occupantId && occupantId !== socket.id ? state.players[occupantId] : null;

    // Shield bounce: if the target tile holds a shielded player, send mover home
    if (occupant && occupant.shield > now) {
      const oldKey = `${p.x},${p.y}`;
      const spawn = findSpawnNear(p.baseX, p.baseY, socket.id);
      state.posMap.delete(oldKey);
      p.x = spawn.x;  p.y = spawn.y;  p.lastMove = now;
      state.posMap.set(`${p.x},${p.y}`, socket.id);
      state.dirty = true;
      return;
    }

    // If mover is shielded and walks into someone, bounce that player home
    if (occupant && p.shield > now) {
      state.posMap.delete(nKey);
      const spawn = findSpawnNear(occupant.baseX, occupant.baseY, occupant.id);
      occupant.x = spawn.x;  occupant.y = spawn.y;
      state.posMap.set(`${occupant.x},${occupant.y}`, occupant.id);
      // fall through — mover takes the tile
    } else if (occupant) {
      return;
    }

    // Update posMap
    const oldKey = `${p.x},${p.y}`;
    state.posMap.delete(oldKey);
    p.x = nx;  p.y = ny;  p.lastMove = now;
    state.posMap.set(nKey, socket.id);

    // Deposit at own base
    if (p.carrying && nx === p.baseX && ny === p.baseY) {
      p.carrying = false;
      p.baseItems++;
    }

    // Steal from enemy base
    if (!p.carrying) {
      for (const q of Object.values(state.players)) {
        if (q.id !== socket.id && nx === q.baseX && ny === q.baseY && q.baseItems > 0) {
          q.baseItems--;
          p.carrying = true;
          break;
        }
      }
    }

    // Pick up dropped item
    if (!p.carrying) {
      const dropIdx = state.droppedItems.findIndex(d => d.x === nx && d.y === ny);
      if (dropIdx !== -1) {
        state.droppedItems.splice(dropIdx, 1);
        p.carrying = true;
      }
    }

    // Pick up speed boost
    if (state.powerUp && nx === state.powerUp.x && ny === state.powerUp.y) {
      p.speedBoost  = now + BOOST_DURATION;
      state.powerUp = null;
      powerUpTimer  = setTimeout(spawnPowerUp, BOOST_RESPAWN);
    }

    // Pick up shield
    if (state.shieldUp && nx === state.shieldUp.x && ny === state.shieldUp.y) {
      p.shield      = now + BOOST_DURATION;
      state.shieldUp = null;
      shieldUpTimer  = setTimeout(spawnShieldUp, BOOST_RESPAWN);
    }

    state.dirty = true;
  });

  // RESTART
  socket.on('restart', () => {
    if (socket.id !== state.hostId || state.phase !== 'ended') return;
    if (ticker)          { clearInterval(ticker);          ticker          = null; }
    if (gameTick)        { clearInterval(gameTick);        gameTick        = null; }
    if (powerUpTimer)    { clearTimeout(powerUpTimer);     powerUpTimer    = null; }
    if (shieldUpTimer)   { clearTimeout(shieldUpTimer);    shieldUpTimer   = null; }
    if (snorlaxInterval) { clearInterval(snorlaxInterval); snorlaxInterval = null; }

    const tier     = getTier(Object.keys(state.players).length);
    state.gridSize = tier.gridSize;
    state.tileSize = tier.tileSize;
    assignPositions(tier);

    for (const p of Object.values(state.players)) {
      p.carrying   = false;
      p.baseItems  = state.settings.startingItems;
      p.speedBoost = 0;
      p.shield     = 0;
      p.lastMove   = 0;
      p.campTicks  = 0;
    }

    // Rebuild posMap for new positions
    state.posMap.clear();
    for (const p of Object.values(state.players)) {
      state.posMap.set(`${p.x},${p.y}`, p.id);
    }

    state.nextSlot      = Object.keys(state.players).length;
    state.powerUp       = null;
    state.shieldUp      = null;
    state.droppedItems  = [];
    state.obstacles     = [];
    state.obstacleSet   = new Set();
    state.dirty         = false;
    state.snorlax   = null;
    state.phase     = 'lobby';
    state.timer     = state.settings.duration;
    io.emit('state_update', snapshot());
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    const p = state.players[socket.id];
    if (!p) return;

    // Remove from posMap
    state.posMap.delete(`${p.x},${p.y}`);
    delete state.players[socket.id];

    if (state.hostId === socket.id) {
      state.hostId = Object.keys(state.players)[0] || null;
      if (state.hostId) io.to(state.hostId).emit('promoted_to_host');
    }

    if (Object.keys(state.players).length === 0) {
      if (ticker)          { clearInterval(ticker);          ticker          = null; }
      if (gameTick)        { clearInterval(gameTick);        gameTick        = null; }
      if (powerUpTimer)    { clearTimeout(powerUpTimer);     powerUpTimer    = null; }
      if (shieldUpTimer)   { clearTimeout(shieldUpTimer);    shieldUpTimer   = null; }
      if (snorlaxInterval) { clearInterval(snorlaxInterval); snorlaxInterval = null; }
      state = makeState();
    } else {
      io.emit('state_update', snapshot());
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Rob the Nest → http://localhost:${PORT}`));
