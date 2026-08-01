'use strict';
/*
  Лобби: кто сейчас в игре, кто кого вызвал, кто с кем сговорился на бой.

  Уведомлений у игры нет (PROJECT.md, раздел 14), поэтому позвать человека
  можно только пока он смотрит в лобби. Отсюда всё устройство: присутствие
  держится опросом, вызов живёт полминуты, а дальше обе стороны выбирают
  колоду и ждут друг друга.

  Путь игрока: лобби → вызов → согласие → выбор колоды → ожидание → бой.
  Ровно эти экраны нарисованы в схеме (раздел 13).
*/
const crypto = require('crypto');
const M = require('./matches.js');

const PRESENCE_MS = 15 * 1000;   // молчит дольше — пропал из списка
const INVITE_MS   = 30 * 1000;   // столько живёт вызов
const PAIR_MS     = 5 * 60 * 1000;

const players = new Map();   // id → {id, name, seen, status, inviteFrom, invitedAt, outTo, rejected, pairId, match}
const pairs   = new Map();   // pairId → {id, a, b, decks, at}

const now = () => Date.now();
const alive = p => now() - p.seen < PRESENCE_MS;

/* ---------- уборка ----------
   Разом чистим пропавших, протухшие вызовы и брошенные пары, чтобы
   лобби не заполнялось призраками. */
function sweep() {
  for (const [id, p] of players) {
    if (!alive(p)) { dropPair(id, 'соперник пропал'); players.delete(id); continue; }
    if (p.inviteFrom && now() - p.invitedAt > INVITE_MS) { p.inviteFrom = null; }
    if (p.outTo) {
      const to = players.get(p.outTo);
      if (!to || to.inviteFrom !== id) p.outTo = null;   // ответили или вызов протух
    }
  }
  for (const [id, pair] of pairs) if (now() - pair.at > PAIR_MS) pairs.delete(id);
}

function dropPair(id, why) {
  const p = players.get(id);
  if (!p || !p.pairId) return;
  const pair = pairs.get(p.pairId);
  pairs.delete(p.pairId);
  p.pairId = null;
  if (!pair) return;
  const otherId = pair.a === id ? pair.b : pair.a;
  const other = players.get(otherId);
  if (other && other.pairId === pair.id) {
    other.pairId = null;
    other.status = 'lobby';
    other.note = why;
  }
}

/* ---------- присутствие ---------- */
function hello(id, name) {
  id = String(id || '').trim();
  if (!id) return { err: 'нужен игрок' };
  let p = players.get(id);
  if (!p) {
    p = { id, name: String(name || id).slice(0, 24), seen: now(), status: 'lobby',
          inviteFrom: null, invitedAt: 0, outTo: null, rejected: false,
          pairId: null, match: null, note: '' };
    players.set(id, p);
  }
  p.seen = now();
  if (name) p.name = String(name).slice(0, 24);
  return { player: p };
}

/* ---------- что видит игрок ----------
   В списке показываются ВСЕ, включая его самого: своя строка помечена
   и без кнопки вызова (решение заказчика). */
function snapshot(id) {
  sweep();
  const me = players.get(id);
  if (!me) return { err: 'вы не в лобби' };

  const list = [...players.values()]
    .filter(alive)
    .sort((x, y) => x.name.localeCompare(y.name))
    .map(p => ({ id: p.id, name: p.name, me: p.id === id, busy: p.status !== 'lobby' }));

  const inviter = me.inviteFrom ? players.get(me.inviteFrom) : null;
  const pair = me.pairId ? pairs.get(me.pairId) : null;
  const foeId = pair ? (pair.a === id ? pair.b : pair.a) : null;
  const foe = foeId ? players.get(foeId) : null;

  const out = {
    players: list,
    invite: inviter ? { from: inviter.id, name: inviter.name } : null,
    outgoing: me.outTo && players.get(me.outTo) ? { to: me.outTo, name: players.get(me.outTo).name } : null,
    rejected: me.rejected,
    pair: pair ? { id: pair.id, foeName: foe ? foe.name : 'соперник', mineReady: !!pair.decks[id] } : null,
    match: me.match,
    note: me.note || '',
  };
  me.rejected = false;      // сообщение об отказе показывается один раз
  me.note = '';
  return out;
}

/* ---------- вызов ---------- */
function invite(fromId, toId) {
  sweep();
  const from = players.get(fromId), to = players.get(toId);
  if (!from) return { err: 'вы не в лобби' };
  if (!to || !alive(to)) return { err: 'игрок не в сети' };
  if (fromId === toId) return { err: 'нельзя вызвать самого себя' };
  if (from.status !== 'lobby') return { err: 'вы уже заняты' };
  if (to.status !== 'lobby') return { err: 'игрок уже занят' };
  if (to.inviteFrom && to.inviteFrom !== fromId) return { err: 'игроку уже пришёл вызов' };
  to.inviteFrom = fromId;
  to.invitedAt = now();
  from.outTo = toId;
  return { ok: true };
}

// ответ на вызов: да — рождается пара и оба идут выбирать колоду
function answer(id, ok) {
  sweep();
  const me = players.get(id);
  if (!me) return { err: 'вы не в лобби' };
  const fromId = me.inviteFrom;
  const from = fromId ? players.get(fromId) : null;
  me.inviteFrom = null;
  if (!from || !alive(from)) return { err: 'вызвавший ушёл' };
  from.outTo = null;

  if (!ok) { from.rejected = true; return { ok: true, declined: true }; }
  if (from.status !== 'lobby') return { err: 'вызвавший уже занят' };

  const pair = { id: crypto.randomBytes(6).toString('hex'), a: fromId, b: id, decks: {}, at: now() };
  pairs.set(pair.id, pair);
  from.pairId = pair.id; from.status = 'pair';
  me.pairId = pair.id;   me.status = 'pair';
  return { ok: true, pairId: pair.id };
}

/* ---------- выбор колоды и старт ----------
   Колода приходит от клиента и проверяется тут же; на сервере её пока не
   хранят — это шаг 5. Бой рождается, когда готовы оба. */
function ready(id, pairId, deck) {
  sweep();
  const me = players.get(id);
  if (!me) return { err: 'вы не в лобби' };
  const pair = pairs.get(pairId);
  if (!pair || me.pairId !== pairId) return { err: 'бой отменён' };
  const bad = M.validateDeck(deck);
  if (bad) return { err: bad };

  pair.decks[id] = deck;
  const otherId = pair.a === id ? pair.b : pair.a;
  if (!pair.decks[otherId]) return { waiting: true };

  const a = players.get(pair.a), b = players.get(pair.b);
  if (!a || !b) return { err: 'соперник ушёл' };
  const { match, err } = M.createMatch(
    { id: a.id, name: a.name }, { id: b.id, name: b.name },
    pair.decks[a.id], pair.decks[b.id]);
  if (err) return { err };

  a.match = { matchId: match.id, token: match.tokens[0] }; a.status = 'battle'; a.pairId = null;
  b.match = { matchId: match.id, token: match.tokens[1] }; b.status = 'battle'; b.pairId = null;
  pairs.delete(pair.id);
  return me.match;
}

// выйти из пары или из боя обратно в лобби
function leave(id) {
  const p = players.get(id);
  if (!p) return { ok: true };
  dropPair(id, 'соперник отказался');
  p.match = null;
  p.status = 'lobby';
  p.inviteFrom = null;
  p.outTo = null;
  return { ok: true };
}

module.exports = {
  PRESENCE_MS, INVITE_MS,
  players, pairs,
  hello, snapshot, invite, answer, ready, leave, sweep,
  _reset() { players.clear(); pairs.clear(); },
};
