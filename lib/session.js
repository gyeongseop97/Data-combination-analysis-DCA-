const crypto = require('crypto');

const COOKIE_NAME = 'dca_guest';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function secureEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sessionSecret() {
  const value = String(process.env.DCA_SESSION_SECRET || '').trim();
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    const error = new Error('DCA_SESSION_SECRET 환경 변수가 필요합니다.');
    error.statusCode = 503;
    throw error;
  }
  return 'development-only-dca-session-secret-change-before-production';
}

function sign(encodedPayload) {
  return crypto.createHmac('sha256', sessionSecret()).update(encodedPayload).digest('base64url');
}

function parseCookies(request) {
  const raw = String(request.headers.cookie || '');
  return Object.fromEntries(raw.split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter((entry) => entry.length));
}

function readSession(request) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token || !token.includes('.')) return null;
  const [encodedPayload, signature] = token.split('.');
  if (!secureEqual(signature, sign(encodedPayload))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!/^guest-[a-f0-9]{32}$/.test(payload.id) || !Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function createSession() {
  const payload = {
    id: `guest-${crypto.randomUUID().replace(/-/g, '')}`,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  };
  const encodedPayload = base64url(JSON.stringify(payload));
  return { payload, token: `${encodedPayload}.${sign(encodedPayload)}` };
}

function cookieFor(token, request) {
  const forwarded = String(request.headers['x-forwarded-proto'] || '').toLowerCase();
  const secure = forwarded.includes('https') || process.env.NODE_ENV === 'production';
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function requireSession(request) {
  const session = readSession(request);
  if (!session) {
    const error = new Error('세션이 만료되었습니다. 화면을 새로고침해 주세요.');
    error.statusCode = 401;
    throw error;
  }
  return session;
}

function issueSession(request) {
  const existing = readSession(request);
  if (existing) return { session: existing, cookie: null };
  const created = createSession();
  return { session: created.payload, cookie: cookieFor(created.token, request) };
}

module.exports = { COOKIE_NAME, issueSession, readSession, requireSession };