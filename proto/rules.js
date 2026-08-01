'use strict';
/*
  Правила боя «Атлантов» — без DOM, без анимации, без глобального состояния.

  Модуль общий для браузера и сервера (PROJECT.md, раздел 14): клиент подключает
  его тегом <script> после cards.js, сервер — через require. Правила перенесены
  из движка оригинальной Unity-игры, см. PROJECT.md раздел 4.

  Два принципа, ради которых модуль и выделен:

  1. Состояние передаётся аргументом `S`, а не берётся из глобальной переменной.
     Значит, на сервере можно одновременно считать сколько угодно матчей.

  2. Всё, что показывает бой игроку — лог, всплывающие числа, тряска, паузы —
     вынесено в объект `fx`. Сервер передаёт SILENT и считает бой мгновенно,
     браузер передаёт свой набор и рисует. Оттуда же берётся источник
     случайности `rnd`: на сервере он будет с зерном, чтобы бой можно было
     воспроизвести и чтобы клиент не мог перекрутить тасовку.
*/

// Всё внутри обёртки: в браузере это отдельный <script>, но глобальная область
// у него общая с разметкой, и без обёртки константы столкнулись бы с такими же
// именами в index.html. Наружу торчит только RULES.
var RULES = (function () {

// база карт: в браузере приходит из cards.js глобалами, в Node — через require
const RULES_DB = typeof CARDS !== 'undefined' ? CARDS : require('./cards.js').CARDS;
const RULES_KEYS = typeof CARD_KEYS !== 'undefined' ? CARD_KEYS : require('./cards.js').CARD_KEYS;

const MAX_HP = 50, MAX_NRG = 3, HAND_SIZE = 5;
const DECK_SIZE = 20;
const MAX_COPIES = 3;   // cardAddingLimit из конфига

// Заглушка представления: бой считается молча и мгновенно.
// toPending — кому новые карты класть над рукой, а не сразу в руку:
// человеку над рукой (он забирает их кликом), боту сразу в руку.
const SILENT = {
  log() {},
  popup() {},
  shake() {},
  render() {},
  sleep() { return Promise.resolve(); },
  rnd: Math.random,
  toPending(i) { return i === 0; },
};
const use = fx => fx || SILENT;

// сквозная нумерация карт: uid не повторяется в пределах процесса,
// по нему клиент называет карту, которую хочет сыграть
let uid = 1;
const nextUid = () => uid++;

const sign = v => (v > 0 ? '+' : '') + v;

function shuffle(a, rnd) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd() * (i + 1) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// колода наугад: 20 карт из набора, лимит копий тут НЕ проверяется
function buildDeck(fx) {
  const rnd = use(fx).rnd;
  return Array.from({ length: DECK_SIZE }, () => RULES_KEYS[rnd() * RULES_KEYS.length | 0]);
}

function mkPlayer(name, deckKeys, fx) {
  return {
    name, hp: MAX_HP, block: 0, str: 0, dex: 0, energy: 0,
    trBlock: 0, trNrg: 0,          // счётчики переноса блока и энергии
    debuffs: [],                   // активные дебаффы: {stat, amount, wait} — у каждого свой срок
    pending: [],                   // новые карты: ждут над рукой, берутся кликом
    draw: shuffle(deckKeys, use(fx).rnd).map(k => ({ uid: nextUid(), key: k })),
    hand: [], disc: [], exh: [],
  };
}

// новый бой: состояние + первый ход первого игрока
function newState(deckA, deckB, fx) {
  fx = use(fx);
  const S = {
    p: [mkPlayer('ZEUS', deckA, fx), mkPlayer('APHINA', deckB, fx)],
    cur: 0, turn: 1, winner: null, busy: false,
  };
  fx.log(`— новый бой, колода ${DECK_SIZE} карт —`, 'turn');
  startTurn(S, 0, fx);
  return S;
}

function drawCards(p, n, toPending, fx) {
  const rnd = use(fx).rnd;
  for (let i = 0; i < n; i++) {
    if (!p.draw.length) {
      if (!p.disc.length) return;
      p.draw = shuffle(p.disc, rnd); p.disc = [];
    }
    (toPending ? p.pending : p.hand).push(p.draw.pop());
  }
}

// правила из PlayerBehaviour.RefreshStatsOnNewTurn оригинальной игры
function startTurn(S, i, fx) {
  fx = use(fx);
  const p = S.p[i];
  let blockNote;
  if (p.trBlock > 0) { p.trBlock--; blockNote = `перенесён ${p.block} (ещё ${p.trBlock} х.)`; }
  else { blockNote = p.block ? `сгорел ${p.block}` : 'нет'; p.block = 0; }
  if (p.trNrg > 0) { p.energy += MAX_NRG; p.trNrg--; }  // энергия копится
  else p.energy = MAX_NRG;
  // каждый дебафф доживает свой срок независимо от остальных
  const staying = [];
  for (const d of p.debuffs) {
    if (d.wait > 0) { d.wait--; staying.push(d); }
    else {
      p[d.stat] += d.amount;
      fx.log(`  дебафф спал: ${d.stat === 'str' ? 'сила' : 'ловкость'} +${d.amount} → ${p[d.stat]} (${p.name})`, 'turn');
    }
  }
  p.debuffs = staying;
  const need = HAND_SIZE - p.hand.length;
  drawCards(p, need, false, fx);
  fx.log(`  ${p.name}: блок ${blockNote}, энергия ${p.energy}, добор ${need} → рука ${p.hand.length}, ` +
         `колода ${p.draw.length}, сброс ${p.disc.length}`);
}

function applyDamage(t, d) {      // блок поглощает первым
  if (t.block > 0) {
    if (d > t.block) { d -= t.block; t.block = 0; t.hp -= d; return d; }
    t.block -= d; return 0;
  }
  t.hp -= d; return d;
}

function checkWin(S) {
  if (S.p[1].hp <= 0) S.winner = 0;
  else if (S.p[0].hp <= 0) S.winner = 1;
}

function logState(p) {
  return `${p.name} HP${p.hp} бл${p.block} сил${p.str} лов${p.dex} эн${p.energy}`;
}

const FX_RU = {
  dmg: 'урон', hpFoe: 'прямой урон', hpSelf: 'здоровье', blk: 'блок',
  str: 'сила', dex: 'ловкость', strFoe: 'сила врагу', dexFoe: 'ловкость врагу',
  mulStr: 'сила ×', mulDex: 'ловкость ×', mulBlk: 'блок ×', mulNrg: 'энергия ×',
  nrg: 'энергия', draw: 'добор', trBlock: 'перенос блока', trNrg: 'перенос энергии',
  copyHand: 'копия из руки', copySelf: 'копия себя', copyDeck: 'копия в колоду',
};

// изменение силы/ловкости; нижней границы нет, значение уходит в минус
function bump(who, stat, delta, side, label, byFoe, fx) {
  fx = use(fx);
  const before = who[stat];
  who[stat] = before + delta;
  const real = who[stat] - before;
  if (real < 0) {                       // дебафф временный: снятое вернётся владельцу
    // отдельная запись со своим сроком; чужой доживает до конца хода жертвы
    who.debuffs.push({ stat, amount: -real, wait: byFoe ? 1 : 0 });
  }
  if (real !== 0) fx.popup(side, label + ' ' + sign(real), 'buff');
}

/* ---------- проверки перед розыгрышем ----------
   На сервере это единственная защита от нечестного клиента: карта должна лежать
   в руке именно этого игрока, энергии должно хватать, ход должен быть его. */

function canPlay(S, who, uidWanted) {
  if (S.winner !== null || S.cur !== who) return null;
  const card = S.p[who].hand.find(x => x.uid === uidWanted);
  if (!card) return null;
  if (RULES_DB[card.key].cost > S.p[who].energy) return null;
  return card;
}

// списать стоимость и убрать карту из руки; эффекты — отдельно, в resolveCard
function spendCard(S, who, card) {
  const p = S.p[who], c = RULES_DB[card.key];
  p.energy -= c.cost;
  p.hand = p.hand.filter(x => x.uid !== card.uid);
  (c.exhaust ? p.exh : p.disc).push(card);
}

// забрать карту из зоны новых карт в руку
function takePending(S, who, uidWanted) {
  const p = S.p[who];
  const card = p.pending.find(x => x.uid === uidWanted);
  if (!card) return null;
  p.pending = p.pending.filter(x => x.uid !== uidWanted);
  p.hand.push(card);
  return card;
}

async function resolveCard(S, actorIdx, key, fx) {
  fx = use(fx);
  const me = S.p[actorIdx], opp = S.p[1 - actorIdx], c = RULES_DB[key];
  const foe = 1 - actorIdx;
  const toPend = fx.toPending(actorIdx);
  const rnd = fx.rnd;

  for (const f of c.fx) {
    let note = '';
    switch (f.k) {
      case 'dmg': {                                  // урон через блок, +сила
        const total = Math.max(0, f.v + me.str);
        const dealt = applyDamage(opp, total);
        note = `урон ${f.v}${me.str ? ` +${me.str} силы = ${total}` : ''}` +
               ` → блок поглотил ${total - dealt}, по HP ${dealt} (${opp.name} HP ${opp.hp})`;
        fx.popup(foe, '−' + total, 'dmg'); fx.shake(foe);
        if (dealt === 0) fx.popup(foe, 'БЛОК', 'blk');
        break;
      }
      case 'hpFoe':                                  // прямой урон, минуя блок
        opp.hp += f.v;
        note = `прямой урон ${-f.v} мимо блока → ${opp.name} HP ${opp.hp}`;
        fx.popup(foe, String(f.v), 'dmg'); fx.shake(foe);
        break;
      case 'hpSelf': {
        const was = me.hp;
        me.hp = Math.min(MAX_HP, me.hp + f.v);
        note = `${f.v >= 0 ? 'лечение' : 'цена карты'} ${sign(f.v)} → HP ${was} → ${me.hp}`;
        fx.popup(actorIdx, sign(f.v), f.v >= 0 ? 'heal' : 'dmg');
        break;
      }
      case 'blk': {                                  // блок, +ловкость
        const total = Math.max(0, f.v + me.dex);
        me.block += total;
        note = `блок ${f.v}${me.dex ? ` +${me.dex} ловкости = ${total}` : ''} → всего ${me.block}`;
        fx.popup(actorIdx, '+' + total, 'blk');
        break;
      }
      // сила и ловкость не уходят в минус: ниже нуля дебафф просто не действует,
      // и во всплывающем числе показывается реально снятая величина
      case 'str':    bump(me,  'str', f.v, actorIdx, 'СИЛА', false, fx); break;
      case 'dex':    bump(me,  'dex', f.v, actorIdx, 'ЛОВКОСТЬ', false, fx); break;
      case 'strFoe': bump(opp, 'str', f.v, foe,      'СИЛА', true, fx); break;
      case 'dexFoe': bump(opp, 'dex', f.v, foe,      'ЛОВКОСТЬ', true, fx); break;

      // как в оригинале (FighterBehaviour.ChangeStrength/ChangeAgility):
      // умножение отрицательной характеристики ничего не делает,
      // иначе дебафф лавинообразно усиливал бы сам себя
      case 'mulStr':
        if (me.str > 0) { me.str *= f.v; fx.popup(actorIdx, 'СИЛА ×' + f.v, 'buff'); note = `сила ×${f.v} → ${me.str}`; }
        else note = `сила ×${f.v} не сработала (сила ${me.str})`;
        break;
      case 'mulDex':
        if (me.dex > 0) { me.dex *= f.v; fx.popup(actorIdx, 'ЛОВКОСТЬ ×' + f.v, 'buff'); note = `ловкость ×${f.v} → ${me.dex}`; }
        else note = `ловкость ×${f.v} не сработала (ловкость ${me.dex})`;
        break;
      case 'mulBlk': me.block *= f.v; fx.popup(actorIdx, 'БЛОК ×' + f.v, 'blk'); note = `блок ×${f.v} → ${me.block}`; break;
      case 'mulNrg': me.energy *= f.v; fx.popup(actorIdx, 'ЭНЕРГИЯ ×' + f.v, 'buff'); note = `энергия ×${f.v} → ${me.energy}`; break;

      case 'nrg':     me.energy += f.v; fx.popup(actorIdx, 'ЭНЕРГИЯ ' + sign(f.v), 'buff'); note = `энергия ${sign(f.v)} → ${me.energy}`; break;
      case 'draw': {
        drawCards(me, f.v, toPend, fx);
        note = `добор ${f.v} → ${toPend ? 'новые карты ' + me.pending.length : 'рука ' + me.hand.length}` +
               `, колода ${me.draw.length}, сброс ${me.disc.length}`;
        break;
      }
      // переносы НЕ суммируются: счётчик не складывается, а берётся больший из двух
      case 'trBlock': {
        const was = me.trBlock;
        me.trBlock = Math.max(was, f.v);
        fx.popup(actorIdx, 'БЛОК ПЕРЕНОС', 'blk');
        note = `перенос блока на ${f.v} х. → счётчик ${me.trBlock}` +
               (was && f.v <= was ? ' (не суммируется, уже больше)' : '');
        break;
      }
      case 'trNrg': {
        const was = me.trNrg;
        me.trNrg = Math.max(was, f.v);
        fx.popup(actorIdx, 'ЭНЕРГИЯ ПЕРЕНОС', 'buff');
        note = `перенос энергии на ${f.v} х. → счётчик ${me.trNrg}` +
               (was && f.v <= was ? ' (не суммируется, уже больше)' : '');
        break;
      }

      // копия карты из руки: в прототипе берётся случайная (выбор игроком не сделан)
      case 'copyHand':
        if (me.hand.length) {
          const src = me.hand[rnd() * me.hand.length | 0];
          (toPend ? me.pending : me.hand).push({ uid: nextUid(), key: src.key });
          note = `копия «${RULES_DB[src.key].title}» → ${toPend ? 'новые карты' : 'рука'}`;
        } else note = 'копия из руки: рука пуста';
        break;
      case 'copySelf':
        (toPend ? me.pending : me.hand).push({ uid: nextUid(), key });
        note = `копия «${c.title}» → ${toPend ? 'новые карты' : 'рука'}`;
        break;
      case 'copyDeck':
        if (me.draw.length) {
          const src = me.draw[rnd() * me.draw.length | 0];
          me.draw.splice(rnd() * (me.draw.length + 1) | 0, 0, { uid: nextUid(), key: src.key });
          note = `копия «${RULES_DB[src.key].title}» в колоду → колода ${me.draw.length}`;
        } else note = 'копия в колоду: колода пуста';
        break;
    }
    fx.log('    ' + (note || `${FX_RU[f.k] || f.k} ${sign(f.v)}`), actorIdx === 0 ? 'you' : 'foe');
    fx.render();
    await fx.sleep(340);
  }
  fx.log(`    = ${logState(me)} | ${logState(opp)}`);
  checkWin(S);
  fx.render();
  if (S.winner !== null) fx.log(`ПОБЕДА: ${S.p[S.winner].name}`, 'turn');
}

// смена хода: рука и незабранные новые карты уходят в сброс
function endTurn(S, who, fx) {
  fx = use(fx);
  const p = S.p[who];
  p.disc.push(...p.hand, ...p.pending);
  p.hand = []; p.pending = [];
  S.cur = 1 - who;
  if (S.cur === 0) S.turn++;
  fx.log(`— ход ${S.turn}: ${S.p[S.cur].name} —`, 'turn');
  startTurn(S, S.cur, fx);
}

/* ---------- скриптовый игрок ----------
   добить → защититься под угрозой → усилиться → бить */
function chooseCard(S, options, me, opp) {
  const fxOf = c => RULES_DB[c.key].fx;
  const thruBlock = c => fxOf(c).filter(f => f.k === 'dmg').reduce((s, f) => s + Math.max(0, f.v + me.str), 0);
  const direct    = c => fxOf(c).filter(f => f.k === 'hpFoe').reduce((s, f) => s - f.v, 0);
  const selfHit   = c => fxOf(c).filter(f => f.k === 'hpSelf' && f.v < 0).reduce((s, f) => s - f.v, 0);
  const kills     = c => direct(c) + Math.max(0, thruBlock(c) - opp.block) >= opp.hp;

  // множитель по неположительной характеристике бесполезен — не тратить на него ход
  const useful = c => fxOf(c).some(f =>
    f.k === 'mulStr' ? me.str > 0 :
    f.k === 'mulDex' ? me.dex > 0 :
    f.k === 'mulBlk' ? me.block > 0 :
    f.k === 'mulNrg' ? me.energy > 0 : true);

  const safe = options.filter(c => selfHit(c) < me.hp && useful(c));  // и не убить себя ценой карты
  if (!safe.length) return options.find(c => selfHit(c) < me.hp) || options[0];

  const lethal = safe.filter(kills).sort((a, b) => RULES_DB[a.key].cost - RULES_DB[b.key].cost);
  if (lethal.length) return lethal[0];

  const blocks = safe.filter(c => fxOf(c).some(f => f.k === 'blk'));
  if (me.hp < MAX_HP * 0.45 && blocks.length && me.block < 10) return blocks[0];

  const util = safe.filter(c => fxOf(c).some(f => ['draw', 'nrg', 'mulNrg', 'trNrg'].includes(f.k)));
  if (util.length) return util[0];

  if (S.turn <= 2) {
    const buffs = safe.filter(c => fxOf(c).some(f => ['str', 'dex'].includes(f.k) && f.v > 0));
    if (buffs.length) return buffs[0];
  }
  const heals = safe.filter(c => fxOf(c).some(f => f.k === 'hpSelf' && f.v > 0));
  if (me.hp < MAX_HP * 0.6 && heals.length) return heals[0];

  const atk = safe.filter(c => thruBlock(c) + direct(c) > 0)
                  .sort((a, b) => (thruBlock(b) + direct(b)) - (thruBlock(a) + direct(a)));
  if (atk.length) return atk[0];

  return blocks.length ? blocks[0] : safe[0];
}

/* ---------- вид состояния для игрока ----------
   Туман войны (PROJECT.md, раздел 14): про себя игрок знает всё, про соперника —
   только числа и размеры стопок. Содержимое чужой руки и порядок любой колоды
   в браузер не уходят. Сервер зовёт это перед отправкой состояния клиенту. */
function viewFor(S, who) {
  const me = S.p[who], op = S.p[1 - who];
  const hidden = p => ({
    name: p.name, hp: p.hp, block: p.block, str: p.str, dex: p.dex, energy: p.energy,
    trBlock: p.trBlock, trNrg: p.trNrg, debuffs: p.debuffs.map(d => ({ ...d })),
    hand: p.hand.map(() => ({ uid: 0, key: null })),   // видно только количество
    pending: p.pending.map(() => ({ uid: 0, key: null })),
    draw: p.draw.length, disc: p.disc.length, exh: p.exh.length,
  });
  return {
    me: JSON.parse(JSON.stringify(me)),
    foe: hidden(op),
    cur: S.cur === who ? 'me' : 'foe',
    turn: S.turn,
    winner: S.winner === null ? null : (S.winner === who ? 'me' : 'foe'),
    busy: S.busy,
  };
}

return {
  MAX_HP, MAX_NRG, HAND_SIZE, DECK_SIZE, MAX_COPIES,
  SILENT, sign, shuffle, buildDeck, mkPlayer, newState, drawCards, startTurn,
  applyDamage, checkWin, logState, FX_RU, bump,
  canPlay, spendCard, takePending, resolveCard, endTurn, chooseCard, viewFor,
  nextUid,
};

})();

if (typeof module !== 'undefined' && module.exports) module.exports = RULES;
