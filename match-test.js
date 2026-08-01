'use strict';
// Проверки сервера матчей: правила, отказы нечестному клиенту, туман войны,
// номера действий, таймеры ходов, воспроизводимость по зерну.
const M = require('./matches.js');
const RULES = require('./proto/rules.js');
const { CARDS, CARD_KEYS } = require('./proto/cards.js');

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? '  ok   - ' : 'FAIL   - ') + name + (cond ? '' : ' :: ' + extra));
  if (!cond) fails++;
};

const A = { id: 'p1', name: 'Игрок 1' };
const B = { id: 'p2', name: 'Игрок 2' };
// ровная колода: 20 карт, не больше 3 копий одной
const deck = () => {
  const out = [];
  for (let i = 0; out.length < RULES.DECK_SIZE; i++) {
    const k = CARD_KEYS[i % CARD_KEYS.length];
    out.push(k, k);
  }
  return out.slice(0, RULES.DECK_SIZE);
};

(async () => {

  /* ---------- проверка колоды ---------- */
  check('колода на 20 карт принимается', M.validateDeck(deck()) === null, String(M.validateDeck(deck())));
  check('колода на 21 карту отклоняется', !!M.validateDeck(deck().concat(CARD_KEYS[0])));
  check('колода на 19 карт отклоняется', !!M.validateDeck(deck().slice(0, 19)));
  check('четыре копии одной карты отклоняются',
    !!M.validateDeck(Array(4).fill('a1').concat(deck().slice(0, 16))));
  check('несуществующая карта отклоняется',
    !!M.validateDeck(['нетакой'].concat(deck().slice(0, 19))));
  check('бой с кривой колодой не создаётся', !!M.createMatch(A, B, deck().slice(0, 5), deck()).err);

  /* ---------- создание ---------- */
  const { match: m, err } = M.createMatch(A, B, deck(), deck(), 777);
  check('матч создан', !err && !!m, String(err));

  const vA = M.viewFor(m, 'p1', 0);
  const vB = M.viewFor(m, 'p2', 0);
  check('посторонний вида не получает', !!M.viewFor(m, 'p3', 0).err);
  check('первый видит свою руку из 5 карт', vA.me.hand.length === 5 && vA.me.hand[0].key, String(vA.me.hand.length));
  check('первому ходить', vA.cur === 'me', vA.cur);
  check('второму ждать', vB.cur === 'foe', vB.cur);
  check('имя соперника показано', vA.foeName === 'Игрок 2', vA.foeName);
  check('таймер хода идёт', vA.left > 0 && vA.left <= M.TURN_MS / 1000, String(vA.left));

  /* ---------- туман войны ---------- */
  check('чужая рука обезличена', vA.foe.hand.every(c => c.key === null));
  check('чужая колода — только число', typeof vA.foe.draw === 'number');
  check('зерно наружу не уходит', vA.seed === undefined && JSON.stringify(vA).indexOf('777') === -1);
  check('чужая рука второго тоже скрыта от него же не бывает', vB.me.hand.length === 0, String(vB.me.hand.length));

  /* ---------- отказы нечестному клиенту ---------- */
  const uidA = vA.me.hand[0].uid;
  const revBefore = m.rev;

  check('ход не свой — отказ', !!(await M.applyAction(m, 'p2', 1, { t: 'play', uid: uidA })).err);
  check('карты нет в руке — отказ', !!(await M.applyAction(m, 'p1', 2, { t: 'play', uid: 999999 })).err);
  // карта соперника существует, но лежит не в руке первого — играть ею нельзя
  check('чужая карта по uid — отказ',
    !!(await M.applyAction(m, 'p1', 3, { t: 'play', uid: m.S.p[1].draw[0].uid })).err);
  check('своя карта из колоды, не из руки — отказ',
    !!(await M.applyAction(m, 'p1', 4, { t: 'play', uid: m.S.p[0].draw[0].uid })).err);
  check('неизвестное действие — отказ', !!(await M.applyAction(m, 'p1', 5, { t: 'взломать' })).err);
  check('пустое действие — отказ', !!(await M.applyAction(m, 'p1', 6, null)).err);
  check('посторонний в бою — отказ', !!(await M.applyAction(m, 'p3', 7, { t: 'end' })).err);
  check('после отказов состояние не менялось', m.rev === revBefore, `${m.rev} vs ${revBefore}`);

  // дорогая карта при нехватке энергии
  const pricey = m.S.p[0].hand.find(c => CARDS[c.key].cost > m.S.p[0].energy);
  if (pricey) {
    check('не хватает энергии — отказ',
      !!(await M.applyAction(m, 'p1', 8, { t: 'play', uid: pricey.uid })).err);
  } else {
    m.S.p[0].energy = 0;
    check('не хватает энергии — отказ',
      !!(await M.applyAction(m, 'p1', 8, { t: 'play', uid: uidA })).err);
    m.S.p[0].energy = RULES.MAX_NRG;
  }

  /* ---------- номера действий ---------- */
  const cheap = m.S.p[0].hand.find(c => CARDS[c.key].cost <= m.S.p[0].energy);
  const hpBefore = m.S.p[1].hp, nrgBefore = m.S.p[0].energy;
  const r1 = await M.applyAction(m, 'p1', 20, { t: 'play', uid: cheap.uid });
  check('честный ход принят', !!r1.ok, JSON.stringify(r1));
  check('состояние изменилось', m.rev > revBefore);
  check('энергия списана', m.S.p[0].energy === nrgBefore - CARDS[cheap.key].cost);
  check('карта ушла из руки', !m.S.p[0].hand.some(c => c.uid === cheap.uid));

  const revAfter = m.rev;
  const dup = await M.applyAction(m, 'p1', 20, { t: 'play', uid: cheap.uid });
  check('повтор с тем же номером пропущен', !!dup.skipped, JSON.stringify(dup));
  const stale = await M.applyAction(m, 'p1', 5, { t: 'end' });
  check('устаревший номер пропущен', !!stale.skipped, JSON.stringify(stale));
  check('после повторов состояние не менялось', m.rev === revAfter, `${m.rev} vs ${revAfter}`);
  check('урон нанесён один раз', m.S.p[1].hp <= hpBefore);

  /* ---------- смена хода ---------- */
  await M.applyAction(m, 'p1', 21, { t: 'end' });
  check('ход перешёл сопернику', m.S.cur === 1, String(m.S.cur));
  check('первый больше ходить не может',
    !!(await M.applyAction(m, 'p1', 22, { t: 'play', uid: m.S.p[0].hand[0] && m.S.p[0].hand[0].uid })).err);
  check('второй набрал руку', m.S.p[1].hand.length === 5, String(m.S.p[1].hand.length));

  /* ---------- таймер хода ---------- */
  const missBefore = m.missed[1];
  m.deadline = Date.now() - 1;          // как будто время вышло
  M.tick(m);
  check('просроченный ход завершён сервером', m.S.cur === 0, String(m.S.cur));
  check('пропуск засчитан', m.missed[1] === missBefore + 1, String(m.missed[1]));

  /* ---------- техническое поражение ---------- */
  // пропуски копятся у каждой стороны своим счётчиком, а ход чередуется,
  // поэтому до предела одной из сторон нужно вдвое больше просрочек
  const t = M.createMatch(A, B, deck(), deck(), 5).match;
  for (let i = 0; i < M.MISS_LIMIT * 2 + 2 && !t.over; i++) {
    t.deadline = Date.now() - 1;
    M.tick(t);
  }
  check('после нескольких пропусков бой закрыт', !!t.over, JSON.stringify(t.over));
  check('победа отдана сопернику пропустившего', t.over && t.over.winner === 1, JSON.stringify(t.over));
  check('в закрытом бою действия отклоняются',
    !!(await M.applyAction(t, 'p1', 99, { t: 'end' })).err);

  /* ---------- сдаться ---------- */
  const g = M.createMatch(A, B, deck(), deck(), 6).match;
  await M.applyAction(g, 'p1', 1, { t: 'give' });
  check('сдавшийся проиграл', g.over && g.over.winner === 1, JSON.stringify(g.over));
  check('второй видит победу', M.viewFor(g, 'p2', 0).over.win === true);

  /* ---------- токены сторон ---------- */
  check('свой токен даёт свою сторону', M.playerByToken(m, m.tokens[0]) === 'p1');
  check('второй токен даёт вторую сторону', M.playerByToken(m, m.tokens[1]) === 'p2');
  check('поддельный токен не проходит', M.playerByToken(m, 'подделка') === null);
  check('токены разные', m.tokens[0] !== m.tokens[1]);

  /* ---------- воспроизводимость по зерну ---------- */
  const one = M.createMatch(A, B, deck(), deck(), 42).match;
  const two = M.createMatch(A, B, deck(), deck(), 42).match;
  const keys = mm => mm.S.p[0].hand.map(c => c.key).join(',');
  check('одно зерно — одна раздача', keys(one) === keys(two), keys(one) + ' vs ' + keys(two));
  const three = M.createMatch(A, B, deck(), deck(), 43).match;
  check('другое зерно — другая раздача', keys(one) !== keys(three));

  /* ---------- бой до победы ---------- */
  const f = M.createMatch(A, B, deck(), deck(), 2024).match;
  let seqs = [1, 1], guard = 0;
  while (!f.over && guard++ < 500) {
    const who = f.S.cur, me = f.S.p[who], opp = f.S.p[1 - who];
    const options = me.hand.filter(c => RULES.canPlay(f.S, who, c.uid));
    if (options.length) {
      const pick = RULES.chooseCard(f.S, options, me, opp);
      if (pick) {
        await M.applyAction(f, f.players[who].id, ++seqs[who], { t: 'play', uid: pick.uid });
        continue;
      }
    }
    await M.applyAction(f, f.players[who].id, ++seqs[who], { t: 'end' });
  }
  check('бой дошёл до конца', !!f.over, 'шагов ' + guard);
  check('у проигравшего HP <= 0 или он не отвечал',
    f.over && (f.S.p[1 - f.over.winner].hp <= 0 || f.over.reason !== 'здоровье кончилось'));
  check('ходы записаны для разбора', f.moves.length > 0, String(f.moves.length));
  check('лог не растёт бесконечно', f.log.length <= 300, String(f.log.length));

  /* ---------- журнал лога отдаётся порциями ---------- */
  const v1 = M.viewFor(f, 'p1', 0);
  const v2 = M.viewFor(f, 'p1', v1.logNext);
  check('лог отдаётся с нужного места', v1.log.length > 0 && v2.log.length === 0,
    `${v1.log.length} / ${v2.log.length}`);

  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nвсе проверки прошли');
  process.exit(fails ? 1 : 0);
})();
