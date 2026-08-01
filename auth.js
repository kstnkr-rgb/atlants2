'use strict';
/*
  Личность игрока.

  В продукте id приходит из мобильного приложения «Клуб Друзей»: оно открывает
  WebView и передаёт ПОДПИСАННЫЙ токен. Подпись обязательна — иначе любой
  подставит чужой id и будет играть за другого (PROJECT.md, раздел 14.3).

  Формат токена: base64url(JSON) + "." + base64url(HMAC-SHA256 от первой части).
  Внутри JSON: { id, name, exp } — exp в миллисекундах epoch.
  Секрет общий с МП, лежит в переменной окружения ATL_SECRET.

  Если ATL_SECRET не задан, сервер работает в режиме разработки: принимает id
  без подписи. Так гоняется прототип локально. На боевом стенде секрет задать
  ОБЯЗАТЕЛЬНО, иначе личность не проверяется вовсе.
*/
const crypto = require('crypto');

const SECRET = process.env.ATL_SECRET || '';
const DEV = !SECRET;                       // без секрета — только для разработки
const SESSION_MS = 12 * 60 * 60 * 1000;
const TOKEN_MS = 5 * 60 * 1000;            // столько живёт токен от МП по умолчанию

const sessions = new Map();                // sessionToken → {playerId, name, born, dev}

const b64 = s => Buffer.from(s).toString('base64url');
const unb64 = s => Buffer.from(s, 'base64url').toString('utf8');

function sign(payload, secret) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}

// null, если подпись не сошлась, токен просрочен или в нём нет id
function verify(token, secret) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(want);
  // сравнение постоянного времени: иначе подпись подбирается по времени ответа
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(unb64(body)); } catch (e) { return null; }
  if (!data || !data.id) return null;
  if (data.exp && Date.now() > data.exp) return null;
  return data;
}

/* ---------- сессии ----------
   Токен от МП живёт минуты и приходит один раз при открытии WebView.
   Дальше клиент ходит со своим токеном сессии, выданным сервером. */
function openSession(body) {
  let id, name, dev = false;

  if (body && body.token) {
    if (DEV) return { err: 'сервер запущен без ATL_SECRET, подписанные токены не принимаются' };
    const data = verify(body.token, SECRET);
    if (!data) return { err: 'подпись не сошлась или токен просрочен' };
    id = String(data.id);
    name = String(data.name || data.id);
  } else {
    // без подписи пускаем только в режиме разработки
    if (!DEV) return { err: 'нужен подписанный токен от приложения' };
    id = String((body && body.id) || '').trim();
    if (!id) return { err: 'нужен id игрока' };
    name = String((body && body.name) || id);
    dev = true;
  }

  const token = crypto.randomBytes(18).toString('hex');
  sessions.set(token, { playerId: id, name: name.slice(0, 24), born: Date.now(), dev });
  return { session: token, playerId: id, name: name.slice(0, 24), dev };
}

// кто пришёл; null, если сессии нет или она истекла
function whoIs(session) {
  const s = sessions.get(session);
  if (!s) return null;
  if (Date.now() - s.born > SESSION_MS) { sessions.delete(session); return null; }
  return s;
}

function sweep() {
  const t = Date.now();
  for (const [k, s] of sessions) if (t - s.born > SESSION_MS) sessions.delete(k);
}

module.exports = {
  DEV, SESSION_MS, TOKEN_MS, sessions,
  sign, verify, openSession, whoIs, sweep,
  // для тестов: подписать токен так, как это будет делать МП
  signAs: (id, name, ttl) => sign({ id, name, exp: Date.now() + (ttl || TOKEN_MS) }, SECRET),
  _secret: () => SECRET,
};
