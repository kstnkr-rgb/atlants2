'use strict';
/*
  Сетевой слой боя вдвоём. Грузится ПОСЛЕ основного скрипта: пользуется его
  движком и экранами (S, render, newGame, finishTurn, playBy, deckAt, ...).

  Разделение сторон:
    хост  — считает бой своим движком, шлёт релею снимок состояния;
    гость — движок не считает вообще, рисует присланный снимок и шлёт действия.

  Ключевой приём: хост отдаёт снимок УЖЕ перевёрнутым — свои и чужие местами.
  Поэтому у гостя весь существующий рендер (S.p[0] — «я») работает без правок.

  Хост доверенный: он может подделать состояние. Для теста «поиграть с другом»
  этого достаточно, правильный серверный арбитр — отдельная задача (PROJECT.md, п. 9).
*/
(function () {

/* ---------- адрес релея ---------- */
// обычно сервер тот же, что отдал страницу; ?server=https://... нужен,
// если страницу открыли с githack, а релей живёт отдельно
const qs = new URLSearchParams(location.search);
const API = (qs.get('server') || (/^https?:$/.test(location.protocol) ? location.origin : ''))
  .replace(/\/+$/, '');

const box = $('pvpBox'), statusEl = $('pvpStatus');
const say = (text, bad) => {
  statusEl.textContent = text;
  statusEl.classList.toggle('bad', !!bad);
};

if (!API) {
  box.classList.add('off');
  say('Бой вдвоём работает только со страницы, отданной сервером игры (node relay.js)');
  return;
}

/* ---------- запросы ---------- */
async function call(name, body) {
  const r = await fetch(`${API}/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function pollOnce(params) {
  const r = await fetch(`${API}/api/poll?` + new URLSearchParams(params));
  return r.json();
}

/* ---------- состояние связи ---------- */
let code = null, tok = null, myDeck = null;
let timer = null, inFlight = false, started = false;
let ack = 0;        // хост: номер последнего разобранного действия гостя
let rev = 0;        // гость: версия последнего показанного снимка

const POLL_MS = 800;
const OFFLINE_MS = 10000;   // столько без опроса — считаем, что соперник отвалился

function stop(text) {
  clearInterval(timer);
  timer = null;
  NET.mode = 'local';
  if (text) say(text, true);
}

function beginBattle() {
  started = true;
  showScreen(null);
  $('roomCode').textContent = 'КОД ' + code;
}

// «соперник оффлайн» в шапке — иначе непонятно, почему бой замер
function showPresence(ago) {
  if (!started || ago === null || ago === undefined) return;
  $('roomCode').textContent = ago > OFFLINE_MS ? 'СОПЕРНИК ОФФЛАЙН' : 'КОД ' + code;
}

/* ---------- сторона хоста ---------- */

// в снимке для гостя чужая рука и стопки обезличены: видно только количество карт
function blind(p) {
  return Object.assign({}, p, {
    hand: p.hand.map(() => ({ uid: 0, key: null })),
    pending: [], draw: [], disc: [], exh: [],
  });
}
// снимок глазами гостя: он всегда p[0], поэтому индексы меняются местами
function flip() {
  return {
    p: [S.p[1], blind(S.p[0])],
    cur: 1 - S.cur,
    turn: S.turn,
    winner: S.winner === null ? null : 1 - S.winner,
    busy: S.busy,
    center: NET.center ? { key: NET.center.key, side: 1 - NET.center.side } : null,
  };
}

// render() зовётся часто (в том числе на каждый эффект карты), поэтому
// снимок не шлём сразу, а помечаем состояние грязным и отправляем по таймеру
let dirty = false, pushing = false;
function hostPush() { dirty = true; }
async function pushTick() {
  if (NET.mode !== 'host' || !started || !dirty || pushing) return;
  dirty = false;
  pushing = true;
  try { await call('push', { code, token: tok, snap: flip() }); }
  catch (e) { dirty = true; }          // не дошло — попробуем в следующий раз
  finally { pushing = false; }
}

// действия гостя разбираем строго по одному: розыгрыш карты асинхронный
let queue = Promise.resolve();
async function applyRemote(act) {
  if (!act) return;
  if (act.t === 'again') {
    $('over').classList.remove('show');
    newGame(lastDeck, lastFoe);
    return;
  }
  if (S.winner !== null || S.busy) return;

  if (act.t === 'play') {
    if (S.cur !== 1) return;
    const card = S.p[1].hand.find(x => x.uid === act.uid);
    if (!card) return;
    S.busy = true;
    await playBy(1, card);
    S.busy = false;
    render();
  } else if (act.t === 'take') {
    const P = S.p[1];
    const card = P.pending.find(x => x.uid === act.uid);
    if (!card) return;
    P.pending = P.pending.filter(x => x.uid !== act.uid);
    P.hand.push(card);
    logMsg(`  соперник взял новую карту «${DB[card.key].title}»`, 'foe');
    render();
  } else if (act.t === 'end') {
    if (S.cur !== 1) return;
    finishTurn(1);
  }
}

async function hostTick() {
  const r = await pollOnce({ code, token: tok, ack });
  if (r.err) return stop(r.err);

  if (!started && r.foeDeck) {
    beginBattle();
    newGame(myDeck, r.foeDeck);     // хост считает бой: своя колода против колоды гостя
  }
  if (r.acts && r.acts.length) {
    ack = r.acts[r.acts.length - 1].n;
    for (const a of r.acts) queue = queue.then(() => applyRemote(a.act)).catch(() => {});
  }
  showPresence(r.oppAgo);
}

/* ---------- сторона гостя ---------- */

// карта в центре: гость не считает бой, поэтому показывает её по снимку
let centerKey = null;
function showCenter(c) {
  const key = c ? c.key : null;
  if (key === centerKey) return;
  centerKey = key;
  playedBox.innerHTML = '';
  if (key) {
    playedBox.appendChild(buildCardEl(key, S.p[c.side] || NEUTRAL, false));
    playedBox.classList.add('show');
  } else {
    playedBox.classList.remove('show');
  }
}

function applySnap(snap) {
  if (!started) beginBattle();
  S = snap;
  if (snap.winner === null) $('over').classList.remove('show');   // после реванша убрать экран итога
  render();
  showCenter(snap.center);
}

async function guestTick() {
  const r = await pollOnce({ code, token: tok, rev });
  if (r.err) return stop(r.err);
  // пока карту тянут пальцем, рендер не трогаем — иначе жест обрывается.
  // rev не двигаем, поэтому тот же снимок придёт снова
  if (r.snap && !document.querySelector('.card.dragging')) {
    rev = r.rev;
    applySnap(r.snap);
  }
  showPresence(r.oppAgo);
}

function guestSend(act) {
  S.busy = true;      // до ответа хоста рука заблокирована, чтобы не сыграть дважды
  render();
  call('act', { code, token: tok, act }).catch(() => {});
}

/* ---------- общий цикл опроса ---------- */
function loop() {
  timer = setInterval(async () => {
    if (inFlight) return;             // связь медленнее опроса — пропускаем такт
    inFlight = true;
    try {
      await (NET.mode === 'host' ? hostTick() : guestTick());
      if (NET.mode === 'host') await pushTick();
    } catch (e) {
      say('нет связи с сервером', true);
    } finally {
      inFlight = false;
    }
  }, POLL_MS);
}

/* ---------- кнопки лобби ---------- */
const chosenDeck = () => (deckAt(chosenMe) || buildDeck()).slice();   // «случайная» тоже разворачивается в состав

$('pvpCreate').onclick = async () => {
  if (timer) return;
  myDeck = chosenDeck();
  say('создаём бой…');
  try {
    const r = await call('create', { deck: myDeck });
    if (r.err) return say(r.err, true);
    code = r.code; tok = r.token;
    NET.mode = 'host';
    NET.push = hostPush;
    say(`Код боя: ${r.code} — назовите его сопернику. Ждём…`);
    loop();
  } catch (e) {
    say('сервер не отвечает', true);
  }
};

$('pvpJoin').onclick = async () => {
  if (timer) return;
  const want = $('pvpCode').value.trim();
  if (!/^\d{4}$/.test(want)) return say('код — четыре цифры', true);
  myDeck = chosenDeck();
  say('входим…');
  try {
    const r = await call('join', { code: want, deck: myDeck });
    if (r.err) return say(r.err, true);
    code = want; tok = r.token;
    NET.mode = 'guest';
    NET.send = guestSend;
    say('вошли, ждём хозяина боя…');
    loop();
  } catch (e) {
    say('сервер не отвечает', true);
  }
};

})();
