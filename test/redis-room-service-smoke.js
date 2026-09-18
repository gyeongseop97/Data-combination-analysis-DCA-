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

async function verifyDurableChat() {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const chatHost = { id: 'guest-chat-host-aaaaaaaaaaaaaaaaaaaa' };
  const chatGuest = { id: 'guest-chat-guest-bbbbbbbbbbbbbbbbbb' };
  const chatObserver = { id: 'guest-chat-observer-ccccccccccccccc' };
  try {
    const room = await service.createRoom(chatHost, {
      playerName: '채팅 방장', maxPlayers: 2, turnSeconds: 300, visibility: 'public',
    });
    const lobbyPreview = await service.roomState(chatObserver, room.roomCode);
    assert.ok(!lobbyPreview.chatMessages, 'public lobby previews must not expose conversations');
    await service.joinRoom(chatGuest, room.roomCode, { playerName: '채팅 참가자' });
    await assert.rejects(() => service.roomAction(chatHost, room.roomCode, {
      action: 'chat', text: '아직 시작 전', clientMessageId: 'durable-lobby-001',
    }));
    await service.roomAction(chatHost, room.roomCode, { action: 'start' });

    const waiting = await store.getRoom(room.roomCode);
    waiting.activeIndex = 0;
    waiting.turnDirty = true;
    waiting.deadlineAt = now - 1;
    await store.saveRoom(waiting, waiting.revision);
    const before = JSON.stringify({
      players: waiting.players, board: waiting.board, deck: waiting.deck,
      activeIndex: waiting.activeIndex, deadlineAt: waiting.deadlineAt,
      turnDirty: waiting.turnDirty, log: waiting.log, aiDueAt: waiting.aiDueAt,
    });
    const scheduleCount = scheduledRequests.length;
    const outgoing = {
      action: 'chat', text: '  저장된 대전 전용 메시지 <b>안녕</b>  ',
      clientMessageId: 'durable-message-01',
      playerId: chatHost.id, playerName: '사칭 방장', sentAt: 1,
    };
    const sent = await service.roomAction(chatGuest, room.roomCode, outgoing);
    assert.equal(sent.chatMessages.length, 1);
    assert.equal(sent.chatMessages[0].playerId, chatGuest.id);
    assert.equal(sent.chatMessages[0].playerName, '채팅 참가자');
    assert.equal(sent.chatMessages[0].text, '저장된 대전 전용 메시지 <b>안녕</b>');
    let stored = await store.getRoom(room.roomCode);
    assert.deepEqual(stored.chatMessages, sent.chatMessages, 'chat survives serialization between serverless requests');
    assert.equal(JSON.stringify({
      players: stored.players, board: stored.board, deck: stored.deck,
      activeIndex: stored.activeIndex, deadlineAt: stored.deadlineAt,
      turnDirty: stored.turnDirty, log: stored.log, aiDueAt: stored.aiDueAt,
    }), before, 'chat must not advance a turn even if its deadline just elapsed');
    assert.equal(scheduledRequests.length, scheduleCount, 'sending chat does not enqueue turn/AI jobs');
    const revision = stored.revision;
    const duplicate = await service.roomAction(chatGuest, room.roomCode, { ...outgoing, text: '재전송' });
    assert.deepEqual(duplicate.chatMessages, sent.chatMessages);
    assert.equal((await store.getRoom(room.roomCode)).revision, revision, 'duplicate retries do not rewrite the match');
    await assert.rejects(() => service.roomAction(chatGuest, room.roomCode, {
      action: 'chat', text: '너무 빠른 메시지', clientMessageId: 'durable-too-fast',
    }), error => error.statusCode === 429);
    assert.equal((await store.getRoom(room.roomCode)).chatMessages.length, 1);

    // Restore the turn for regular state polls, which intentionally process timeouts.
    stored.deadlineAt = now + 300000;
    await store.saveRoom(stored, stored.revision);
    const reloadedView = await service.roomState(chatHost, room.roomCode);
    assert.deepEqual(reloadedView.chatMessages, sent.chatMessages);
    await assert.rejects(() => service.roomState(chatObserver, room.roomCode), error => error.statusCode === 404);
    await assert.rejects(() => service.roomAction(chatObserver, room.roomCode, {
      action: 'chat', text: '외부 참가자', clientMessageId: 'durable-outsider',
    }));
    const separate = await service.createRoom(chatObserver, { playerName: '다른 방', turnSeconds: 300 });
    assert.deepEqual(separate.state.chatMessages, []);
    await service.leaveRoom(chatObserver, separate.roomCode);

    // Replacement AI cannot inherit permission to impersonate the departed sender.
    await service.leaveRoom(chatGuest, room.roomCode);
    const continued = await service.roomState(chatHost, room.roomCode);
    assert.deepEqual(continued.chatMessages, sent.chatMessages, 'AI continuation belongs to the current match');
    await assert.rejects(() => service.roomAction(chatGuest, room.roomCode, {
      action: 'chat', text: '퇴장 후', clientMessageId: 'durable-departed',
    }));
    const replacement = continued.room.players.find(player => player.isBot);
    await assert.rejects(() => service.roomAction({ id: replacement.id }, room.roomCode, {
      action: 'chat', text: 'AI 사칭', clientMessageId: 'durable-bot-send',
    }));

    // Clear the actual stored message text on completion, not just the UI response.
    stored = await store.getRoom(room.roomCode);
    stored.activeIndex = 0;
    stored.aiDueAt = null;
    stored.deck = [];
    stored.emptyPoolPasses = stored.players.length - 1;
    await store.saveRoom(stored, stored.revision);
    const finished = await service.roomAction(chatHost, room.roomCode, { action: 'draw' });
    assert.equal(finished.room.phase, 'finished');
    assert.deepEqual(finished.chatMessages, []);
    assert.deepEqual((await store.getRoom(room.roomCode)).chatMessages, []);
    assert.equal(JSON.stringify(await store.getRoom(room.roomCode)).includes(outgoing.text.trim()), false);
    await assert.rejects(() => service.roomAction(chatHost, room.roomCode, {
      action: 'chat', text: '끝난 뒤', clientMessageId: 'durable-finished',
    }));
    await service.leaveRoom(chatHost, room.roomCode);
    assert.equal(await store.getRoom(room.roomCode), null);

    // Durable rate limits must apply across separate requests, independently of turns.
    const rateHost = { id: 'guest-chat-rate-aaaaaaaaaaaaaaaaaaaa' };
    const rateGuest = { id: 'guest-chat-rate-bbbbbbbbbbbbbbbbbbbb' };
    const rateRoom = await service.createRoom(rateHost, { playerName: '제한 확인', turnSeconds: 300 });
    await service.joinRoom(rateGuest, rateRoom.roomCode, { playerName: '수신 확인' });
    await service.roomAction(rateHost, rateRoom.roomCode, { action: 'start' });
    for (let index = 0; index < 30; index += 1) {
      now += 750;
      await service.roomAction(rateHost, rateRoom.roomCode, {
        action: 'chat', text: `메시지 ${index}`, clientMessageId: `rate-message-${index}`,
      });
    }
    now += 750;
    await assert.rejects(() => service.roomAction(rateHost, rateRoom.roomCode, {
      action: 'chat', text: '31번째 요청', clientMessageId: 'rate-message-31',
    }), error => error.statusCode === 429);
    assert.equal((await store.getRoom(rateRoom.roomCode)).chatMessages.length, 30);
    // The other sender has a separate limit, and the board action bucket is separate.
    const otherSender = await service.roomAction(rateGuest, rateRoom.roomCode, {
      action: 'chat', text: '상대 메시지', clientMessageId: 'rate-other-sender',
    });
    assert.equal(otherSender.chatMessages.length, 31);
    const activeId = otherSender.turn.activePlayerId;
    assert.equal((await service.roomAction({ id: activeId }, rateRoom.roomCode, { action: 'draw' })).room.phase, 'playing');
    await service.leaveRoom(rateGuest, rateRoom.roomCode);
    await service.leaveRoom(rateHost, rateRoom.roomCode);
    assert.equal(await store.getRoom(rateRoom.roomCode), null, 'deleting a match deletes its conversation');
    console.log('Redis chat authorization, serialization, rate limits and deletion lifecycle: passed');
  } finally {
    Date.now = realNow;
  }
}
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
  await verifyDurableChat();
  console.log('Redis-backed room service smoke test: passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});