'use strict';
/*
  Сервер матчей: здесь живёт бой и здесь ему верят.

  Клиент не считает ничего — он присылает намерения («сыграть карту 47»,
  «конец хода»), а сервер проверяет их по своему состоянию и применяет.
  Правила берутся из общего модуля proto/rules.js (PROJECT.md, раздел 14).

  HTTP тут нет: этот файл — только логика, наружу его отдаёт relay.js.
*/
const crypto = require('crypto');
const RULES = require('./proto/rules.js');
const { CARDS } = require('./proto/cards.js');

const TURN_MS   = 90 * 1000;        // столько даётся на ход
const MISS_LIMIT = 3;               // столько пропущенных ходов подряд — техническое поражение
const MATCH_TTL = 2 * 60 * 60 * 1000;
const LOG_MAX   = 300;

const matches = new Map();
const now = () => Date.now();

/* ---------- случайность ----------
   Линейный конгруэнтный генератор: дёшево и, главное, воспроизводимо.
   Зерно хранится в записи матча, наружу не отдаётся — иначе клиент вычислит
   порядок колоды. По зерну бой полностью переигрывается при разборе спора. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* ---------- проверка колоды ----------
   Колода приходит от клиента, значит ей нельзя верить: сверяем размер,
   лимит копий и что все карты вообще существуют. */
function validateDeck(cards) {
  if (!Array.isArray(cards)) return 'колода не передана';
  if (cards.length !== RULES.DECK_SIZE) return `в колоде должно быть ${RULES.DECK_SIZE} карт, а не ${cards.length}`;
  const seen = {};
  for (const k of cards) {
    if (!CARDS[k]) return `неизвестная карта: ${k}`;
    seen[k] = (seen[k] || 0) + 1;
    if (seen[k] > RULES.MAX_COPIES) return `больше ${RULES.MAX_COPIES} копий карты «${CARDS[k].title}»`;
  }
  return null;
}

/* ---------- матч ---------- */

function createMatch(a, b, deckA, deckB, seedIn) {
  const bad = validateDeck(deckA) || validateDeck(deckB);
  if (bad) return { err: bad };

  const seed = seedIn === undefined ? crypto.randomBytes(4).readUInt32BE(0) : seedIn >>> 0;
  const m = {
    id: crypto.randomBytes(8).toString('hex'),
    // по токену сервер узнаёт сторону: id игрока, присланный клиентом,
    // сам по себе не принимается никогда (PROJECT.md, раздел 14.3)
    tokens: [crypto.randomBytes(12).toString('hex'), crypto.randomBytes(12).toString('hex')],
    seed,
    rnd: seeded(seed),
    players: [a, b],                  // {id, name}
    log: [],
    moves: [],                        // все применённые действия — для разбора и переигрывания
    seq: [0, 0],                      // последний применённый номер действия каждой стороны
    missed: [0, 0],                   // пропущено ходов подряд
    seen: [now(), now()],             // когда сторона последний раз выходила на связь
    rev: 0,
    over: null,                       // {winner: 0|1, reason}
    born: now(),
    queue: Promise.resolve(),         // действия применяются строго по одному
  };
  // бой считается молча; новые карты обоим кладём над рукой — оба игрока люди
  m.fx = Object.assign({}, RULES.SILENT, {
    rnd: m.rnd,
    toPending: () => true,
    log(text, cls) {
      m.log.push({ n: m.log.length, text, cls: cls || '' });
      if (m.log.length > LOG_MAX) m.log.splice(0, m.log.length - LOG_MAX);
    },
  });

  m.S = RULES.newState(deckA, deckB, m.fx);
  m.deadline = now() + TURN_MS;
  matches.set(m.id, m);
  return { match: m };
}

const sideOf = (m, playerId) => m.players.findIndex(p => p.id === playerId);
// id игрока по токену; чужой или подделанный токен даёт null
function playerByToken(m, token) {
  const i = m.tokens.indexOf(token);
  return i < 0 ? null : m.players[i].id;
}

function finish(m, winner, reason) {
  if (m.over) return;
  m.over = { winner, reason };
  m.S.winner = winner;
  m.rev++;
  m.fx.log(`бой окончен: победил ${m.players[winner].name} (${reason})`, 'turn');
}

/* ---------- таймеры ----------
   Часы идут на сервере, клиент их только рисует. Ход не сделан вовремя —
   сервер сам его завершает; несколько пропусков подряд — техническое поражение.
   Это же закрывает уход из боя при проигрыше. */
function tick(m) {
  if (m.over || now() < m.deadline) return;
  const who = m.S.cur;
  m.missed[who]++;
  m.fx.log(`— время хода вышло, ход ${m.players[who].name} пропущен —`, 'turn');
  if (m.missed[who] >= MISS_LIMIT) {
    finish(m, 1 - who, 'соперник не отвечает');
    return;
  }
  RULES.endTurn(m.S, who, m.fx);
  m.deadline = now() + TURN_MS;
  m.rev++;
  if (m.S.winner !== null && !m.over) finish(m, m.S.winner, 'здоровье кончилось');
}

function sweep() {
  const t = now();
  for (const [id, m] of matches) if (t - m.born > MATCH_TTL) matches.delete(id);
}

/* ---------- вид состояния ----------
   Туман войны делает rules.viewFor: про себя всё, про соперника только числа
   и размеры стопок. Здесь добавляется то, что знает не бой, а матч. */
function viewFor(m, playerId, logFrom) {
  const who = sideOf(m, playerId);
  if (who < 0) return { err: 'вы не в этом бою' };
  tick(m);
  m.seen[who] = now();
  const from = Math.max(0, +logFrom || 0);
  return {
    matchId: m.id,
    rev: m.rev,
    you: who,
    foeName: m.players[1 - who].name,
    ...RULES.viewFor(m.S, who),
    // сколько секунд осталось на текущий ход
    left: m.over ? 0 : Math.max(0, Math.round((m.deadline - now()) / 1000)),
    over: m.over ? { win: m.over.winner === who, reason: m.over.reason } : null,
    // строки лога, которых у клиента ещё нет
    log: m.log.filter(l => l.n >= from),
    logNext: m.log.length ? m.log[m.log.length - 1].n + 1 : 0,
  };
}

/* ---------- применение действия ----------
   Единственное место, где меняется состояние по воле клиента.
   Всё, что не прошло проверку, отбрасывается, состояние не трогается. */
function applyAction(m, playerId, seq, act) {
  m.queue = m.queue.then(() => apply(m, playerId, seq, act)).catch(e => ({ err: String(e.message || e) }));
  return m.queue;
}

async function apply(m, playerId, seq, act) {
  const who = sideOf(m, playerId);
  if (who < 0) return { err: 'вы не в этом бою' };
  m.seen[who] = now();
  tick(m);

  if (m.over) return { err: 'бой уже окончен' };
  if (!act || typeof act.t !== 'string') return { err: 'пустое действие' };

  // номера действий возрастают: повтор и переигранный пакет отбрасываются
  const n = +seq;
  if (!Number.isFinite(n) || n <= m.seq[who]) return { skipped: true, rev: m.rev };
  m.seq[who] = n;

  if (m.S.busy) return { err: 'идёт розыгрыш карты' };
  if (m.S.cur !== who) return { err: 'сейчас не ваш ход' };

  if (act.t === 'play') {
    const card = RULES.canPlay(m.S, who, act.uid);
    if (!card) return { err: 'так сыграть нельзя' };
    m.S.busy = true;
    try {
      m.fx.log(`${m.players[who].name}: «${CARDS[card.key].title}» (${CARDS[card.key].cost} эн.)`,
               who === 0 ? 'you' : 'foe');
      RULES.spendCard(m.S, who, card);
      await RULES.resolveCard(m.S, who, card.key, m.fx);
    } finally {
      m.S.busy = false;
    }
    m.moves.push({ who, t: 'play', key: card.key, at: now() });
    m.missed[who] = 0;
    m.rev++;
    if (m.S.winner !== null) finish(m, m.S.winner, 'здоровье кончилось');
    return { ok: true, rev: m.rev };
  }

  if (act.t === 'take') {
    const card = RULES.takePending(m.S, who, act.uid);
    if (!card) return { err: 'такой карты нет среди новых' };
    m.moves.push({ who, t: 'take', key: card.key, at: now() });
    m.rev++;
    return { ok: true, rev: m.rev };
  }

  if (act.t === 'end') {
    RULES.endTurn(m.S, who, m.fx);
    m.moves.push({ who, t: 'end', at: now() });
    m.missed[who] = 0;
    m.deadline = now() + TURN_MS;
    m.rev++;
    return { ok: true, rev: m.rev };
  }

  if (act.t === 'give') {                 // сдаться
    finish(m, 1 - who, 'соперник сдался');
    return { ok: true, rev: m.rev };
  }

  return { err: 'неизвестное действие' };
}

module.exports = {
  TURN_MS, MISS_LIMIT,
  matches, seeded, validateDeck,
  createMatch, viewFor, applyAction, tick, sweep, sideOf, playerByToken, finish,
  get: id => matches.get(id),
};
