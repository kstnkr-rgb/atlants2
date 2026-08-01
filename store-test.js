'use strict';
// Проверки личности и серверного хранилища: подпись токена от МП, сессии,
// коллекция, колоды и то, что в бой уходит серверный состав колоды.
const path = require('path');
process.env.ATL_SECRET = process.env.ATL_SECRET || 'секрет-для-теста';

const A = require('./auth.js');
const store = require('./store.js');
const L = require('./lobby.js');
const M = require('./matches.js');
const RULES = require('./proto/rules.js');
const { CARD_KEYS, STARTER_DECK } = require('./proto/cards.js');

let fails = 0;
const check = (n, c, e = '') => {
  console.log((c ? '  ok   - ' : 'FAIL   - ') + n + (c ? '' : ' :: ' + e));
  if (!c) fails++;
};
const deck = () => {
  const o = [];
  for (let i = 0; o.length < RULES.DECK_SIZE; i++) { const k = CARD_KEYS[i % CARD_KEYS.length]; o.push(k, k); }
  return o.slice(0, RULES.DECK_SIZE);
};

store._reset();
L._reset();

/* ---------- подпись личности ---------- */
check('сервер видит секрет', !!A._secret() && A.DEV === false);

const good = A.signAs('kd-100', 'Аня');
const s1 = A.openSession({ token: good });
check('подписанный токен принят', !!s1.session && s1.playerId === 'kd-100', JSON.stringify(s1));
check('имя пришло из токена', s1.name === 'Аня', s1.name);

check('без токена не пускает', !!A.openSession({ id: 'kd-100' }).err);
check('мусор вместо токена не проходит', !!A.openSession({ token: 'мусор' }).err);
check('подделанная подпись не проходит',
  !!A.openSession({ token: good.split('.')[0] + '.' + 'a'.repeat(43) }).err);

// подмена содержимого при сохранённой чужой подписи
const other = A.signAs('kd-999', 'Чужой');
check('чужая подпись к своим данным не подходит',
  !!A.openSession({ token: good.split('.')[0] + '.' + other.split('.')[1] }).err);

const stale = A.signAs('kd-100', 'Аня', -1000);   // истёк секунду назад
check('просроченный токен не принят', !!A.openSession({ token: stale }).err);

check('сессия узнаёт игрока', A.whoIs(s1.session).playerId === 'kd-100');
check('чужая сессия не узнаётся', A.whoIs('нет такой') === null);

/* ---------- коллекция и колоды ---------- */
const P = 'kd-100';
const l0 = store.listDecks(P);
check('у нового игрока есть стартовая колода', l0.decks.length === 1 && l0.decks[0].starter);
check('стартовая колода того же состава', l0.decks[0].cards.join() === STARTER_DECK.join());
check('коллекция не пуста', Object.keys(l0.collection).length > 0);

const saved = store.saveDeck(P, { name: 'Моя', cards: deck() });
check('колода сохранена', !!saved.deck && !!saved.deck.id, JSON.stringify(saved));
check('колод стало две', store.listDecks(P).decks.length === 2);

const again = store.saveDeck(P, { id: saved.deck.id, name: 'Переименована', cards: deck() });
check('колода перезаписана, а не добавлена', store.listDecks(P).decks.length === 2);
check('имя обновилось', again.deck.name === 'Переименована', again.deck && again.deck.name);

check('колода не на 20 карт отклонена', !!store.saveDeck(P, { name: 'x', cards: deck().slice(0, 19) }).err);
check('четыре копии отклонены',
  !!store.saveDeck(P, { name: 'x', cards: Array(4).fill('a1').concat(deck().slice(0, 16)) }).err);
check('несуществующая карта отклонена',
  !!store.saveDeck(P, { name: 'x', cards: ['нетакой'].concat(deck().slice(0, 19)) }).err);

// карт нет в коллекции — колода не принимается
const poor = 'kd-poor';
const pp = store.getPlayer(poor);
pp.collection = {};                       // как будто коллекция пуста
check('колода из чужих карт отклонена', !!store.saveDeck(poor, { name: 'x', cards: deck() }).err);
store.addCard(poor, CARD_KEYS[0]);
check('карта из QR попала в коллекцию', store.getPlayer(poor).collection[CARD_KEYS[0]] === 1);
check('несуществующую карту не добавить', !!store.addCard(poor, 'нетакой').err);

check('стартовую колоду удалить нельзя', !!store.delDeck(P, 'starter').err);
check('свою колоду удалить можно', !!store.delDeck(P, saved.deck.id).ok);
check('удалённой колоды нет', store.listDecks(P).decks.length === 1);
check('состав удалённой колоды не выдаётся', store.deckCards(P, saved.deck.id) === null);

/* ---------- в бой уходит серверная колода ---------- */
const A1 = 'kd-1', B1 = 'kd-2';
store.getPlayer(A1); store.getPlayer(B1);
const dA = store.saveDeck(A1, { name: 'A', cards: deck() }).deck;
const dB = store.saveDeck(B1, { name: 'B', cards: deck() }).deck;

L.hello(A1, 'Первый'); L.hello(B1, 'Второй');
L.invite(A1, B1);
const pair = L.answer(B1, true);
check('пара создана', !!pair.pairId);

check('чужой номер колоды не проходит', !!L.ready(A1, pair.pairId, dB.id).err);
check('выдуманный номер колоды не проходит', !!L.ready(A1, pair.pairId, 'нет-такой').err);
check('свой номер колоды принят', L.ready(A1, pair.pairId, dA.id).waiting === true);

const started = L.ready(B1, pair.pairId, dB.id);
check('бой создан по номерам колод', !!started.matchId, JSON.stringify(started));
const m = M.get(started.matchId);
// на первом ходу пять карт уже ушли в руку, поэтому берём руку вместе с колодой
const inMatch = [...m.S.p[0].draw, ...m.S.p[0].hand].map(c => c.key).sort().join();
check('в бой ушёл серверный состав колоды', inMatch === dA.cards.slice().sort().join(),
  inMatch.slice(0, 60));

console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nвсе проверки прошли');
process.exit(fails ? 1 : 0);
