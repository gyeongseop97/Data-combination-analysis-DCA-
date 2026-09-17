const assert = require('assert');
const game = require('../server');

async function requestJson(origin, path, options = {}) {
  const response = await fetch(`${origin}${path}`, options);
  const body = await response.json();
  return { response, body };
}

async function run() {
  game.configureGameRuntime({ durable: true });
  const hostId = 'guest-11111111111111111111111111111111';
  const guestId = 'guest-22222222222222222222222222222222';
  const room = game.createRoom({
    clientId: hostId,
    playerName: '방장',
    name: '공개 분석',
    maxPlayers: 4,
    turnSeconds: 30,
    visibility: 'public',
  });
  assert.equal(room.visibility, 'public');
  assert.equal(game.listPublicRooms().some((entry) => entry.code === room.code), true);
  game.joinRoom(room, { clientId: guestId, playerName: '참가자' });
  game.action(room, hostId, { action: 'start' });
  assert.equal(room.phase, 'playing');
  assert.equal(room.turnTimer, null);
  assert.equal(room.aiTimer, null);
  const firstDeadline = Date.now() - 1;
  room.deadlineAt = firstDeadline;
  game.processScheduledEvent(room, { kind: 'turn', dueAt: firstDeadline }, Date.now());
  assert.notEqual(room.deadlineAt, firstDeadline);
  game.rooms.clear();
  game.configureGameRuntime({ durable: false });

  await new Promise((resolve, reject) => {
    game.server.once('error', reject);
    game.server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${game.server.address().port}`;
  try {
    const session = await requestJson(origin, '/api/session', { method: 'POST' });
    assert.equal(session.response.status, 200);
    assert.match(session.body.clientId, /^guest-[a-f0-9]{32}$/);
    const cookie = session.response.headers.get('set-cookie');
    assert.ok(cookie);
    const created = await requestJson(origin, '/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        clientId: session.body.clientId,
        playerName: '방장',
        name: '공개 분석',
        maxPlayers: 4,
        turnSeconds: 60,
        visibility: 'public',
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.state.room.visibility, 'public');
    const listed = await requestJson(origin, '/api/rooms?scope=public&phase=lobby&limit=20', { headers: { Cookie: cookie } });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.rooms.some((entry) => entry.code === created.body.roomCode), true);
  } finally {
    game.rooms.clear();
    await new Promise((resolve) => game.server.close(resolve));
  }

  console.log('production smoke tests: passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});