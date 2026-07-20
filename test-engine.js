// Автотест движка: проверяет перенесённые из Unity правила боя.
const assert = require('assert');
const fs = require('fs');
const { createBattle, applyAction } = require('./engine');

const cardsData = JSON.parse(fs.readFileSync('./cards.json', 'utf8'));
const byId = Object.fromEntries(cardsData.cards.map(c => [c.cardID, c]));
const deck = cardsData.starterDeck.map(id => byId[id]);

function fresh(opts) {
  return createBattle('A', 'B', deck, deck, { firstTurnHandicap: false, ...opts });
}

function giveHand(state, playerIdx, cardIds) {
  const p = state.players[playerIdx];
  p.hand = cardIds.map((id, i) => ({ uid: 9000 + i + playerIdx * 100, ...byId[id] }));
}

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}: ${e.message}`); process.exitCode = 1; }
}

t('старт: 90 HP, 3 энергии, рука 5 карт', () => {
  const s = fresh();
  assert.equal(s.players[0].hp, 90);
  assert.equal(s.players[0].energy, 3);
  assert.equal(s.players[0].hand.length, 5);
  assert.equal(s.players[1].hand.length, 0); // второй доберёт на своём ходу
});

t('гандикап первого хода: энергия 2', () => {
  const s = fresh({ firstTurnHandicap: true });
  assert.equal(s.players[0].energy, 2);
});

t('урон уходит в HP без блока', () => {
  const s = fresh();
  giveHand(s, 0, ['demo_attack1']); // 6 урона
  assert.ok(applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid }).ok);
  assert.equal(s.players[1].hp, 84);
  assert.equal(s.players[0].energy, 2);
});

t('блок гасит урон первым, остаток в HP (FighterBehaviour.ApplyDamage)', () => {
  const s = fresh();
  s.players[1].block = 4;
  giveHand(s, 0, ['demo_attack1']); // 6 урона: 4 в блок, 2 в HP
  applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(s.players[1].block, 0);
  assert.equal(s.players[1].hp, 88);
});

t('блок полностью держит слабый удар', () => {
  const s = fresh();
  s.players[1].block = 10;
  giveHand(s, 0, ['demo_attack1']); // 6 урона
  applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(s.players[1].block, 4);
  assert.equal(s.players[1].hp, 90);
});

t('сила добавляется к каждому эффекту урона (CalculateDamageForEffect)', () => {
  const s = fresh();
  s.players[0].strength = 2;
  giveHand(s, 0, ['demo_attack3']); // 3+3 урона -> (3+2)+(3+2)=10
  applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(s.players[1].hp, 80);
});

t('ловкость добавляется к блоку (CalculateBlockForEffect)', () => {
  const s = fresh();
  s.players[0].agility = 3;
  giveHand(s, 0, ['demo_defend1']); // 5 блока + 3 = 8
  applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(s.players[0].block, 8);
});

t('нельзя сыграть карту дороже текущей энергии', () => {
  const s = fresh();
  s.players[0].energy = 1;
  giveHand(s, 0, ['demo_attack4']); // стоимость 3
  const r = applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(r.ok, false);
  assert.equal(s.players[1].hp, 90);
});

t('нельзя ходить вне очереди', () => {
  const s = fresh();
  giveHand(s, 1, ['demo_attack1']);
  const r = applyAction(s, 1, { type: 'play', uid: s.players[1].hand[0].uid });
  assert.equal(r.ok, false);
});

t('конец хода: рука в сброс, ход к противнику, добор 5, энергия до максимума', () => {
  const s = fresh();
  applyAction(s, 0, { type: 'end' });
  assert.equal(s.current, 1);
  assert.equal(s.players[0].hand.length, 0);
  assert.ok(s.players[0].discard.length >= 5);
  assert.equal(s.players[1].hand.length, 5);
  assert.equal(s.players[1].energy, 3);
});

t('блок сгорает в начале своего следующего хода (RefreshStatsOnNewTurn)', () => {
  const s = fresh();
  giveHand(s, 0, ['demo_defend1']);
  applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(s.players[0].block, 5);
  applyAction(s, 0, { type: 'end' });
  assert.equal(s.players[0].block, 5); // на чужом ходу блок стоит
  applyAction(s, 1, { type: 'end' });
  assert.equal(s.players[0].block, 0); // на своём ходу сгорел
});

t('Disappear: карта уходит в изгнание, не в сброс', () => {
  const s = fresh();
  giveHand(s, 0, ['demo_attack4']);
  applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(s.players[0].exhausted.length, 1);
  assert.ok(!s.players[0].discard.find(c => c.cardID === 'demo_attack4'));
});

t('DrawCard добирает карты', () => {
  const s = fresh();
  const before = s.players[0].hand.length;
  giveHand(s, 0, ['demo_magic2']); // добор 2
  applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(s.players[0].hand.length, 2); // рука была из 1 подменённой карты: -1 сыграна, +2 добор
});

t('Hp лечит не выше максимума', () => {
  const s = fresh();
  s.players[0].hp = 88;
  giveHand(s, 0, ['demo_magic3']); // +6 HP
  applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(s.players[0].hp, 90);
});

t('Energy даёт энергию', () => {
  const s = fresh();
  giveHand(s, 0, ['demo_magic4']); // 0 стоимость, +2 энергии
  applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(s.players[0].energy, 5);
});

t('победа при HP <= 0', () => {
  const s = fresh();
  s.players[1].hp = 5;
  giveHand(s, 0, ['demo_attack1']); // 6 урона
  applyAction(s, 0, { type: 'play', uid: s.players[0].hand[0].uid });
  assert.equal(s.winner, 0);
  const r = applyAction(s, 1, { type: 'end' });
  assert.equal(r.ok, false); // после победы действия закрыты
});

t('пересборка колоды из сброса при пустой колоде', () => {
  const s = fresh();
  const p = s.players[0];
  p.discard = p.drawPile.splice(0, p.drawPile.length); // всё в сброс
  giveHand(s, 0, ['demo_magic2']);
  applyAction(s, 0, { type: 'play', uid: p.hand[0].uid });
  assert.equal(p.hand.length, 2); // добор сработал через перетасовку сброса
});

console.log(`\n${passed} тестов прошло${process.exitCode ? ', ЕСТЬ ПАДЕНИЯ' : ''}`);
