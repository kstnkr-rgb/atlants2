// Боевой движок «Атланты PvP» — правила перенесены из Unity-клиента
// (Assets/_SPAR/_Scripts/Runtime/Battle: DamageCommand, BlockCommand,
// StrengthCommand, DexterityCommand, FighterBehaviour.ApplyDamage,
// PlayerBehaviour.RefreshStatsOnNewTurn).
//
// Ключевые правила оригинала:
//  - урон = max(0, базовый + сила атакующего); блок гасит урон первым
//  - блок = базовый + ловкость; сгорает в начале СВОЕГО следующего хода
//  - энергия восстанавливается до максимума в начале хода (не копится)
//  - сила/ловкость — постоянные баффы до конца боя
//  - карта с эффектом Disappear уходит в изгнание, а не в сброс

const DEFAULTS = {
  maxHp: 90,        // StatType.Health StatStartValue ?? 90
  maxEnergy: 3,     // StatType.Energy StatStartValue ?? 3
  handSize: 5,      // StatType.CardsHand StatStartValue ?? 5
  firstTurnHandicap: true, // домашнее правило PvP: первый ход первого игрока -1 энергия
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let uidCounter = 1;
function instantiate(card) {
  return { uid: uidCounter++, ...card };
}

function makePlayer(name, deckCards, opts) {
  return {
    name,
    hp: opts.maxHp, maxHp: opts.maxHp,
    energy: 0, maxEnergy: opts.maxEnergy,
    block: 0, strength: 0, agility: 0,
    drawPile: shuffle(deckCards.map(instantiate)),
    hand: [], discard: [], exhausted: [],
  };
}

function createBattle(nameA, nameB, deckA, deckB, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const state = {
    opts,
    players: [makePlayer(nameA, deckA, opts), makePlayer(nameB, deckB, opts)],
    current: 0,
    turnNumber: 1,
    winner: null,
    log: [],
    v: 0,
  };
  startTurn(state, true);
  return state;
}

function log(state, msg) {
  state.log.push(msg);
  if (state.log.length > 60) state.log.shift();
}

function draw(state, p, n) {
  for (let i = 0; i < n; i++) {
    if (p.drawPile.length === 0) {
      if (p.discard.length === 0) return; // карт больше нет — как в BattleCardsModel
      p.drawPile = shuffle(p.discard);
      p.discard = [];
    }
    p.hand.push(p.drawPile.pop());
  }
}

function startTurn(state, isFirstTurnOfBattle = false) {
  const p = state.players[state.current];
  p.block = 0; // RefreshStatsOnNewTurn: блок сгорает
  p.energy = p.maxEnergy;
  if (isFirstTurnOfBattle && state.opts.firstTurnHandicap) {
    p.energy = Math.max(1, p.maxEnergy - 1);
    log(state, `${p.name} ходит первым: энергия хода снижена до ${p.energy}`);
  }
  draw(state, p, state.opts.handSize - p.hand.length);
  log(state, `— Ход ${state.turnNumber}: ${p.name} —`);
}

function applyDamage(state, target, dmg) {
  // FighterBehaviour.ApplyDamage: блок первым
  if (target.block > 0) {
    if (dmg > target.block) {
      dmg -= target.block;
      target.block = 0;
      target.hp -= dmg;
      return dmg;
    }
    target.block -= dmg;
    return 0;
  }
  target.hp -= dmg;
  return dmg;
}

function resolveEffect(state, caster, opponent, card, ef) {
  const sign = (ef.effectValueSign || 'add').toLowerCase();
  const val = ef.effectValue | 0;
  const signed = sign === 'subtract' ? -val : val;
  const targetsSelf = ['caster', 'itself'].includes((ef.targetType || '').toLowerCase());
  const target = targetsSelf ? caster : opponent; // PvP: любой «враг/случайный/все» = оппонент

  switch ((ef.effectType || '').toLowerCase()) {
    case 'damage': {
      const total = Math.max(0, val + caster.strength); // CalculateDamageForEffect
      const dealt = applyDamage(state, target, total);
      log(state, `${caster.name}: «${card.title}» — ${total} урона (${dealt} по HP)`);
      break;
    }
    case 'block': {
      const total = Math.max(0, val + caster.agility); // CalculateBlockForEffect
      target.block += total;
      log(state, `${target.name}: +${total} блока («${card.title}»)`);
      break;
    }
    case 'strength':
      target.strength += signed;
      log(state, `${target.name}: сила ${signed >= 0 ? '+' : ''}${signed} («${card.title}»)`);
      break;
    case 'dexterity':
      target.agility += signed;
      log(state, `${target.name}: ловкость ${signed >= 0 ? '+' : ''}${signed} («${card.title}»)`);
      break;
    case 'drawcard':
      draw(state, caster, val);
      log(state, `${caster.name}: добор ${val} карт («${card.title}»)`);
      break;
    case 'energy':
      caster.energy = Math.max(0, caster.energy + signed);
      log(state, `${caster.name}: энергия ${signed >= 0 ? '+' : ''}${signed} («${card.title}»)`);
      break;
    case 'hp': {
      if (signed >= 0) target.hp = Math.min(target.maxHp, target.hp + signed);
      else target.hp += signed; // прямой урон в обход блока (HpCommand)
      log(state, `${target.name}: HP ${signed >= 0 ? '+' : ''}${signed} («${card.title}»)`);
      break;
    }
    case 'copycard': {
      caster.hand.push(instantiate(card));
      log(state, `${caster.name}: копия «${card.title}» в руку`);
      break;
    }
    case 'disappear':
      break; // обрабатывается при уборке карты
    default:
      log(state, `(эффект ${ef.effectType} пока не поддержан)`);
  }
}

function checkWinner(state) {
  const [a, b] = state.players;
  if (a.hp <= 0 && b.hp <= 0) state.winner = state.current; // добивший побеждает
  else if (b.hp <= 0) state.winner = 0;
  else if (a.hp <= 0) state.winner = 1;
  if (state.winner !== null) log(state, `Победа: ${state.players[state.winner].name}!`);
}

function applyAction(state, playerIdx, action) {
  if (state.winner !== null) return { ok: false, error: 'Бой окончен' };
  if (playerIdx !== state.current) return { ok: false, error: 'Сейчас не ваш ход' };
  const p = state.players[playerIdx];
  const opp = state.players[1 - playerIdx];

  if (action.type === 'play') {
    const i = p.hand.findIndex(c => c.uid === action.uid);
    if (i === -1) return { ok: false, error: 'Карты нет в руке' };
    const card = p.hand[i];
    if (card.cardEnergy > p.energy) return { ok: false, error: 'Не хватает энергии' };
    p.energy -= card.cardEnergy;
    p.hand.splice(i, 1);
    for (const ef of card.cardEffects || []) resolveEffect(state, p, opp, card, ef);
    const burns = (card.cardEffects || []).some(e => (e.effectType || '').toLowerCase() === 'disappear');
    (burns ? p.exhausted : p.discard).push(card);
    checkWinner(state);
    state.v++;
    return { ok: true };
  }

  if (action.type === 'end') {
    p.discard.push(...p.hand); // конец хода: рука в сброс, новый добор
    p.hand = [];
    state.current = 1 - state.current;
    if (state.current === 0) state.turnNumber++;
    startTurn(state);
    state.v++;
    return { ok: true };
  }

  return { ok: false, error: 'Неизвестное действие' };
}

// Вид состояния для конкретного игрока: рука противника скрыта
function viewFor(state, playerIdx) {
  const me = state.players[playerIdx];
  const opp = state.players[1 - playerIdx];
  const strip = (p, own) => ({
    name: p.name, hp: p.hp, maxHp: p.maxHp, energy: p.energy, maxEnergy: p.maxEnergy,
    block: p.block, strength: p.strength, agility: p.agility,
    drawCount: p.drawPile.length, discardCount: p.discard.length, exhaustedCount: p.exhausted.length,
    handCount: p.hand.length,
    hand: own ? p.hand : undefined,
  });
  return {
    v: state.v,
    you: playerIdx,
    yourTurn: state.current === playerIdx && state.winner === null,
    turnNumber: state.turnNumber,
    winner: state.winner,
    me: strip(me, true),
    opponent: strip(opp, false),
    log: state.log.slice(-14),
  };
}

module.exports = { createBattle, applyAction, viewFor, DEFAULTS };
