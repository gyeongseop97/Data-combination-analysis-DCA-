const engine = require('../server');
const store = require('./room-store');
const scheduler = require('./scheduler');

engine.configureGameRuntime({ durable: true });

function requireProductionScheduler() {
  if (process.env.NODE_ENV !== 'production' || scheduler.schedulerConfigured()) return;
  const error = new Error('정식 운영을 시작하려면 QStash 예약 작업 연결이 필요합니다.');
  error.statusCode = 503;
  throw error;
}

function roomNotFound() {
  const error = new Error('해당 방을 찾을 수 없습니다. 초대 코드 또는 공개 목록을 확인해 주세요.');
  error.statusCode = 404;
  return error;
}

function joinPreview(room) {
  const visibility = room.visibility || (room.mode === 'solo' ? 'private' : 'invite');
  const joinable = room.mode === 'multiplayer'
    && room.phase === 'lobby'
    && room.players.length < room.maxPlayers;
  if (!joinable) throw roomNotFound();
  if (visibility === 'public') {
    return {
      serverNow: Date.now(),
      room: {
        code: room.code,
        name: room.name,
        maxPlayers: room.maxPlayers,
        playerCount: room.players.length,
        openSeats: Math.max(0, room.maxPlayers - room.players.length),
        turnSeconds: room.turnSeconds,
        visibility: 'public',
        phase: 'lobby',
      },
      you: null,
      joinRequired: true,
    };
  }
  if (visibility === 'invite') {
    return {
      serverNow: Date.now(),
      room: { code: room.code, visibility: 'invite', phase: 'lobby', joinable: true },
      you: null,
      joinRequired: true,
    };
  }
  throw roomNotFound();
}

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function waitForRetry(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function scheduleAfterPersist(room, before) {
  let rejected = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const results = await scheduler.scheduleRoomTasks(room, before);
    rejected = results.filter((result) => result.status === 'rejected');
    if (!rejected.length) return;
    if (attempt < 2) await waitForRetry(150 * (attempt + 1));
  }
  for (const result of rejected) {
    console.error('Unable to schedule room task:', result.reason?.message || result.reason);
  }
}

function roomFingerprint(room) {
  return JSON.stringify({ ...room, turnTimer: null, aiTimer: null });
}

async function withLoadedRoom(code, callback, options = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) throw roomNotFound();
  let persisted = null;
  let outcome;
  try {
    outcome = await store.withRoomLock(normalized, async () => {
    const room = await store.getRoom(normalized);
    if (!room) throw roomNotFound();
    const expectedRevision = Number(room.revision || 0);
    room.turnTimer = null;
    room.aiTimer = null;
    engine.rooms.set(room.code, room);
    try {
      const before = { deadlineAt: room.deadlineAt, aiDueAt: room.aiDueAt };
      const fingerprintBefore = roomFingerprint(room);
      const advanced = options.skipAdvance ? false : engine.advanceRoom(room);
      let result;
      let callbackError = null;
      try {
        result = await callback(room, { before, advanced });
      } catch (error) {
        callbackError = error;
      }
      const changed = fingerprintBefore !== roomFingerprint(room);
      const shouldPersist = advanced || (options.persist !== false && (callbackError
        ? changed
        : (!options.persistIfChanged || Boolean(result))));
      if (shouldPersist) {
        await store.saveRoom(room, expectedRevision);
        persisted = { room, before };
      }
      if (callbackError) throw callbackError;
      return { room, result, advanced, before, shouldPersist };
    } finally {
      engine.rooms.delete(room.code);
    }
    });
  } finally {
    if (persisted) await scheduleAfterPersist(persisted.room, persisted.before);
  }
  return outcome;
}

async function createRoom(session, payload) {
  requireProductionScheduler();
  await store.consumeRateLimit(session.id, 'room-create', 8, 60 * 60);
  const input = { ...payload, clientId: session.id };
  let room = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    room = engine.createRoom(input);
    try {
      const created = await store.createRoomIfAbsent(room);
      if (created) {
        const before = { deadlineAt: null, aiDueAt: null };
        await scheduleAfterPersist(room, before);
        return { roomCode: room.code, state: engine.roomView(room, session.id) };
      }
    } finally {
      engine.rooms.delete(room.code);
    }
  }
  const error = new Error('새 방 코드를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.');
  error.statusCode = 503;
  throw error;
}

async function listPublicRooms(session, limit) {
  await store.consumeRateLimit(session.id, 'public-list', 90, 60);
  return { rooms: await store.listPublicRooms(limit) };
}

async function roomState(session, code) {
  await store.consumeRateLimit(session.id, 'room-state', 300, 60);
  const outcome = await withLoadedRoom(code, (room) => {
    if (!room.players.some((player) => player.id === session.id)) return joinPreview(room);
    return engine.roomView(room, session.id);
  }, { persist: false });
  return outcome.result;
}

async function joinRoom(session, code, payload) {
  await store.consumeRateLimit(session.id, 'room-join', 24, 60);
  const outcome = await withLoadedRoom(code, (room) => {
    const player = engine.joinRoom(room, { ...payload, clientId: session.id });
    return { player, state: engine.roomView(room, player.id) };
  });
  return outcome.result;
}

async function leaveRoom(session, code) {
  await store.consumeRateLimit(session.id, 'room-leave', 30, 60);
  const normalized = normalizeCode(code);
  if (!normalized) throw roomNotFound();
  return store.withRoomLock(normalized, async () => {
    const room = await store.getRoom(normalized);
    if (!room) throw roomNotFound();
    const expectedRevision = Number(room.revision || 0);
    if (room.phase !== 'lobby') return { left: false, reason: 'already-started' };
    const index = room.players.findIndex((player) => player.id === session.id);
    if (index < 0) return { left: false, reason: 'not-member' };
    room.players.splice(index, 1);
    if (!room.players.length) {
      await store.deleteRoom(room.code);
      return { left: true, deleted: true };
    }
    if (room.hostId === session.id) room.hostId = room.players[0].id;
    room.log = [{ id: `log-leave-${Date.now()}`, text: '참가자가 대기실을 나갔습니다.', at: Date.now() }, ...(room.log || [])].slice(0, 14);
    await store.saveRoom(room, expectedRevision);
    return { left: true, deleted: false };
  });
}

async function updateSettings(session, code, payload) {
  await store.consumeRateLimit(session.id, 'room-settings', 30, 60);
  const outcome = await withLoadedRoom(code, (room) => {
    engine.updateSettings(room, session.id, payload);
    return engine.roomView(room, session.id);
  });
  return outcome.result;
}

async function roomAction(session, code, payload) {
  const action = String(payload?.action || '');
  const limit = action === 'draft' ? 180 : 60;
  await store.consumeRateLimit(session.id, `room-action:${action || 'unknown'}`, limit, 60);
  const outcome = await withLoadedRoom(code, (room) => {
    engine.action(room, session.id, payload || {});
    return engine.roomView(room, session.id);
  });
  return outcome.result;
}

async function scheduledAction(event) {
  const code = normalizeCode(event?.roomCode);
  const outcome = await withLoadedRoom(
    code,
    (room) => engine.processScheduledEvent(room, event),
    { skipAdvance: true, persistIfChanged: true },
  );
  return { accepted: Boolean(outcome.result) };
}

function health() {
  return {
    storage: store.storageStatus(),
    scheduler: { configured: scheduler.schedulerConfigured() },
    sessionConfigured: Boolean(process.env.DCA_SESSION_SECRET),
  };
}

module.exports = {
  createRoom,
  health,
  joinRoom,
  leaveRoom,
  listPublicRooms,
  normalizeCode,
  roomAction,
  roomState,
  scheduledAction,
  updateSettings,
};