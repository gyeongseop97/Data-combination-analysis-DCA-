const assert = require('assert');
const game = require('../server');

game.configureGameRuntime({ durable: true });
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
let fixtureId = 0;
function createMatch({ start = true, solo = false } = {}) {
  fixtureId += 1;
  const ids = [`chat-${fixtureId}-host-111111111111111`, `chat-${fixtureId}-guest-222222222222`];
  const room = game.createRoom({
    clientId: ids[0], playerName: '채팅 방장', maxPlayers: 2, turnSeconds: 300,
    mode: solo ? 'solo' : 'multiplayer',
  });
  if (!solo) {
    game.joinRoom(room, { clientId: ids[1], playerName: '참가자' });
    if (start) game.action(room, ids[0], { action: 'start' });
  }
  room.activeIndex = 0;
  return { room, ids };
}
function chat(room, sender, text, clientMessageId, extras = {}) {
  return game.action(room, sender, { action: 'chat', text, clientMessageId, ...extras });
}
function gameState(room) {
  return JSON.stringify({
    board: room.board, deck: room.deck, players: room.players, log: room.log,
    activeIndex: room.activeIndex, deadlineAt: room.deadlineAt, aiDueAt: room.aiDueAt,
    turnDirty: room.turnDirty, emptyPoolPasses: room.emptyPoolPasses,
    recentSubmissions: room.recentSubmissions, lastDraw: room.lastDraw,
    result: room.result, forfeitResult: room.forfeitResult,
  });
}
function messages(room, viewer) { return game.roomView(room, viewer).chatMessages || []; }

try {
  // Sending chat while someone else is playing must not mutate any game state.
  const { room, ids } = createMatch();
  room.turnDirty = true;
  const before = gameState(room);
  chat(room, ids[1], '  안녕하세요!\n즐거운 대전 해요.  ', 'first-message-001', {
    playerId: ids[0], playerName: '사칭한 이름', sentAt: 1, id: 'forged-server-id',
  });
  assert.equal(gameState(room), before, 'chat must not consume a turn or discard another player draft');
  let received = messages(room, ids[0]);
  assert.equal(received.length, 1);
  assert.equal(received[0].playerId, ids[1], 'server must derive the sender identity');
  assert.equal(received[0].playerName, '참가자');
  assert.equal(received[0].text, '안녕하세요!\n즐거운 대전 해요.');
  assert.equal(received[0].clientMessageId, 'first-message-001');
  assert.equal(received[0].sentAt, now);
  assert.ok(received[0].id.startsWith('chat-'));
  assert.notEqual(received[0].id, 'forged-server-id');
  assert.deepEqual(messages(room, ids[1]), received, 'both humans see the same ordered room messages');

  // A network retry is idempotent even before the rate interval has elapsed.
  const original = JSON.parse(JSON.stringify(received));
  chat(room, ids[1], '재전송으로 바꾸면 안 됨', 'first-message-001');
  assert.deepEqual(messages(room, ids[0]), original);
  assert.throws(() => chat(room, ids[1], '너무 빠른 새 메시지', 'fast-message-002'), error => error.statusCode === 429);
  now += 749;
  assert.throws(() => chat(room, ids[1], '아직 빠름', 'fast-message-003'), error => error.statusCode === 429);
  now += 1;
  chat(room, ids[1], '다음 메시지', 'next-message-004');
  chat(room, ids[0], '같은 요청 ID를 가진 다른 참가자', 'first-message-001');
  assert.equal(messages(room, ids[0]).length, 3);

  // Invalid messages cannot consume a history slot or impersonate a sender.
  const invalid = [
    ['', 'empty-message-001'], ['  \n\t ', 'empty-message-002'],
    ['x'.repeat(301), 'long-message-001'], [null, 'null-message-001'],
    [17, 'number-message-001'], ['control\u0000text', 'control-message-1'],
    ['hidden\u202Etext', 'bidi-message-001'],
    ['valid text', 'short'], ['valid text', 'invalid request ID'],
  ];
  for (const [text, id] of invalid) {
    now += 750;
    const length = messages(room, ids[0]).length;
    assert.throws(() => chat(room, ids[0], text, id));
    assert.equal(messages(room, ids[0]).length, length);
  }
  now += 750;
  chat(room, ids[0], '😀'.repeat(300), 'unicode-message-1');
  assert.equal([...messages(room, ids[0]).at(-1).text].length, 300);
  now += 750;
  assert.throws(() => chat(room, ids[0], '😀'.repeat(301), 'unicode-message-2'));
  now += 750;
  chat(room, ids[0], 'line one\r\nline two\tend', 'newlines-message');
  assert.equal(messages(room, ids[0]).at(-1).text, 'line one\nline two end');

  // User content remains data, and messages are never copied into game logs.
  now += 750;
  const markup = '<img src=x onerror=alert(1)> & "hello"';
  chat(room, ids[0], markup, 'markup-message-1');
  assert.equal(messages(room, ids[1]).at(-1).text, markup);
  assert.equal(room.log.some(entry => JSON.stringify(entry).includes(markup)), false);

  // Outsiders, another room and a departed human cannot read or post messages.
  const other = createMatch();
  const outsider = 'chat-outsider-333333333333333';
  assert.deepEqual(messages(room, outsider), []);
  assert.throws(() => chat(room, outsider, '끼어들기', 'outsider-message'));
  assert.deepEqual(messages(other.room, other.ids[0]), []);
  assert.deepEqual(messages(other.room, ids[0]), []);
  const previousMessages = JSON.parse(JSON.stringify(messages(room, ids[0])));
  game.leaveRoom(room, ids[1]);
  const replacement = room.players[1];
  assert.equal(replacement.isBot, true);
  assert.deepEqual(messages(room, ids[0]), previousMessages, 'AI continuation stays in the same match');
  assert.deepEqual(messages(room, ids[1]), []);
  assert.deepEqual(messages(room, replacement.id), []);
  assert.throws(() => chat(room, ids[1], '퇴장 후 전송', 'departed-message'));
  assert.throws(() => chat(room, replacement.id, '봇 사칭', 'bot-message-001'));

  // Keep only the latest 100 messages, with chronological order preserved.
  const bounded = createMatch();
  for (let index = 0; index < 105; index += 1) {
    now += 750;
    chat(bounded.room, bounded.ids[0], `메시지 ${index}`, `bounded-message-${index}`);
  }
  received = messages(bounded.room, bounded.ids[1]);
  assert.equal(received.length, 100);
  assert.equal(received[0].text, '메시지 5');
  assert.equal(received.at(-1).text, '메시지 104');
  assert.equal(new Set(received.map(entry => entry.id)).size, 100);

  // A new match, completion or deletion removes the ephemeral conversation.
  const lobby = createMatch({ start: false });
  assert.throws(() => chat(lobby.room, lobby.ids[0], '대기실 메시지', 'lobby-message-1'));
  lobby.room.chatMessages = previousMessages;
  assert.deepEqual(messages(lobby.room, lobby.ids[0]), []);
  game.action(lobby.room, lobby.ids[0], { action: 'start' });
  assert.deepEqual(lobby.room.chatMessages, []);
  const solo = createMatch({ solo: true });
  assert.throws(() => chat(solo.room, solo.ids[0], '혼자 채팅', 'solo-message-01'));
  assert.deepEqual(messages(solo.room, solo.ids[0]), []);

  now += 750;
  chat(lobby.room, lobby.ids[0], '이번 판에서만 남음', 'before-finish-01');
  lobby.room.deck = [];
  lobby.room.emptyPoolPasses = lobby.room.players.length - 1;
  const finishingPlayer = lobby.room.players[lobby.room.activeIndex].id;
  game.action(lobby.room, finishingPlayer, { action: 'draw' });
  assert.equal(lobby.room.phase, 'finished');
  assert.deepEqual(lobby.room.chatMessages, [], 'finished room storage must not retain chat text');
  assert.deepEqual(messages(lobby.room, lobby.ids[0]), []);
  assert.throws(() => chat(lobby.room, lobby.ids[0], '종료 뒤 메시지', 'finished-message'));
  game.leaveRoom(room, ids[0]);
  assert.equal(game.rooms.has(room.code), false);
  assert.deepEqual(room.chatMessages, [], 'deleting a room clears its in-memory conversation');

  console.log('Match chat identity, isolation, cadence, idempotency and ephemeral lifecycle: passed');
} finally {
  Date.now = realNow;
  game.rooms.clear();
  game.configureGameRuntime({ durable: false });
}