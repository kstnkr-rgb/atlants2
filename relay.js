'use strict';
/*
  Сервер игры: статика + HTTP поверх лобби и сервера матчей.

  1. /api/session — auth.js: личность из подписанного токена МП.
  2. /api/lobby, /api/invite, /api/answer, /api/ready, /api/leave — lobby.js:
     присутствие, вызовы по id, согласование колод.
     /api/decks* — store.js: колоды и коллекция игрока.
  3. /api/match/* — matches.js: бой считается здесь, каждое действие проверяется
     (PROJECT.md, раздел 14).
  4. /api/create, /api/join, /api/push, /api/act, /api/poll — СТАРЫЙ релей
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
const A = require('./auth.js');
const store = require('./store.js');

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

/* ---------- сессия и личность ----------
   Кто пришёл, решает сервер по токену сессии. playerId от клиента не
   принимается нигде: подделать его нельзя (PROJECT.md, раздел 14.3). */
const authApi = {
  // МП открывает WebView и передаёт подписанный токен; без ATL_SECRET — режим разработки
  session(body) {
    const r = A.openSession(body);
    if (r.err) return r;
    store.setName(r.playerId, r.name);
    return { session: r.session, playerId: r.playerId, name: r.name, dev: r.dev };
  },
};

// кто это; { err } — если сессии нет
const who = body => {
  const s = A.whoIs(body && body.session);
  return s || null;
};
const NO_SESSION = { err: 'сессия не найдена, откройте игру заново' };

/* ---------- лобби ----------
   Присутствие держится опросом /api/lobby, он же приносит вызовы, пару
   и готовый бой. Кодов комнат нет: вызывают по id из списка. */
const lobbyApi = {
  lobby(body) {
    const s = who(body); if (!s) return NO_SESSION;
    const p = store.getPlayer(s.playerId);
    const h = L.hello(s.playerId, p.name || s.name);
    if (h.err) return h;
    return L.snapshot(s.playerId);
  },
  invite(body) { const s = who(body); return s ? L.invite(s.playerId, String(body.to)) : NO_SESSION; },
  answer(body) { const s = who(body); return s ? L.answer(s.playerId, !!body.ok) : NO_SESSION; },
  ready(body)  { const s = who(body); return s ? L.ready(s.playerId, String(body.pairId), String(body.deckId)) : NO_SESSION; },
  leave(body)  { const s = who(body); return s ? L.leave(s.playerId) : NO_SESSION; },
};

/* ---------- колоды и коллекция ----------
   Колоды живут на сервере и сверяются с коллекцией игрока. */
const deckApi = {
  decks(body) {
    const s = who(body); if (!s) return NO_SESSION;
    return store.listDecks(s.playerId);
  },
  'decks/save'(body) {
    const s = who(body); if (!s) return NO_SESSION;
    return store.saveDeck(s.playerId, body.deck || {});
  },
  'decks/del'(body) {
    const s = who(body); if (!s) return NO_SESSION;
    return store.delDeck(s.playerId, String(body.deckId));
  },
  'decks/name'(body) {
    const s = who(body); if (!s) return NO_SESSION;
    store.setName(s.playerId, body.name);
    return { ok: true };
  },
};

/* ---------- сервер матчей ----------
   Сторона определяется по токену, выданному при создании боя. playerId,
   присланный клиентом, сам по себе не принимается: подделать его нельзя.
   Бои рождает только лобби — отдельного «создать бой» снаружи нет. */
const matchApi = {
  // текущее состояние глазами игрока: туман войны уже наложен
  'match/state'(body) {
    const m = M.get(body.matchId);
    if (!m) return { err: 'бой не найден' };
    const side = M.playerByToken(m, body.token);
    if (!side) return { err: 'нет доступа' };
    return M.viewFor(m, side, body.logFrom);
  },

  // намерение игрока: сыграть карту, взять новую, закончить ход, сдаться
  async 'match/act'(body) {
    const m = M.get(body.matchId);
    if (!m) return { err: 'бой не найден' };
    const side = M.playerByToken(m, body.token);
    if (!side) return { err: 'нет доступа' };
    return M.applyAction(m, side, body.seq, body.act);
  },
};

setInterval(() => { M.sweep(); L.sweep(); A.sweep(); }, 30 * 1000).unref();

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
    const handler = authApi[name] || lobbyApi[name] || deckApi[name] || matchApi[name] || api[name];
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
