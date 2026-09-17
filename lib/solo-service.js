const crypto = require('crypto');
const engine = require('../server');

const SOLO_SESSION_TTL_SECONDS = Number(process.env.DCA_SOLO_SESSION_TTL_SECONDS || 60 * 60 * 24 * 7);
const TOKEN_MAX_LENGTH = 180000;

// Solo games are carried by a signed browser-held session, so they do not
// depend on Redis or a task scheduler. The same authoritative engine still
// validates every move and runs the AI.
engine.configureGameRuntime({ durable: true });

function soloError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function soloSecret() {
  const configured = String(process.env.DCA_SESSION_SECRET || '').trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw soloError('DCA_SESSION_SECRET 환경 변수가 필요합니다.', 503);
  }
  return 'development-only-dca-session-secret-change-before-production';
}

function sign(encodedPayload) {
  return crypto.createHmac('sha256', soloSecret()).update(encodedPayload).digest('base64url');
}

function secureEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serializableRoom(room) {
  return { ...room, turnTimer: null, aiTimer: null };
}

function issueSoloToken(room, ownerId) {
  const payload = {
    version: 1,
    ownerId,
    exp: Date.now() + SOLO_SESSION_TTL_SECONDS * 1000,
    room: serializableRoom(room),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

function readSoloToken(token, ownerId) {
  const raw = String(token || '');
  if (!raw || raw.length > TOKEN_MAX_LENGTH || raw.split('.').length !== 2) {
    throw soloError('개인 분석 세션을 확인할 수 없습니다. 새 게임을 시작해 주세요.', 401);
  }
  const [encoded, signature] = raw.split('.');
  if (!secureEqual(signature, sign(encoded))) {
    throw soloError('개인 분석 세션의 서명이 올바르지 않습니다. 새 게임을 시작해 주세요.', 401);
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const room = payload?.room;
    if (
      payload?.version !== 1
      || payload.ownerId !== ownerId
      || !Number.isFinite(Number(payload.exp))
      || Number(payload.exp) < Date.now()
      || room?.mode !== 'solo'
      || !Array.isArray(room.players)
      || !room.players.some((player) => player.id === ownerId)
    ) {
      throw soloError('개인 분석 세션이 만료되었거나 올바르지 않습니다. 새 게임을 시작해 주세요.', 401);
    }
    room.turnTimer = null;
    room.aiTimer = null;
    return room;
  } catch (error) {
    if (error.statusCode) throw error;
    throw soloError('개인 분석 세션을 읽을 수 없습니다. 새 게임을 시작해 주세요.', 401);
  }
}

function snapshot(room, ownerId) {
  return {
    roomCode: room.code,
    token: issueSoloToken(room, ownerId),
    state: engine.roomView(room, ownerId),
  };
}

function withSoloRoom(room, ownerId, callback) {
  engine.rooms.set(room.code, room);
  try {
    engine.advanceRoom(room);
    if (callback) callback(room);
    return snapshot(room, ownerId);
  } finally {
    engine.rooms.delete(room.code);
  }
}

function createSolo(session, payload = {}) {
  const room = engine.createRoom({
    clientId: session.id,
    playerName: payload.playerName,
    name: 'AI 연습전',
    turnSeconds: payload.turnSeconds,
    mode: 'solo',
  });
  try {
    return snapshot(room, session.id);
  } finally {
    engine.rooms.delete(room.code);
  }
}

function continueSolo(session, payload = {}) {
  const room = readSoloToken(payload.token, session.id);
  const operation = String(payload.action || 'state');
  if (operation === 'state') return withSoloRoom(room, session.id);
  if (operation === 'action') {
    return withSoloRoom(room, session.id, (activeRoom) => {
      engine.action(activeRoom, session.id, payload.payload || {});
    });
  }
  throw soloError('개인 분석 요청을 처리할 수 없습니다.');
}

module.exports = { continueSolo, createSolo };