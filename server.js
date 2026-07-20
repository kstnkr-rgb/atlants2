// Сервер комнат «Атланты PvP» — чистый Node.js без зависимостей.
// Хранит бои в памяти, клиенты опрашивают состояние (long-poll-lite).
// Деплой: Railway/любой Node-хостинг, порт из process.env.PORT.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createBattle, applyAction, viewFor } = require('./engine');

const PORT = process.env.PORT || 3000;
const cardsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'cards.json'), 'utf8'));
const cardById = Object.fromEntries(cardsData.cards.map(c => [c.cardID, c]));

// Эмуляция колод: каждому игроку на бой собирается случайная колода из пула карт.
// Когда появятся реальные конфиги и правила сбора колоды — заменить эту функцию.
const DECK_SIZE = 20;
function buildRandomDeck() {
  const pool = cardsData.cards;
  return Array.from({ length: DECK_SIZE }, () => pool[Math.floor(Math.random() * pool.length)]);
}

const rooms = new Map(); // code -> {state, tokens:[t0,t1], names:[..], createdAt, touchedAt}
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touchedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 60 * 1000);

function roomCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих символов
  let code;
  do {
    code = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function findPlayer(room, token) {
  return room.tokens.indexOf(token);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', ch => { data += ch; if (data.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'POST' && url.pathname === '/api/room') {
      const { name } = await readBody(req);
      const code = roomCode();
      const token = crypto.randomBytes(12).toString('hex');
      rooms.set(code, {
        state: null,
        tokens: [token, null],
        names: [String(name || 'Игрок 1').slice(0, 20), null],
        createdAt: Date.now(), touchedAt: Date.now(),
      });
      return json(res, 200, { room: code, player: 0, token });
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const { room: code, name } = await readBody(req);
      const room = rooms.get(String(code || '').toUpperCase());
      if (!room) return json(res, 404, { error: 'Комната не найдена' });
      if (room.tokens[1]) return json(res, 409, { error: 'Комната уже заполнена' });
      const token = crypto.randomBytes(12).toString('hex');
      room.tokens[1] = token;
      room.names[1] = String(name || 'Игрок 2').slice(0, 20);
      room.state = createBattle(room.names[0], room.names[1], buildRandomDeck(), buildRandomDeck());
      room.touchedAt = Date.now();
      return json(res, 200, { room: String(code).toUpperCase(), player: 1, token });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
      if (!room) return json(res, 404, { error: 'Комната не найдена' });
      const idx = findPlayer(room, url.searchParams.get('token'));
      if (idx === -1) return json(res, 403, { error: 'Нет доступа к комнате' });
      room.touchedAt = Date.now();
      if (!room.state) return json(res, 200, { waiting: true, room: url.searchParams.get('room').toUpperCase() });
      return json(res, 200, viewFor(room.state, idx));
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      const { room: code, token, action } = await readBody(req);
      const room = rooms.get(String(code || '').toUpperCase());
      if (!room) return json(res, 404, { error: 'Комната не найдена' });
      const idx = findPlayer(room, token);
      if (idx === -1) return json(res, 403, { error: 'Нет доступа к комнате' });
      if (!room.state) return json(res, 400, { error: 'Противник ещё не подключился' });
      room.touchedAt = Date.now();
      if (action && action.type === 'rematch') {
        if (room.state.winner === null) return json(res, 400, { error: 'Бой ещё идёт' });
        room.state = createBattle(room.names[0], room.names[1], buildRandomDeck(), buildRandomDeck());
        return json(res, 200, { ok: true });
      }
      const result = applyAction(room.state, idx, action || {});
      return json(res, result.ok ? 200 : 400, result);
    }

    // статика
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      const safe = path.normalize(file).replace(/^([.][.][/\\])+/, '');
      const full = path.join(__dirname, 'public', safe);
      if (full.startsWith(path.join(__dirname, 'public')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        const ext = path.extname(full);
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        return fs.createReadStream(full).pipe(res);
      }
    }

    json(res, 404, { error: 'Не найдено' });
  } catch (e) {
    json(res, 500, { error: 'Ошибка сервера: ' + e.message });
  }
});

server.listen(PORT, () => console.log(`Atlanteans PvP arbiter on :${PORT}`));
