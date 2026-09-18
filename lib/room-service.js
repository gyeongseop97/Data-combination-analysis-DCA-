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
      for (const [id, dueAt] of Object.entries(room.pendingDepartures || {}).sort((left, right) => left[1] - right[1])) {
        if (Date.now() >= dueAt) {
          const departure = engine.leaveRoom(room, id);
          if (departure.deleted) { await store.deleteRoom(room.code); throw roomNotFound(); }
        } else if (id === options.memberId) delete room.pendingDepartures[id];
      }
      const advanced = options.skipAdvance ? false : engine.advanceRoom(room);
      let result;
      let callbackError = null;
      try {
        result = await callback(room, { before, advanced });
      } catch (error) {
        callbackError = error;
      }
      const changed = fingerprintBefore !== roomFingerprint(room);
      const shouldPersist = changed || advanced || (options.persist !== false && (callbackError
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
  }, { persist: false, memberId: session.id });
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

async function leaveRoom(session, code, payload = {}) {
  await store.consumeRateLimit(session.id, 'room-leave', 30, 60);
  const normalized = normalizeCode(code);
  if (!normalized) throw roomNotFound();
  let persisted = null;
  const outcome = await store.withRoomLock(normalized, async () => {
    const room = await store.getRoom(normalized);
    if (!room) return { left: true, deleted: true };
    const revision = Number(room.revision || 0);
    const before = { deadlineAt: room.deadlineAt, aiDueAt: room.aiDueAt };
    const wasMember = room.players.some((player) => player.id === session.id)
      || room.departures?.some((entry) => entry.player.id === session.id);
    let settledDeparture = false;
    // A late scheduler delivery must not reverse who left first when the other
    // player exits before their next state poll.
    const departures = Object.entries(room.pendingDepartures || {}).sort((left, right) => left[1] - right[1]);
    for (const [id, dueAt] of departures) {
      if (Date.now() < dueAt) continue;
      const departure = engine.leaveRoom(room, id);
      settledDeparture = true;
      if (departure.deleted) {
        await store.deleteRoom(room.code);
        return wasMember ? departure : { left: false, deleted: true, reason: 'not-member' };
      }
    }
    const result = engine.leaveRoom(room, session.id, payload);
    if (result.deleted) await store.deleteRoom(room.code);
    else if (settledDeparture || result.left || result.disconnecting) {
      await store.saveRoom(room, revision);
      persisted = { room, before, result };
    }
    return result;
  });
  if (persisted) {
    // Replacement AI and its turn deadline must survive a serverless instance ending.
    await scheduleAfterPersist(persisted.room, persisted.before);
    if (persisted.result.disconnecting) {
      await scheduler.scheduleTask(persisted.room, 'departure', persisted.result.dueAt, { playerId: session.id });
    }
  }
  return outcome;
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
  const limit = action === 'chat' ? 30 : action === 'draft' ? 180 : 60;
  await store.consumeRateLimit(session.id, `room-action:${action || 'unknown'}`, limit, 60);
  const outcome = await withLoadedRoom(code, (room) => {
    engine.action(room, session.id, payload || {});
    return engine.roomView(room, session.id);
  }, action === 'chat' ? { skipAdvance: true, persist: false, memberId: session.id } : {});
  return outcome.result;
}

async function scheduledAction(event) {
  const code = normalizeCode(event?.roomCode);
  try {
    const outcome = await withLoadedRoom(
      code,
      (room) => event.kind === 'departure' ? false : engine.processScheduledEvent(room, event),
      { skipAdvance: true, persistIfChanged: true },
    );
    return { accepted: Boolean(outcome.result) };
  } catch (error) {
    // A task arriving after an explicit room closure is obsolete, not a failure.
    if (error.statusCode === 404) return { accepted: false };
    throw error;
  }
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