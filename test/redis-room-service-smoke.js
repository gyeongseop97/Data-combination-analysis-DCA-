const assert = require('assert');
const { Redis } = require('@upstash/redis');
const { Client } = require('@upstash/qstash');
const scheduledRequests = [];
Client.prototype.publishJSON = async function (request) {
  scheduledRequests.push(request);
  return { messageId: 'test' };
};
process.env.QSTASH_TOKEN = 'test';
process.env.QSTASH_CURRENT_SIGNING_KEY = 'test';
process.env.QSTASH_NEXT_SIGNING_KEY = 'test';
process.env.DCA_APP_ORIGIN = 'https://example.test';

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

  // An outsider cannot close a room. A playing owner transfers their seat and
  // hosting to the remaining human, who may leave with their win intact.
  assert.equal((await service.leaveRoom(observer, created.roomCode)).left, false);
  assert.ok(await store.getRoom(created.roomCode));
  await service.leaveRoom(host, created.roomCode);
  const ownerReplaced = await store.getRoom(created.roomCode);
  assert.equal(ownerReplaced.phase, 'playing');
  assert.equal(ownerReplaced.hostId, guest.id);
  assert.equal(ownerReplaced.players[0].isBot, true);
  assert.deepEqual(ownerReplaced.forfeitResult.winnerIds, [guest.id]);
  const winningExit = await service.leaveRoom(guest, created.roomCode);
  assert.deepEqual(winningExit.forfeitResult, ownerReplaced.forfeitResult);
  assert.equal(await store.getRoom(created.roomCode), null);
  assert.equal((await service.scheduledAction({roomCode:created.roomCode,kind:'turn'})).accepted,false);
  const closeRoom = await service.createRoom(host, {playerName:'Host',visibility:'public',maxPlayers:4,turnSeconds:30});
  await service.joinRoom(guest,closeRoom.roomCode,{playerName:'Guest'});
  await service.leaveRoom(host,closeRoom.roomCode,{disconnect:true});
  let pending=await store.getRoom(closeRoom.roomCode);
  assert.ok(pending.pendingDepartures[host.id]);
  await service.roomState(host,closeRoom.roomCode);
  pending=await store.getRoom(closeRoom.roomCode);
  assert.equal(pending.pendingDepartures[host.id],undefined,'reload must cancel closure');
  await service.leaveRoom(host,closeRoom.roomCode,{disconnect:true});
  pending=await store.getRoom(closeRoom.roomCode);
  pending.pendingDepartures[host.id]=Date.now()-1;
  await store.saveRoom(pending,pending.revision);
  await service.scheduledAction({roomCode:closeRoom.roomCode,kind:'departure'});
  assert.equal(await store.getRoom(closeRoom.roomCode),null);
  assert.equal((await service.listPublicRooms(guest,20)).rooms.some(r=>r.code===closeRoom.roomCode),false);
  const playing = await service.createRoom(host, { playerName: 'Host', turnSeconds: 30 });
  await service.joinRoom(guest, playing.roomCode, { playerName: 'Guest' });
  await service.roomAction(host, playing.roomCode, { action: 'start' });
  const prepared = await store.getRoom(playing.roomCode);
  prepared.activeIndex = 1;
  prepared.deadlineAt = Date.now() + 30000;
  prepared.aiDueAt = null;
  prepared.players[0].rack = ['n-orange-13-1'];
  prepared.players[1].rack = ['n-red-1-1', 'n-blue-2-1'];
  const used = prepared.players.flatMap(player => player.rack);
  prepared.deck = require('../server').ALL_TILE_IDS.filter(id => !used.includes(id));
  await store.saveRoom(prepared, prepared.revision);
  const requestIndex = scheduledRequests.length;
  await service.leaveRoom(guest, playing.roomCode);
  const continuing = await service.roomState(host, playing.roomCode);
  assert.equal(continuing.room.phase, 'playing');
  assert.equal(continuing.result, null);
  assert.deepEqual(continuing.forfeitResult.winnerIds, [host.id]);
  const ai = continuing.room.players[1];
  assert.equal(ai.isBot, true);
  assert.notEqual(ai.id, guest.id);
  const aiRequest = scheduledRequests.slice(requestIndex).find(request =>
    request.body.roomCode === playing.roomCode && request.body.kind === 'ai');
  assert.ok(aiRequest, 'direct leave must persist and schedule the replacement AI');
  assert.equal(aiRequest.body.playerId, ai.id);
  const replayedLeave = await service.leaveRoom(guest, playing.roomCode);
  assert.equal(replayedLeave.deleted, false, 'repeated departure must never delete the surviving match');
  assert.deepEqual(replayedLeave.forfeitResult, continuing.forfeitResult);
  assert.equal((await store.getRoom(playing.roomCode)).departures.length, 1);
  await assert.rejects(() => service.roomState(guest, playing.roomCode), error => error?.statusCode === 404);
  await assert.rejects(() => service.roomAction(guest, playing.roomCode, { action: 'draw' }));
  await assert.rejects(() => service.joinRoom(guest, playing.roomCode, { playerName: 'Returning' }));
  const due = await store.getRoom(playing.roomCode);
  due.aiDueAt = Date.now() - 1;
  await store.saveRoom(due, due.revision);
  const aiEvent = { roomCode: due.code, kind: 'ai', playerId: ai.id, dueAt: due.aiDueAt, deadlineAt: due.deadlineAt };
  assert.equal((await service.scheduledAction(aiEvent)).accepted, true);
  const resolved = await service.roomState(host, playing.roomCode);
  assert.equal(resolved.turn.activePlayerId, host.id);
  assert.equal(resolved.room.players[1].tileCount, 3, 'AI must actually draw and advance the turn');
  assert.deepEqual(resolved.forfeitResult, continuing.forfeitResult);
  assert.equal((await service.scheduledAction(aiEvent)).accepted, false);
  const finalExit = await service.leaveRoom(host, playing.roomCode);
  assert.equal(finalExit.deleted, true);
  assert.deepEqual(finalExit.forfeitResult, continuing.forfeitResult);
  assert.equal(await store.getRoom(playing.roomCode), null);

  // A reload inside the disconnect grace period retains the human seat. Only
  // a confirmed departure awards the win and schedules a replacement AI.
  const delayed = await service.createRoom(host, { playerName: 'Host', turnSeconds: 30 });
  await service.joinRoom(guest, delayed.roomCode, { playerName: 'Guest' });
  await service.roomAction(host, delayed.roomCode, { action: 'start' });
  const firstDisconnect = await service.leaveRoom(guest, delayed.roomCode, { disconnect: true });
  const repeatDisconnect = await service.leaveRoom(guest, delayed.roomCode, { disconnect: true });
  assert.equal(repeatDisconnect.dueAt, firstDisconnect.dueAt, 'duplicate beacons cannot extend departure grace');
  let reloaded = await service.roomState(guest, delayed.roomCode);
  assert.equal(reloaded.you.id, guest.id);
  assert.ok(!reloaded.forfeitResult);
  let waiting = await store.getRoom(delayed.roomCode);
  assert.equal(waiting.pendingDepartures[guest.id], undefined);
  await service.leaveRoom(guest, delayed.roomCode, { disconnect: true });
  waiting = await store.getRoom(delayed.roomCode);
  waiting.pendingDepartures[guest.id] = Date.now() - 1;
  waiting.activeIndex = 1;
  waiting.deadlineAt = Date.now() + 30000;
  await store.saveRoom(waiting, waiting.revision);
  const departureRequestIndex = scheduledRequests.length;
  await service.scheduledAction({ roomCode: delayed.roomCode, kind: 'departure', playerId: guest.id });
  const replaced = await store.getRoom(delayed.roomCode);
  assert.equal(replaced.phase, 'playing');
  assert.equal(replaced.players[1].isBot, true);
  assert.deepEqual(replaced.forfeitResult.winnerIds, [host.id]);
  assert.ok(scheduledRequests.slice(departureRequestIndex).some(request =>
    request.body.roomCode === delayed.roomCode && request.body.kind === 'ai'));
  assert.equal(replaced.departures.length, 1);
  await service.scheduledAction({ roomCode: delayed.roomCode, kind: 'departure', playerId: guest.id });
  assert.equal((await store.getRoom(delayed.roomCode)).departures.length, 1);
  await service.leaveRoom(host, delayed.roomCode);
  // Delayed scheduler delivery must not reverse who forfeited first: process
  // an already-expired disconnect before the survivor's explicit exit.
  const delayedDelivery = await service.createRoom(host, { playerName: 'Host', turnSeconds: 30 });
  await service.joinRoom(guest, delayedDelivery.roomCode, { playerName: 'Guest' });
  await service.roomAction(host, delayedDelivery.roomCode, { action: 'start' });
  await service.leaveRoom(host, delayedDelivery.roomCode, { disconnect: true });
  const expiredDisconnect = await store.getRoom(delayedDelivery.roomCode);
  expiredDisconnect.pendingDepartures[host.id] = Date.now() - 1;
  await store.saveRoom(expiredDisconnect, expiredDisconnect.revision);
  // No state poll or scheduled departure runs between expiry and this exit.
  const survivorExit = await service.leaveRoom(guest, delayedDelivery.roomCode);
  assert.equal(survivorExit.left, true);
  assert.equal(survivorExit.deleted, true, 'all humans have departed, so no AI-only room may remain');
  assert.deepEqual(survivorExit.forfeitResult.winnerIds, [guest.id], 'the first disconnect must determine the winner');
  assert.equal(survivorExit.forfeitResult.departedPlayer.id, host.id);
  assert.equal(await store.getRoom(delayedDelivery.roomCode), null);
  assert.equal((await service.scheduledAction({ roomCode: delayedDelivery.roomCode, kind: 'departure', playerId: host.id })).accepted, false);
  console.log('AI takeover scheduling, preserved forfeit, delayed close and reconnect: passed');
  console.log('Redis-backed room service smoke test: passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});