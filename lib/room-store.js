const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const ROOM_TTL_SECONDS = Number(process.env.DCA_ROOM_TTL_SECONDS || 60 * 60 * 36);
const FINISHED_ROOM_TTL_SECONDS = Number(process.env.DCA_FINISHED_ROOM_TTL_SECONDS || 60 * 60 * 4);
const PUBLIC_ROOM_MAX_AGE_MS = Number(process.env.DCA_PUBLIC_ROOM_MAX_AGE_MS || 1000 * 60 * 60 * 12);
const LOCK_TTL_MS = 30000;
const ROOM_PREFIX = 'dca:room:';
const LOCK_PREFIX = 'dca:lock:';
const PUBLIC_INDEX = 'dca:rooms:public';
const RATE_PREFIX = 'dca:rate:';

let cachedRedis = null;

function storeUnavailable(message) {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
}

function getRedis() {
  if (cachedRedis) return cachedRedis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw storeUnavailable('게임 저장소가 아직 연결되지 않았습니다. 관리자에게 Redis 연결 설정을 요청해 주세요.');
  }
  cachedRedis = Redis.fromEnv();
  return cachedRedis;
}

function roomKey(code) {
  return `${ROOM_PREFIX}${String(code || '').toUpperCase()}`;
}

function lockKey(code) {
  return `${LOCK_PREFIX}${String(code || '').toUpperCase()}`;
}

function roomTtl(room) {
  return room?.phase === 'finished' ? FINISHED_ROOM_TTL_SECONDS : ROOM_TTL_SECONDS;
}

function roomConflict() {
  const error = new Error('방 상태가 다른 요청으로 변경되었습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.');
  error.statusCode = 409;
  return error;
}

function persistedRoom(room) {
  return {
    ...room,
    turnTimer: null,
    aiTimer: null,
  };
}

function lobbyEntry(room) {
  return {
    code: room.code,
    name: room.name,
    maxPlayers: room.maxPlayers,
    playerCount: room.players.length,
    openSeats: Math.max(0, room.maxPlayers - room.players.length),
    turnSeconds: room.turnSeconds,
    visibility: 'public',
    phase: 'lobby',
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

async function syncPublicIndex(room) {
  const redis = getRedis();
  const code = String(room?.code || '').toUpperCase();
  if (!code) return;
  const isJoinable = room.visibility === 'public'
    && room.mode === 'multiplayer'
    && room.phase === 'lobby'
    && room.players.length < room.maxPlayers;
  if (isJoinable) {
    await redis.zadd(PUBLIC_INDEX, { score: Number(room.updatedAt || Date.now()), member: code });
  } else {
    await redis.zrem(PUBLIC_INDEX, code);
  }
}

async function getRoom(code) {
  const result = await getRedis().get(roomKey(code));
  return result && typeof result === 'object' ? result : null;
}

async function createRoomIfAbsent(room) {
  const result = await getRedis().set(roomKey(room.code), persistedRoom(room), { nx: true, ex: roomTtl(room) });
  if (result !== 'OK') return false;
  await syncPublicIndex(room);
  return true;
}

async function saveRoom(room, expectedRevision) {
  const redis = getRedis();
  const next = {
    ...persistedRoom(room),
    updatedAt: Date.now(),
    revision: Number(room.revision || 0) + 1,
  };
  if (Number.isFinite(Number(expectedRevision))) {
    const saved = await redis.eval(
      'local current = redis.call("get", KEYS[1])\n'
        + 'if not current then return 0 end\n'
        + 'local decoded = cjson.decode(current)\n'
        + 'if tonumber(decoded.revision or 0) ~= tonumber(ARGV[1]) then return 0 end\n'
        + 'redis.call("set", KEYS[1], ARGV[2], "EX", ARGV[3])\n'
        + 'return 1',
      [roomKey(room.code)],
      [String(expectedRevision), JSON.stringify(next), String(roomTtl(room))],
    );
    if (Number(saved) !== 1) throw roomConflict();
  } else {
    await redis.set(roomKey(room.code), next, { ex: roomTtl(room) });
  }
  Object.assign(room, next);
  await syncPublicIndex(room);
  return room;
}

async function deleteRoom(code) {
  const normalized = String(code || '').toUpperCase();
  await Promise.all([getRedis().del(roomKey(normalized)), getRedis().zrem(PUBLIC_INDEX, normalized)]);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRoomLock(code, operation) {
  const redis = getRedis();
  const normalized = String(code || '').toUpperCase();
  if (!normalized) throw new Error('방 코드가 올바르지 않습니다.');
  const key = lockKey(normalized);
  const token = crypto.randomUUID();
  let locked = false;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const claimed = await redis.set(key, token, { nx: true, px: LOCK_TTL_MS });
    if (claimed === 'OK') {
      locked = true;
      break;
    }
    await wait(20 + Math.floor(Math.random() * 45));
  }
  if (!locked) {
    const error = new Error('다른 참가자의 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.');
    error.statusCode = 409;
    throw error;
  }
  try {
    return await operation();
  } finally {
    try {
      await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        [key],
        [token],
      );
    } catch {
      // Locks have a short TTL. A failed best-effort release must not hide a game result.
    }
  }
}

async function listPublicRooms(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  const redis = getRedis();
  const codes = await redis.zrange(PUBLIC_INDEX, 0, Math.max(safeLimit * 3, 50) - 1, { rev: true });
  const rooms = await Promise.all(codes.map((code) => getRoom(code)));
  const staleCodes = [];
  const now = Date.now();
  const entries = [];
  for (const room of rooms) {
    if (!room) continue;
    const isJoinable = room.visibility === 'public'
      && room.mode === 'multiplayer'
      && room.phase === 'lobby'
      && room.players.length < room.maxPlayers
      && now - Number(room.updatedAt || room.createdAt || 0) <= PUBLIC_ROOM_MAX_AGE_MS;
    if (isJoinable) entries.push(lobbyEntry(room));
    else staleCodes.push(room.code);
  }
  if (staleCodes.length) await redis.zrem(PUBLIC_INDEX, ...staleCodes);
  return entries.slice(0, safeLimit);
}

async function consumeRateLimit(subject, bucket, max, windowSeconds) {
  const redis = getRedis();
  const key = `${RATE_PREFIX}${bucket}:${String(subject || 'anonymous').slice(0, 100)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  if (count <= max) return true;
  const error = new Error('요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  error.statusCode = 429;
  throw error;
}

function storageStatus() {
  return {
    redisConfigured: Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
    roomTtlSeconds: ROOM_TTL_SECONDS,
  };
}

module.exports = {
  consumeRateLimit,
  createRoomIfAbsent,
  deleteRoom,
  getRedis,
  getRoom,
  listPublicRooms,
  lobbyEntry,
  saveRoom,
  storageStatus,
  syncPublicIndex,
  withRoomLock,
};