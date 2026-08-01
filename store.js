'use strict';
/*
  Хранилище игроков: коллекция карт и колоды.

  Зачем на сервере: пока колода приходит от клиента, он может прислать любую —
  сервер проверит только размер и лимит копий, но не то, есть ли эти карты
  у игрока. Здесь колода лежит на сервере, и в бой уходит серверная копия
  (PROJECT.md, раздел 14).

  Хранится в JSON-файле рядом с кодом. Для прототипа этого хватает; на боевом
  стенде это место заменит база — обращения к данным собраны в этом файле,
  трогать придётся только его. Внимание: на Railway диск не переживает
  передеплой, так что там файл — временное решение.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RULES = require('./proto/rules.js');
const { CARDS, CARD_KEYS, STARTER_DECK } = require('./proto/cards.js');

const FILE = path.join(__dirname, 'data', 'players.json');
const MAX_DECKS = 20;

/* Что игрок получает при первом входе.
   'all' — весь набор: сейчас карт из QR ещё нет, и ограничивать нечем.
   'starter' — только стартовая колода; переключить сюда, когда заработает
   сканирование карт (PROJECT.md, раздел 9, пункт 4). */
const START_COLLECTION = 'all';

let players = load();
let dirty = false;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return {}; }
}
function save() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(players));
  } catch (e) { /* не смогли записать — данные останутся в памяти */ }
}
setInterval(save, 5000).unref();
process.on('exit', save);

/* ---------- игрок ---------- */
function startCollection() {
  const col = {};
  if (START_COLLECTION === 'all') {
    for (const k of CARD_KEYS) col[k] = RULES.MAX_COPIES;
  } else {
    for (const k of STARTER_DECK) col[k] = Math.min(RULES.MAX_COPIES, (col[k] || 0) + 1);
  }
  return col;
}

function getPlayer(id) {
  id = String(id);
  let p = players[id];
  if (!p) {
    p = players[id] = {
      id, name: '', collection: startCollection(),
      decks: [{ id: 'starter', name: 'Стартовая колода', cards: STARTER_DECK.slice(), starter: true }],
      wins: 0, losses: 0, born: Date.now(),
    };
    dirty = true;
  }
  return p;
}

function setName(id, name) {
  const p = getPlayer(id);
  const n = String(name || '').slice(0, 24);
  if (n && n !== p.name) { p.name = n; dirty = true; }
  return p;
}

/* ---------- коллекция ---------- */
// карта из QR: одноразовая привязка делается выше, тут просто прибавка
function addCard(id, key) {
  if (!CARDS[key]) return { err: 'неизвестная карта' };
  const p = getPlayer(id);
  p.collection[key] = (p.collection[key] || 0) + 1;
  dirty = true;
  return { ok: true, have: p.collection[key] };
}

/* ---------- колоды ----------
   Проверка строже, чем у matches.validateDeck: там только размер и лимит копий,
   здесь ещё и наличие карт в коллекции игрока. */
function checkDeck(p, cards) {
  const base = RULES.MAX_COPIES;
  if (!Array.isArray(cards)) return 'колода не передана';
  if (cards.length !== RULES.DECK_SIZE) return `в колоде должно быть ${RULES.DECK_SIZE} карт, а не ${cards.length}`;
  const used = {};
  for (const k of cards) {
    if (!CARDS[k]) return `неизвестная карта: ${k}`;
    used[k] = (used[k] || 0) + 1;
    if (used[k] > base) return `больше ${base} копий карты «${CARDS[k].title}»`;
    if (used[k] > (p.collection[k] || 0)) return `карты «${CARDS[k].title}» у вас меньше`;
  }
  return null;
}

function listDecks(id) {
  const p = getPlayer(id);
  return { decks: p.decks.map(d => ({ id: d.id, name: d.name, cards: d.cards.slice(), starter: !!d.starter })),
           collection: p.collection, wins: p.wins, losses: p.losses };
}

function saveDeck(id, deck) {
  const p = getPlayer(id);
  const bad = checkDeck(p, deck && deck.cards);
  if (bad) return { err: bad };
  const name = String((deck.name || '').trim() || 'Колода').slice(0, 24);

  let d = deck.id ? p.decks.find(x => x.id === deck.id) : null;
  if (d) {
    d.name = name;
    d.cards = deck.cards.slice();
  } else {
    if (p.decks.length >= MAX_DECKS) return { err: `больше ${MAX_DECKS} колод не бывает` };
    d = { id: crypto.randomBytes(6).toString('hex'), name, cards: deck.cards.slice() };
    p.decks.push(d);
  }
  dirty = true;
  return { deck: { id: d.id, name: d.name, cards: d.cards.slice(), starter: !!d.starter } };
}

function delDeck(id, deckId) {
  const p = getPlayer(id);
  const i = p.decks.findIndex(d => d.id === deckId);
  if (i < 0) return { err: 'колода не найдена' };
  if (p.decks[i].starter) return { err: 'стартовую колоду удалить нельзя' };
  p.decks.splice(i, 1);
  dirty = true;
  return { ok: true };
}

// состав колоды для боя: берётся ТОЛЬКО отсюда, не от клиента
function deckCards(id, deckId) {
  const p = getPlayer(id);
  const d = p.decks.find(x => x.id === deckId);
  if (!d) return null;
  return checkDeck(p, d.cards) ? null : d.cards.slice();
}

function addResult(id, win) {
  const p = getPlayer(id);
  if (win) p.wins++; else p.losses++;
  dirty = true;
  return p;
}

module.exports = {
  MAX_DECKS, START_COLLECTION, FILE,
  getPlayer, setName, addCard, listDecks, saveDeck, delDeck, deckCards, checkDeck, addResult,
  save,
  _reset() { players = {}; dirty = true; },
};
