'use strict';
/*
  Клиент PvP. Грузится ПОСЛЕ основного скрипта: пользуется его экранами и отрисовкой.

  Здесь НЕ считается бой. Совсем. Клиент делает ровно две вещи:
    берёт у сервера вид состояния и рисует его;
    отправляет намерения — «сыграть карту 47», «конец хода», «взять карту».

  Всё остальное — на сервере (matches.js): он проверяет каждое действие, владеет
  случайностью и прячет чужую руку. Подробности — PROJECT.md, раздел 14.

  Вид от сервера приходит уже от лица игрока: своё в `me`, чужое в `foe`,
  ход как 'me'/'foe'. Поэтому вся существующая отрисовка (S.p[0] — «я»)
  работает без правок, надо только разложить вид в привычную форму.
*/
(function () {

// сервер тот же, что отдал страницу; ?server=https://... — если страница с githack
const qs = new URLSearchParams(location.search);
const API = (qs.get('server') || (/^https?:$/.test(location.protocol) ? location.origin : ''))
  .replace(/\/+$/, '');

const statusEl = $('pvpStatus'), findBtn = $('pvpFind');
const say = (text, bad) => {
  statusEl.textContent = text;
  statusEl.classList.toggle('bad', !!bad);
};

if (!API) {
  findBtn.disabled = true;
  say('Бой вдвоём работает только со страницы, отданной сервером игры (node relay.js)');
  return;
}

async function call(name, body) {
  const r = await fetch(`${API}/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

const POLL_MS = 500;
let matchId = null, token = null, timer = null, inFlight = false;
let seq = 0;           // номер намерения: сервер отбрасывает повторы и устаревшие
let logFrom = 0;       // сколько строк лога уже показано
let lastPlayN = 0;     // номер последней показанной карты в центре
let started = false;
let counted = false;   // итог боя засчитан в профиль один раз

// у игрока может не быть выбранной колоды — берём стартовую
function myDeck() {
  const d = deckAt(chosenMe);
  if (d && d.length === DECK_SIZE) return d.slice();
  const starter = decks.find(x => x.starter);
  if (starter && starter.cards.length === DECK_SIZE) return starter.cards.slice();
  return buildDeck();
}

// у прототипа нет учётной записи — до интеграции с «Клубом Друзей»
// хватает случайного номера, лежащего в этом же браузере
function myId() {
  let id = lsGet('atlanteans_player');
  if (!id) { id = 'p' + Math.random().toString(36).slice(2, 10); lsSet('atlanteans_player', id); }
  return id;
}

function stop(text, bad) {
  clearInterval(timer);
  timer = null;
  matchId = null; token = null; started = false;
  NET.mode = 'local';
  if (text) say(text, bad);
}

/* ---------- превращение вида сервера в привычное состояние ----------
   Отрисовка ждёт S.p[0] — «я», S.p[1] — соперник, и числа в S.cur/S.turn.
   Стопки соперника приходят числами, а рисовалка берёт .length —
   поэтому разворачиваем их в пустые массивы нужной длины. */
function toState(v) {
  const foe = Object.assign({}, v.foe);
  foe.draw = new Array(v.foe.draw).fill(0);
  foe.disc = new Array(v.foe.disc).fill(0);
  foe.exh  = new Array(v.foe.exh).fill(0);
  return {
    p: [v.me, foe],
    cur: v.cur === 'me' ? 0 : 1,
    turn: v.turn,
    winner: v.winner === null ? null : (v.winner === 'me' ? 0 : 1),
    busy: v.busy,
    counted: true,        // счёт побед ведёт сервер, локально не накручиваем
  };
}

function showLog(lines) {
  for (const l of lines) logMsg(l.text, l.cls);
}

// карта, сыгранная любой стороной, показывается в центре
async function showCenter(lp) {
  if (!lp || lp.n === lastPlayN) return;
  lastPlayN = lp.n;
  const owner = lp.mine ? S.p[0] : S.p[1];
  await showPlayed(lp.key, owner || NEUTRAL);
  await hidePlayed();
}

function apply(v) {
  if (!started) {
    started = true;
    showScreen(null);
  }
  S = toState(v);
  if (v.log && v.log.length) { showLog(v.log); logFrom = v.logNext; }
  render();
  // таймер хода вместо подписи «прототип дуэли»
  $('roomCode').textContent = v.over ? '' : `ХОД: ${v.left} с`;
  if (v.over) {
    // счёт в профиле ведётся здесь: в S стоит counted, чтобы render() не считал сам
    if (!counted) { counted = true; bumpStat(v.over.win ? 'wins' : 'losses'); }
    $('overText').textContent = v.over.win ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
    $('over').classList.add('show');
  }
  showCenter(v.lastPlay);
}

/* ---------- отправка намерений ----------
   Ответа не ждём: следующий опрос всё равно принесёт новое состояние.
   Локально только запираем руку, чтобы не отправить действие дважды. */
function send(act) {
  if (!matchId) return;
  S.busy = true;
  render();
  call('match/act', { matchId, token, seq: ++seq, act }).then(r => {
    if (r && r.err) say(r.err, true);
  }).catch(() => {});
}

async function tick() {
  if (!matchId) {                       // ещё стоим в очереди
    const r = await call('match/queue', { playerId: myId(), name: 'Игрок', deck: myDeck() });
    if (r.err) return stop(r.err, true);
    if (r.matchId) {
      matchId = r.matchId; token = r.token;
      say('соперник найден');
    }
    return;
  }
  // пока карту тянут пальцем, состояние не подменяем — иначе жест оборвётся
  if (document.querySelector('.card.dragging')) return;
  const v = await call('match/state', { matchId, token, logFrom });
  if (v.err) return stop(v.err, true);
  apply(v);
}

function loop() {
  timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try { await tick(); }
    catch (e) { say('нет связи с сервером', true); }
    finally { inFlight = false; }
  }, POLL_MS);
}

/* ---------- кнопки ---------- */
findBtn.onclick = () => {
  if (timer) return;
  NET.mode = 'net';
  NET.send = send;
  seq = 0; logFrom = 0; lastPlayN = 0; counted = false;
  say('ищем соперника…');
  loop();
};

// ушли с экрана PvP, не дождавшись соперника — опрос прекращаем
const backBtn = document.querySelector('#pvpScreen [data-back]');
if (backBtn) backBtn.addEventListener('click', () => { if (!matchId) stop(''); });

// выход из боя: сдаёмся, чтобы соперник не ждал впустую
NET.leave = () => {
  if (matchId) send({ t: 'give' });
  stop('');
};

})();
