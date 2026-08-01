'use strict';
/*
  Сервер игры: статика + HTTP поверх лобби и сервера матчей.

  1. /api/lobby, /api/invite, /api/answer, /api/ready, /api/leave — лобби.js:
     присутствие, вызовы по id, согласование колод.
  2. /api/match/* — matches.js: бой считается здесь, каждое действие проверяется
     (PROJECT.md, раздел 14).
  3. /api/create, /api/join, /api/push, /api/act, /api/poll — СТАРЫЙ релей
     «по коду комнаты»: правил не знает, бой считал браузер хоста. Никем больше
     не используется, оставлен до отдельной уборки.

  Запуск: node relay.js   (порт 3000 или process.env.PORT — как на Railway)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./matches.js');
const L = require('./lobby.js');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const ROOM_TTL = 6 * 60 * 60 * 1000;   // комната живёт 6 часов, как в старом арбитре
const ACTS_KEEP = 200;                 // подтверждённые действия дальше не храним

/** @type {Map<string, object>} */
const rooms = new Map();

const now = () => Date.now();
const token = () => crypto.randomBytes(12).toString('hex');

function makeCode() {
  for (let i = 0; i < 200; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return null;   // 9000 кодов заняты — такого на тесте не бывает
}

function sweep() {
  const t = now();
  for (const [code, r] of rooms) if (t - r.born > ROOM_TTL) rooms.delete(code);
}

/** Комната + сторона по токену; null, если кода нет или токен чужой. */
function seat(code, tok) {
  const r = rooms.get(String(code || ''));
  if (!r) return null;
  if (r.host.token === tok) return { room: r, side: r.host, role: 'host' };
  if (r.guest && r.guest.token === tok) return { room: r, side: r.guest, role: 'guest' };
  return null;
}

/* ---------- API ---------- */

const api = {
  // хост создаёт комнату и кладёт свою колоду
  create(body) {
    sweep();
    const code = makeCode();
    if (!code) return { err: 'нет свободных кодов' };
    const room = {
      code, born: now(),
      host: { token: token(), deck: body.deck || null, seen: now() },
      guest: null,
      snap: null, rev: 0,          // снимок состояния от хоста и его версия
      acts: [], actN: 0,           // действия гостя, каждое со своим номером
    };
    rooms.set(code, room);
    return { code, token: room.host.token };
  },

  // гость входит по коду и отдаёт свою колоду
  join(body) {
    sweep();
    const room = rooms.get(String(body.code || '').trim());
    if (!room) return { err: 'комната не найдена' };
    if (room.guest) return { err: 'в комнате уже двое' };
    room.guest = { token: token(), deck: body.deck || null, seen: now() };
    return { token: room.guest.token };
  },

  // хост присылает снимок, уже перевёрнутый под гостя
  push(body) {
    const s = seat(body.code, body.token);
    if (!s) return { err: 'нет доступа' };
    if (s.role !== 'host') return { err: 'снимок шлёт только хост' };
    s.side.seen = now();
    s.room.snap = body.snap;
    s.room.rev++;
    return { ok: true, rev: s.room.rev };
  },

  // гость шлёт действие: сыграть карту, взять новую, закончить ход, реванш
  act(body) {
    const s = seat(body.code, body.token);
    if (!s) return { err: 'нет доступа' };
    if (s.role !== 'guest') return { err: 'действия шлёт только гость' };
    s.side.seen = now();
    s.room.acts.push({ n: ++s.room.actN, act: body.act });
    return { ok: true, n: s.room.actN };
  },
};

/* ---------- лобби ----------
   Присутствие держится опросом /api/lobby, он же приносит вызовы, пару
   и готовый бой. Кодов комнат нет: вызывают по id из списка. */
const lobbyApi = {
  lobby(body) {
    const h = L.hello(body.playerId, body.name);
    if (h.err) return h;
    return L.snapshot(String(body.playerId));
  },
  invite(body) { return L.invite(String(body.playerId), String(body.to)); },
  answer(body) { return L.answer(String(body.playerId), !!body.ok); },
  ready(body)  { return L.ready(String(body.playerId), String(body.pairId), body.deck); },
  leave(body)  { return L.leave(String(body.playerId)); },
};

/* ---------- сервер матчей ----------
   Сторона определяется по токену, выданному при создании боя. playerId,
   присланный клиентом, сам по себе не принимается: подделать его нельзя.
   Колоды пока приходят от клиента — серверное хранилище это шаг 5. */
const matchApi = {
  // создать бой напрямую, минуя лобби; используется тестами
  // создать бой; в ответ два токена — по одному каждой стороне
  'match/new'(body) {
    const a = body.a, b = body.b;
    if (!a || !a.id || !b || !b.id) return { err: 'нужны оба игрока' };
    if (a.id === b.id) return { err: 'игрок не может биться сам с собой' };
    const { match, err } = M.createMatch(
      { id: String(a.id), name: String(a.name || a.id) },
      { id: String(b.id), name: String(b.name || b.id) },
      body.deckA, body.deckB, body.seed);
    if (err) return { err };
    return { matchId: match.id, tokens: { a: match.tokens[0], b: match.tokens[1] } };
  },

  // текущее состояние глазами игрока: туман войны уже наложен
  'match/state'(body) {
    const m = M.get(body.matchId);
    if (!m) return { err: 'бой не найден' };
    const who = M.playerByToken(m, body.token);
    if (!who) return { err: 'нет доступа' };
    return M.viewFor(m, who, body.logFrom);
  },

  // намерение игрока: сыграть карту, взять новую, закончить ход, сдаться
  async 'match/act'(body) {
    const m = M.get(body.matchId);
    if (!m) return { err: 'бой не найден' };
    const who = M.playerByToken(m, body.token);
    if (!who) return { err: 'нет доступа' };
    return M.applyAction(m, who, body.seq, body.act);
  },
};

setInterval(() => { M.sweep(); L.sweep(); }, 30 * 1000).unref();

/** Опрос — один на обе стороны; что вернуть, зависит от роли. */
function poll(q) {
  const s = seat(q.code, q.token);
  if (!s) return { err: 'нет доступа' };
  s.side.seen = now();
  const r = s.room;
  const opp = s.role === 'host' ? r.guest : r.host;
  const out = {
    role: s.role,
    // сколько миллисекунд назад соперник последний раз выходил на связь
    oppAgo: opp ? now() - opp.seen : null,
  };

  if (s.role === 'host') {
    out.foeDeck = r.guest ? r.guest.deck : null;   // колода гостя — как только он вошёл
    const ack = +q.ack || 0;
    out.acts = r.acts.filter(a => a.n > ack);
    if (ack) {
      r.acts = r.acts.filter(a => a.n > ack).slice(-ACTS_KEEP);
    }
  } else {
    out.rev = r.rev;
    if (r.rev > (+q.rev || 0)) out.snap = r.snap;   // снимок шлём только если он новее
  }
  return out;
}

/* ---------- статика ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.csv': 'text/csv; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  // корень уводим в /proto/, а не отдаём index.html прямо здесь:
  // иначе относительные cards.js, net.js и img/ браузер попросит из корня репозитория
  if (urlPath === '/') { res.writeHead(302, { Location: '/proto/' }).end(); return; }

  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel.endsWith('/') ? rel + 'index.html' : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('нельзя'); return; }   // выход за корень
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('нет такого файла'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',   // иначе телефон держит старую версию прототипа
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- сервер ---------- */

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(obj && obj.err ? 400 : 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 1e6) { reject(new Error('слишком большой запрос')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // страницу можно открыть и с githack — тогда она стучится сюда через ?server=
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (url.pathname === '/api/poll') {
    sendJson(res, poll(Object.fromEntries(url.searchParams)));
    return;
  }

  const name = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : null;
  if (name) {
    const handler = lobbyApi[name] || matchApi[name] || api[name];
    if (req.method !== 'POST' || !handler) { sendJson(res, { err: 'неизвестный запрос' }); return; }
    try {
      sendJson(res, await handler(await readBody(req)));
    } catch (e) {
      sendJson(res, { err: String(e.message || e) });
    }
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Атланты: релей PvP на порту ${PORT}`);
  console.log(`  игра:  http://localhost:${PORT}/proto/`);
  for (const [name, list] of Object.entries(require('os').networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`  с телефона (${name}): http://${i.address}:${PORT}/proto/`);
    }
  }
});
