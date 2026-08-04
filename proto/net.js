'use strict';
/*
  Клиент PvP: лобби и бой. Грузится ПОСЛЕ основного скрипта.

  Здесь НЕ считается бой. Совсем. Клиент берёт у сервера вид состояния,
  рисует его и отправляет намерения. Проверяет всё сервер (matches.js),
  он же владеет случайностью и прячет чужую руку — PROJECT.md, раздел 14.

  Путь игрока: лобби → вызов по id → согласие → выбор колоды → ожидание → бой.
  Кодов комнат нет. Уведомлений у игры нет, поэтому позвать человека можно,
  только пока он смотрит в лобби.
*/
(function () {

// сервер тот же, что отдал страницу; ?server=https://... — если страница с githack
const qs = new URLSearchParams(location.search);
const API = (qs.get('server') || (/^https?:$/.test(location.protocol) ? location.origin : ''))
  .replace(/\/+$/, '');

const listEl = $('pvpList'), statusEl = $('pvpStatus'), deckStatusEl = $('pvpDeckStatus');
const say = (text, bad) => {
  statusEl.textContent = text;
  statusEl.classList.toggle('bad', !!bad);
};

if (!API) {
  listEl.innerHTML = '<div class="empty">Бой вдвоём работает только со страницы,<br>отданной сервером игры (node relay.js)</div>';
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

const LOBBY_MS = 1000, BATTLE_MS = 500;

let phase = 'off';        // 'off' | 'lobby' | 'pair' | 'battle'
let timer = null, inFlight = false;
let pairId = null, matchId = null, token = null;
let seq = 0, logFrom = 0, lastPlayN = 0, counted = false, entered = false;
let askedFrom = null;     // чей запрос сейчас показан в окне
let session = null;       // токен сессии: им подписан каждый запрос

/* ---------- кто я ----------
   В продукте id приходит из «Клуба Друзей»: приложение открывает WebView
   с подписанным токеном в ?u=. Сервер проверяет подпись и выдаёт сессию.
   Без токена сервер пускает только в режиме разработки (без ATL_SECRET),
   и тогда игрок опознаётся случайным номером из этого же браузера. */
function devId() {
  let id = lsGet('atlanteans_player');
  if (!id) { id = 'p' + Math.random().toString(36).slice(2, 8); lsSet('atlanteans_player', id); }
  return id;
}
function myName() {
  const p = (() => { try { return JSON.parse(lsGet('atlanteans_profile')) || {}; } catch (e) { return {}; } })();
  return (p.name || '').trim() || 'Игрок ' + devId().slice(1, 4);
}

/* ---------- сессия и колоды на сервере ----------
   Пока сессии нет, игра работает как раньше: колоды в localStorage, бой с ботом.
   С сессией источник правды — сервер: он же сверяет колоду с коллекцией. */
const UPLOADED = 'atlanteans_uploaded';

async function pullDecks() {
  const r = await call('decks', { session });
  if (r.err) return;
  decks = r.decks;                       // у серверных колод есть id
  chosenMe = Math.min(chosenMe, decks.length - 1);
  renderStart(); renderDecks();
  if ($('pvpDeckList').innerHTML) renderPvpDecks();
}

// один раз переносим колоды, собранные до появления сессии
async function pushLocalDecks() {
  if (lsGet(UPLOADED)) return;
  lsSet(UPLOADED, '1');
  const mine = decks.filter(d => !d.starter && !d.id && d.cards && d.cards.length === DECK_SIZE);
  for (const d of mine) await call('decks/save', { session, deck: { name: d.name, cards: d.cards } });
}

async function openSession() {
  const u = qs.get('u');                 // подписанный токен от «Клуба Друзей»
  const body = u ? { token: u } : { id: devId(), name: myName() };
  const r = await call('session', body);
  if (r.err) return;                     // сервера нет или подпись не сошлась — играем локально
  session = r.session;
  NET.online = true;
  NET.saveDeck = async deck => { const s = await call('decks/save', { session, deck }); if (!s.err) await pullDecks(); };
  NET.delDeck  = async id   => { const s = await call('decks/del', { session, deckId: id }); if (!s.err) await pullDecks(); };
  NET.setName  = name => { call('decks/name', { session, name }).catch(() => {}); };
  await pushLocalDecks();
  await pullDecks();
}
openSession().catch(() => {});

/* ---------- окно запроса и ожидания ---------- */
const modal = $('pmodal');
function showModal(title, text, buttons) {
  $('pmTitle').textContent = title;
  $('pmText').textContent = text;
  $('pmBtns').innerHTML = '';
  for (const [label, ghost, fn] of buttons) {
    const b = document.createElement('button');
    b.className = 'btn' + (ghost ? ' ghost' : '');
    b.textContent = label;
    b.onclick = fn;
    $('pmBtns').appendChild(b);
  }
  modal.classList.add('show');
}
const hideModal = () => { modal.classList.remove('show'); askedFrom = null; };

/* ---------- лобби ---------- */
// строка как в макете: аватар, имя со статусом под ним, кнопка вызова справа
function renderLobby(s) {
  if (!s.players.length) { listEl.innerHTML = '<div class="empty">Пусто</div>'; return; }
  listEl.innerHTML = s.players.map(p => {
    const state = p.busy ? 'в бою' : 'в сети';
    return `<div class="ss-item${p.me ? ' self' : ''}">
      <img class="lb-av" src="img/avatar.png" alt="">
      <span class="lb-who">
        <b class="ss-name">${p.name}</b>
        <i class="lb-state ${p.busy ? 'busy' : 'on'}">${state}</i>
      </span>
      ${p.me ? '<span class="ss-you">ЭТО ВЫ</span>' : ''}
      <span class="pick-cell">${
        p.me ? '' :
        p.busy ? '<button class="btn ghost" disabled style="padding:8px 22px;font-size:22px">ЗАНЯТ</button>'
               : `<button class="btn" data-call="${p.id}" style="padding:8px 22px;font-size:22px">ВЫЗВАТЬ</button>`
      }</span>
    </div>`;
  }).join('');
}
listEl.addEventListener('click', async e => {
  const b = e.target.closest('[data-call]');
  if (!b) return;
  const r = await call('invite', { session, to: b.dataset.call });
  say(r.err || 'вызов отправлен, ждём ответа', !!r.err);
});

function onLobby(s) {
  if (s.err) { say(s.err, true); return; }
  renderLobby(s);
  if (s.note) say(s.note, true);
  else if (s.rejected) say('соперник отказался', true);
  else if (s.outgoing) say(`ждём ответа: ${s.outgoing.name}`);
  else if (!askedFrom) say('');

  // пришёл вызов — показываем окно, как в схеме
  if (s.invite && askedFrom !== s.invite.from) {
    askedFrom = s.invite.from;
    showModal('ЗАПРОС НА БОЙ', `${s.invite.name} прислал вам запрос`, [
      ['ДА', false, async () => {
        hideModal();
        const r = await call('answer', { session, ok: true });
        if (r.err) say(r.err, true);
      }],
      ['ОТКЛОНИТЬ', true, async () => {
        hideModal();
        await call('answer', { session, ok: false });
      }],
    ]);
  }
  if (!s.invite && askedFrom) hideModal();

  // договорились — идём выбирать колоду
  if (s.pair && phase !== 'pair') {
    pairId = s.pair.id;
    phase = 'pair';
    hideModal();
    deckStatusEl.textContent = `соперник: ${s.pair.foeName}`;
    renderPvpDecks();
    goto('pvpDeckScreen');
  }
  if (!s.pair && phase === 'pair' && !s.match) {   // соперник ушёл
    phase = 'lobby'; pairId = null;
    hideModal();
    goto('pvpScreen');
  }
  // бой готов
  if (s.match) enterBattle(s.match);
}

/* ---------- выбор колоды перед PvP ---------- */
function renderPvpDecks() {
  $('pvpDeckList').innerHTML = decks.map((d, i) => `<div class="ss-item">
      <span class="ss-name">${d.name}</span>
      <span class="ss-info">${d.cards.length} карт</span>
      <span class="pick-cell">
        <button class="pick-side${chosenMe === i ? ' on' : ''}" data-side="me" data-pick="${i}">выбрать</button>
      </span>
    </div>`).join('');
}
$('pvpDeckList').addEventListener('click', e => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  chosenMe = +b.dataset.pick;
  renderPvpDecks();
});
$('pvpPlay').onclick = async () => {
  if (!pairId) return;
  const chosen = decks[chosenMe] || decks.find(d => d.starter) || decks[0];
  if (!chosen || !chosen.id) { deckStatusEl.textContent = 'выберите колоду'; return; }
  const r = await call('ready', { session, pairId, deckId: chosen.id });
  if (r.err) { deckStatusEl.textContent = r.err; return; }
  if (r.matchId) { enterBattle(r); return; }
  showModal('ОЖИДАНИЕ', 'Ожидаем второго игрока', [
    ['ОТМЕНА', true, async () => { hideModal(); await call('leave', { session }); phase = 'lobby'; goto('pvpScreen'); }],
  ]);
};

/* ---------- бой ----------
   Вид приходит уже от лица игрока (me / foe), поэтому вся существующая
   отрисовка работает без правок — надо только разложить его в привычную форму.
   Стопки соперника приходят числами, а рисовалка берёт .length. */
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
    counted: true,       // победы считает клиент лобби ниже, render() пусть не трогает
  };
}

function enterBattle(m) {
  if (phase === 'battle') return;
  phase = 'battle';
  matchId = m.matchId; token = m.token;
  seq = 0; logFrom = 0; lastPlayN = 0; counted = false; entered = false;
  NET.mode = 'net';
  NET.send = send;
  hideModal();
  restart(BATTLE_MS);
}

async function showCenter(lp) {
  if (!lp || lp.n === lastPlayN) return;
  lastPlayN = lp.n;
  await showPlayed(lp.key, (lp.mine ? S.p[0] : S.p[1]) || NEUTRAL);
  await hidePlayed();
}

function applyView(v) {
  if (!entered) { entered = true; showScreen(null); }
  S = toState(v);
  if (v.log && v.log.length) { for (const l of v.log) logMsg(l.text, l.cls); logFrom = v.logNext; }
  render();
  $('roomCode').textContent = v.over ? '' : `ХОД: ${v.left} с`;
  if (v.over) {
    if (!counted) { counted = true; bumpStat(v.over.win ? 'wins' : 'losses'); }
    $('overText').textContent = v.over.win ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
    $('over').classList.add('show');
  }
  showCenter(v.lastPlay);
}

/* Ответа не ждём: следующий опрос принесёт новое состояние.
   Локально только запираем руку, чтобы не отправить действие дважды. */
function send(act) {
  if (!matchId) return;
  S.busy = true;
  render();
  call('match/act', { matchId, token, seq: ++seq, act }).catch(() => {});
}

/* ---------- общий цикл ---------- */
async function tick() {
  if (phase === 'battle') {
    // пока карту тянут пальцем, состояние не подменяем — иначе жест оборвётся
    if (document.querySelector('.card.dragging')) return;
    const v = await call('match/state', { matchId, token, logFrom });
    if (v.err) { stopBattle(); return; }
    applyView(v);
    return;
  }
  onLobby(await call('lobby', { session }));
}

function restart(ms) {
  clearInterval(timer);
  timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try { await tick(); }
    catch (e) { say('нет связи с сервером', true); }
    finally { inFlight = false; }
  }, ms);
}

function stopAll() {
  clearInterval(timer);
  timer = null;
  phase = 'off';
  pairId = null; matchId = null; token = null;
  NET.mode = 'local';
  hideModal();
}
// вернулись из боя в лобби: матч на сервере закрыт, снова показываем список
function stopBattle() {
  matchId = null; token = null;
  NET.mode = 'local';
  phase = 'lobby';
  call('leave', { session }).catch(() => {});
  restart(LOBBY_MS);
}

/* ---------- вход и выход ---------- */
$('mmPvp').addEventListener('click', () => {
  if (phase === 'off') { phase = 'lobby'; say('ищем, кто в сети…'); restart(LOBBY_MS); }
});
document.querySelector('#pvpScreen [data-back]').addEventListener('click', () => {
  call('leave', { session }).catch(() => {});
  stopAll();
});
document.querySelector('#pvpDeckScreen [data-back]').addEventListener('click', () => {
  call('leave', { session }).catch(() => {});
  phase = 'lobby';
  pairId = null;
});

// выход из боя: сдаёмся, иначе соперник ждал бы истечения таймеров
NET.leave = () => {
  if (matchId) send({ t: 'give' });
  stopBattle();
  stopAll();
};

})();
