const assert = require('assert');
const { Redis } = require('@upstash/redis');

class FakeRedis {
  constructor() {
    this.values = new Map();
    this.sorted = new Map();
  }

  clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, this.clone(value));
    return 'OK';
  }

  async get(key) { return this.clone(this.values.get(key) ?? null); }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async incr(key) { const next = Number(this.values.get(key) || 0) + 1; this.values.set(key, next); return next; }
  async expire() { return 1; }
  async eval(script, keys, args) {
    const value = this.values.get(keys[0]);
    if (script.includes('cjson.decode(current)')) {
      if (!value || Number(value.revision || 0) !== Number(args[0])) return 0;
      this.values.set(keys[0], JSON.parse(args[1]));
      return 1;
    }
    if (value === args[0]) return this.values.delete(keys[0]) ? 1 : 0;
    return 0;
  }

  async zadd(key, entry) {
    const values = this.sorted.get(key) || new Map();
    values.set(entry.member, entry.score);
    this.sorted.set(key, values);
    return 1;
  }

  async zrem(key, ...members) {
    const values = this.sorted.get(key) || new Map();
    let removed = 0;
    for (const member of members) if (values.delete(member)) removed += 1;
    return removed;
  }

  async zrange(key, start, end, options = {}) {
    const values = [...(this.sorted.get(key) || new Map()).entries()].sort((a, b) => a[1] - b[1]);
    if (options.rev) values.reverse();
    const last = end < 0 ? values.length + end + 1 : end + 1;
    return values.slice(start, last).map(([member]) => member);
  }
}

const fake = new FakeRedis();
Redis.fromEnv = () => fake;
process.env.UPSTASH_REDIS_REST_URL = 'https://fake.redis';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
process.env.DCA_SESSION_SECRET = 'test-secret';
const service = require('../lib/room-service');
const store = require('../lib/room-store');

async function run() {
  const host = { id: 'guest-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const guest = { id: 'guest-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
  const created = await service.createRoom(host, {
    playerName: '방장',
    name: '공개 분석',
    maxPlayers: 2,
    turnSeconds: 30,
    visibility: 'public',
  });
  assert.equal(created.state.room.visibility, 'public');

  const observer = { id: 'guest-cccccccccccccccccccccccccccccccc' };
  const preview = await service.roomState(observer, created.roomCode);
  assert.equal(preview.you, null);
  assert.equal(preview.room.visibility, 'public');
  assert.equal(preview.room.playerCount, 1);
  assert.equal(preview.board, undefined);

  const stale = await store.getRoom(created.roomCode);
  const current = await store.getRoom(created.roomCode);
  current.name = '동시 저장 확인';
  await store.saveRoom(current, current.revision);
  stale.name = '덮어쓰면 안 됨';
  await assert.rejects(
    () => store.saveRoom(stale, stale.revision),
    (error) => error?.statusCode === 409,
  );

  let listed = await service.listPublicRooms(host, 20);
  assert.equal(listed.rooms.some((room) => room.code === created.roomCode), true);

  const joined = await service.joinRoom(guest, created.roomCode, { playerName: '참가자' });
  assert.equal(joined.state.room.players.length, 2);
  listed = await service.listPublicRooms(host, 20);
  assert.equal(listed.rooms.some((room) => room.code === created.roomCode), false);

  const left = await service.leaveRoom(guest, created.roomCode);
  assert.equal(left.left, true);
  listed = await service.listPublicRooms(host, 20);
  assert.equal(listed.rooms.some((room) => room.code === created.roomCode), true);
  await service.joinRoom(guest, created.roomCode, { playerName: '참가자' });

  const started = await service.roomAction(host, created.roomCode, { action: 'start' });
  assert.equal(started.room.phase, 'playing');
  const state = await service.roomState(host, created.roomCode);
  assert.equal(state.you.id, host.id);
  await assert.rejects(
    () => service.roomState(observer, created.roomCode),
    (error) => error?.statusCode === 404,
  );

  const expired = await store.getRoom(created.roomCode);
  expired.activeIndex = 0;
  expired.deadlineAt = Date.now() - 1;
  expired.aiDueAt = null;
  await store.saveRoom(expired, expired.revision);
  await assert.rejects(() => service.roomAction(host, created.roomCode, { action: 'draw' }));
  const afterTimeout = await store.getRoom(created.roomCode);
  assert.equal(afterTimeout.activeIndex, 1);
  assert.ok(Number(afterTimeout.deadlineAt) > Date.now() - 1000);

  console.log('Redis-backed room service smoke test: passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});