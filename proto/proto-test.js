// Headless-прогон логики прототипа: стабим DOM и играем полную партию.
const fs = require('fs');
const vm = require('vm');

const BASE = 'C:/Users/Konstantin/Documents/claude projects/atlanteans-pvp/proto/';
const html = fs.readFileSync(BASE + 'index.html', 'utf8');
const cardsJs = fs.readFileSync(BASE + 'cards.js', 'utf8').replace(/if \(typeof module[\s\S]*$/, '');
const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const script = cardsJs + '\n' + inline;

function el() {
  const e = {
    style: new Proxy({}, { get: (t, k) => t[k] ?? '', set: (t, k, v) => (t[k] = v, true) }),
    classList: { _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); } },
    dataset: {}, textContent: '', disabled: false, offsetWidth: 1, children: [],
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, addEventListener() {}, removeEventListener() {}, setPointerCapture() {},
  };
  let h = '';
  Object.defineProperty(e, 'innerHTML', {
    get: () => h, set: v => { h = v; if (v === '') e.children.length = 0; },
  });
  return e;
}

const ids = {};
const ctx = {
  document: {
    getElementById: id => (ids[id] ||= el()),
    createElement: () => el(),
    body: el(), documentElement: el(),
    addEventListener() {}, fullscreenElement: null,
  },
  matchMedia: () => ({ matches: false }),
  navigator: { standalone: false },
  screen: { orientation: null },
  addEventListener() {}, innerWidth: 1920, innerHeight: 1080,
  setTimeout: fn => setTimeout(fn, 0), clearTimeout,
  Math, Date, console, Promise, Array, Object, JSON, String, Number,
};
ctx.window = ctx;
vm.createContext(ctx);

vm.runInContext(script + `
;globalThis.__get = () => S;
;globalThis.__finish = finishTurn;
;globalThis.__play = playCard;
;globalThis.__DB = DB;
;globalThis.__DECK = DECK;
;globalThis.__desc = cardDesc;
;globalThis.__start = startTurn;
;globalThis.__resolve = resolveCard;
`, ctx);

(async () => {
  let fails = 0;
  const check = (name, cond, extra = '') => {
    console.log((cond ? '  ok   - ' : 'FAIL   - ') + name + (cond ? '' : ' :: ' + extra));
    if (!cond) fails++;
  };

  const S0 = ctx.__get();
  const all = p => [...p.draw, ...p.hand, ...p.disc, ...p.exh].map(c => c.key).sort();
  const TEMP = ['bolt','twin','thunder','aegis','winds','wrath','grace','ambrosia','insight','spark'];

  check('в базе 80 настоящих карт', Object.keys(ctx.__DB).length === 80, String(Object.keys(ctx.__DB).length));
  check('временных карт не осталось', !TEMP.some(k => k in ctx.__DB));
  check('колоды одинаковые у обоих', JSON.stringify(all(S0.p[0])) === JSON.stringify(all(S0.p[1])));
  check('в колоде 20 карт', ctx.__DECK.length === 20, String(ctx.__DECK.length));
  check('колода набрана из настоящих карт', ctx.__DECK.every(k => k in ctx.__DB));
  check('старт: 50 HP у обоих', S0.p[0].hp === 50 && S0.p[1].hp === 50);
  check('старт: 3 энергии', S0.p[0].energy === 3);
  check('старт: рука 5 карт', S0.p[0].hand.length === 5, String(S0.p[0].hand.length));

  const KINDS = ['dmg','hpFoe','hpSelf','blk','str','dex','strFoe','dexFoe',
                 'mulStr','mulDex','mulBlk','mulNrg','nrg','draw','trBlock','trNrg',
                 'copyHand','copySelf','copyDeck'];
  const bad = Object.entries(ctx.__DB).filter(([k, c]) =>
    !c.title || !c.tpl || typeof c.cost !== 'number' || !Array.isArray(c.fx) || !c.fx.length ||
    c.fx.some(f => !KINDS.includes(f.k)) ||
    (c.tpl.includes('{d}') && !c.fx.some(f => f.k === 'dmg')) ||
    (c.tpl.includes('{b}') && !c.fx.some(f => f.k === 'blk')));
  check('все карты базы корректны', bad.length === 0, bad.map(b => b[0]).join(','));

  // перенос блока
  const P = S0.p[0];
  P.block = 12; P.trBlock = 0; ctx.__start(0);
  check('блок сгорает в начале своего хода', P.block === 0, String(P.block));
  P.block = 12; P.trBlock = 1; ctx.__start(0);
  check('перенос блока: блок сохранён', P.block === 12, String(P.block));
  ctx.__start(0);
  check('перенос блока: следующий ход сгорел', P.block === 0, String(P.block));

  // перенос энергии
  P.energy = 2; P.trNrg = 0; ctx.__start(0);
  check('энергия без переноса = максимуму', P.energy === 3, String(P.energy));
  P.energy = 2; P.trNrg = 1; ctx.__start(0);
  check('перенос энергии: остаток прибавлен', P.energy === 5, String(P.energy));

  // умножение отрицательной силы/ловкости не должно углублять дебафф
  const A = S0.p[1];
  const runFx = async (idx, key) => { await ctx.__resolve(idx, key); };
  P.str = -5; P.dex = -4; P.block = 0;
  await runFx(0, 'm15');                      // «Помощь Зевса»: удваивает силу и ловкость
  check('умножение не углубляет минус по силе', P.str === -5, String(P.str));
  check('умножение не углубляет минус по ловкости', P.dex === -4, String(P.dex));
  P.str = 3; P.dex = 2;
  await runFx(0, 'm15');
  check('положительная сила удваивается', P.str === 6, String(P.str));
  check('положительная ловкость удваивается', P.dex === 4, String(P.dex));

  // урон никогда не отрицательный
  A.hp = 40; A.block = 0; P.str = -99;
  await runFx(0, 'a9');                       // «Праща Давида», 20 урона
  check('при огромном минусе силы урон = 0, а не лечение', A.hp === 40, String(A.hp));
  P.str = 0;

  // зелёная подсветка бонусов
  const dmgCard = ctx.__DB.a8, blkCard = ctx.__DB.d22;
  check('урон без силы обычный', ctx.__desc(dmgCard, { str:0, dex:0 }).includes('21'));
  check('сила подсвечивает урон', ctx.__desc(dmgCard, { str:3, dex:0 }).includes('buffed">24<'),
        ctx.__desc(dmgCard, { str:3, dex:0 }));
  check('ловкость подсвечивает блок', ctx.__desc(blkCard, { str:0, dex:4 }).includes('buffed">34<'),
        ctx.__desc(blkCard, { str:0, dex:4 }));

  // полная партия
  let turns = 0;
  while (ctx.__get().winner === null && turns < 300) {
    const S = ctx.__get();
    if (S.cur === 0 && !S.busy) {
      const p = S.p[0];
      const opts = p.hand.filter(c => ctx.__DB[c.key].cost <= p.energy);
      if (opts.length) {
        opts.sort((a, b) => ctx.__DB[b.key].cost - ctx.__DB[a.key].cost);
        await ctx.__play(opts[0]);
      } else { ctx.__finish(0); turns++; }
    }
    await new Promise(r => setTimeout(r, 1));
  }

  const S = ctx.__get();
  check('бой завершился победой', S.winner !== null, 'ходов: ' + turns);
  check('у проигравшего HP <= 0', S.p[1 - S.winner].hp <= 0, String(S.p[1 - S.winner].hp));
  check('HP не превышает максимум', S.p[0].hp <= 50 && S.p[1].hp <= 50);
  check('энергия не уходит в минус', S.p[0].energy >= 0 && S.p[1].energy >= 0);

  console.log(`\nпобедитель: ${S.p[S.winner].name}, ходов: ${S.turn}, HP ${S.p[0].hp}/${S.p[1].hp}`);
  console.log(fails ? `\n${fails} ПРОВЕРОК УПАЛО` : '\nвсе проверки прошли');
  process.exit(fails ? 1 : 0);
})();
