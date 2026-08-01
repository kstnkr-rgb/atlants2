'use strict';
// Проверки лобби: присутствие, список со всеми включая себя, вызовы,
// отказы, согласование колод и рождение боя.
const L = require('./lobby.js');
const M = require('./matches.js');
const RULES = require('./proto/rules.js');
const { CARD_KEYS } = require('./proto/cards.js');

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

/* ---------- присутствие ---------- */
L._reset();
L.hello('a', 'Аня');
L.hello('b', 'Боря');
let sa = L.snapshot('a');
check('в списке двое', sa.players.length === 2, String(sa.players.length));
check('себя тоже видно', sa.players.some(p => p.me && p.id === 'a'));
check('соперник помечен как не-я', sa.players.some(p => !p.me && p.id === 'b'));
check('все свободны', sa.players.every(p => !p.busy));
check('посторонний снимка не получает', !!L.snapshot('нет такого').err);

// молчание дольше срока — выпадение из списка
L.players.get('b').seen = Date.now() - L.PRESENCE_MS - 1;
sa = L.snapshot('a');
check('пропавший убран из списка', sa.players.length === 1, String(sa.players.length));
L.hello('b', 'Боря');
check('вернувшийся снова в списке', L.snapshot('a').players.length === 2);

/* ---------- вызовы ---------- */
check('вызвать себя нельзя', !!L.invite('a', 'a').err);
check('вызвать отсутствующего нельзя', !!L.invite('a', 'нет').err);
check('вызов ушёл', !!L.invite('a', 'b').ok);

let sb = L.snapshot('b');
check('вызванный видит запрос', sb.invite && sb.invite.from === 'a', JSON.stringify(sb.invite));
check('вызванный видит имя', sb.invite.name === 'Аня', sb.invite && sb.invite.name);
sa = L.snapshot('a');
check('вызвавший видит ожидание', sa.outgoing && sa.outgoing.to === 'b', JSON.stringify(sa.outgoing));

L.hello('c', 'Вова');
check('второй вызов тому же отклоняется', !!L.invite('c', 'b').err);

/* ---------- отказ ---------- */
check('отказ принят', !!L.answer('b', false).ok);
check('вызвавшему сообщили об отказе', L.snapshot('a').rejected === true);
check('сообщение об отказе показывается один раз', L.snapshot('a').rejected === false);
check('после отказа запроса нет', L.snapshot('b').invite === null);
check('после отказа оба свободны', L.snapshot('a').players.every(p => !p.busy));

/* ---------- согласие ---------- */
L.invite('a', 'b');
const ans = L.answer('b', true);
check('согласие рождает пару', !!ans.pairId, JSON.stringify(ans));
sa = L.snapshot('a'); sb = L.snapshot('b');
check('вызвавший видит пару', !!sa.pair && sa.pair.id === ans.pairId);
check('согласившийся видит пару', !!sb.pair && sb.pair.id === ans.pairId);
check('в паре видно имя соперника', sa.pair.foeName === 'Боря' && sb.pair.foeName === 'Аня',
  sa.pair.foeName + '/' + sb.pair.foeName);
check('оба помечены занятыми', L.snapshot('c').players.filter(p => p.busy).length === 2);
check('занятого вызвать нельзя', !!L.invite('c', 'a').err);

/* ---------- выбор колоды ---------- */
check('кривая колода отклоняется', !!L.ready('a', ans.pairId, ['a1']).err);
const r1 = L.ready('a', ans.pairId, deck());
check('первый готов — ждём второго', r1.waiting === true, JSON.stringify(r1));
check('своя готовность видна', L.snapshot('a').pair.mineReady === true);
check('чужой pairId не принимается', !!L.ready('a', 'чужой', deck()).err);

const r2 = L.ready('b', ans.pairId, deck());
check('второй готов — бой создан', !!r2.matchId && !!r2.token, JSON.stringify(r2));
sa = L.snapshot('a');
check('первый получил бой опросом', !!sa.match && sa.match.matchId === r2.matchId, JSON.stringify(sa.match));
check('токены у сторон разные', sa.match.token !== r2.token);
check('пары больше нет', L.pairs.size === 0, String(L.pairs.size));

const m = M.get(r2.matchId);
check('матч существует на сервере', !!m);
check('в матче те же игроки', m && m.players.map(p => p.id).sort().join() === 'a,b');

/* ---------- выход ---------- */
L.leave('a'); L.leave('b');
check('после выхода снова свободны', L.snapshot('a').players.every(p => !p.busy));
check('после выхода боя в снимке нет', L.snapshot('a').match === null);

/* ---------- уход соперника из пары ---------- */
L.invite('a', 'c');
const ans2 = L.answer('c', true);
check('вторая пара создана', !!ans2.pairId);
L.leave('c');
sa = L.snapshot('a');
check('брошенному сообщили', !!sa.note, sa.note);
check('брошенный вернулся в лобби', sa.pair === null);
check('брошенный снова свободен', sa.players.find(p => p.id === 'a').busy === false);

console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nвсе проверки прошли');
process.exit(fails ? 1 : 0);
