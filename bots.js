// Usage: node bots.js [count] [url]
// Example: node bots.js 50 http://localhost:3000

const { io } = require('socket.io-client');

const COUNT = parseInt(process.argv[2]) || 50;
const URL   = process.argv[3] || 'http://localhost:3000';

const CHARACTERS = ['pete', 'francis', 'alicia', 'nigel', 'scotland', 'chardi'];
const DIRS       = ['up', 'down', 'left', 'right'];

const bots = [];

for (let i = 0; i < COUNT; i++) {
  const socket = io(URL);
  const name   = `Bot-${i + 1}`;
  const character = CHARACTERS[i % CHARACTERS.length];

  socket.on('connect', () => {
    socket.emit('join', { name, character });
  });

  socket.on('joined', () => {
    console.log(`${name} joined`);
  });

  socket.on('err', msg => {
    console.log(`${name} error: ${msg}`);
  });

  // Move randomly at varying intervals
  let moveInterval = null;
  socket.on('state_update', s => {
    if (s.phase === 'playing' && !moveInterval) {
      moveInterval = setInterval(() => {
        socket.emit('move', DIRS[Math.floor(Math.random() * 4)]);
      }, 150 + Math.random() * 200);
    }
    if (s.phase !== 'playing' && moveInterval) {
      clearInterval(moveInterval);
      moveInterval = null;
    }
  });

  bots.push(socket);
}

console.log(`Connecting ${COUNT} bots to ${URL}...`);

// Clean disconnect on ctrl+c
process.on('SIGINT', () => {
  console.log('\nDisconnecting bots...');
  bots.forEach(s => s.disconnect());
  setTimeout(() => process.exit(), 500);
});
