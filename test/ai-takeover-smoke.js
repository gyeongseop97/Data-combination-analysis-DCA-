const assert = require('assert');
const game = require('../server');
game.configureGameRuntime({ durable: true });
let fixtureId = 0;
function createMatch(count = 2) {
  fixtureId += 1;
  const ids = Array.from({ length: count }, (_, i) => `takeover-${fixtureId}-player-${i}-111111111111`);
  const room = game.createRoom({ clientId: ids[0], playerName: '방장', maxPlayers: count, turnSeconds: 30 });
  ids.slice(1).forEach((id, i) => game.joinRoom(room, { clientId: id, playerName: `참가자 ${i + 1}` }));
  game.action(room, ids[0], { action: 'start' });
  room.activeIndex = 0;
  room.deadlineAt = Date.now() + 30000;
  return { room, ids };
}
function allTiles(room) {
  return [...room.deck, ...room.board.flatMap(meld => meld.tileIds), ...room.players.flatMap(player => player.rack)].sort();
}

// Both host and guest exits preserve dealt tiles and the other player's turn.
for (const leaverIndex of [0, 1]) {
  for (const activeIndex of [0, 1]) {
    const { room, ids } = createMatch();
    room.activeIndex = activeIndex;
    room.turnDirty = true;
    room.players[leaverIndex].hasOpened = true;
    const oldRack = [...room.players[leaverIndex].rack];
    const beforeTiles = allTiles(room);
    const oldDeadline = room.deadlineAt;
    const survivor = ids[1 - leaverIndex];
    const outcome = game.leaveRoom(room, ids[leaverIndex]);
    const bot = room.players[leaverIndex];
    assert.equal(outcome.left, true);
    assert.equal(outcome.deleted, false);
    assert.equal(room.phase, 'playing');
    assert.equal(room.activeIndex, activeIndex);
    assert.equal(bot.isBot, true);
    assert.notEqual(bot.id, ids[leaverIndex]);
    assert.deepEqual(bot.rack, oldRack);
    assert.equal(bot.hasOpened, true);
    assert.equal(bot.replacedPlayerName, leaverIndex === 0 ? '방장' : '참가자 1');
    assert.equal(room.hostId, survivor);
    assert.deepEqual(allTiles(room), beforeTiles, 'replacement must preserve every tile exactly');
    assert.equal(new Set(beforeTiles).size, 106);
    assert.equal(room.forfeitResult.reason, 'opponent-left');
    assert.deepEqual(room.forfeitResult.winnerIds, [survivor]);
    assert.equal(room.forfeitResult.departedPlayer.id, ids[leaverIndex]);
    assert.ok(room.forfeitResult.id && room.forfeitResult.confirmedAt);
    assert.ok(Array.isArray(room.forfeitResult.scores));
    const view = game.roomView(room, survivor);
    assert.deepEqual(view.forfeitResult, room.forfeitResult);
    assert.equal(view.departures.length, 1);
    assert.equal(view.departures[0].player.id, ids[leaverIndex]);
    assert.equal(view.departures[0].replacementId, bot.id);
    assert.equal(view.room.players[leaverIndex].replacedPlayerName, bot.replacedPlayerName);
    assert.equal(game.roomView(room, ids[leaverIndex]).you, null, 'leaver cannot see replacement rack');
    assert.throws(() => game.action(room, ids[leaverIndex], { action: 'draw' }), /플레이어/);
    assert.throws(() => game.joinRoom(room, { clientId: ids[leaverIndex] }), /시작/);
    const replay = game.leaveRoom(room, ids[leaverIndex]);
    assert.equal(replay.left, true);
    assert.deepEqual(replay.forfeitResult, room.forfeitResult);
    assert.equal(room.departures.length, 1, 'duplicate leave must not replace AI again');
    if (activeIndex === leaverIndex) {
      assert.ok(room.aiDueAt > Date.now() - 1000);
      assert.equal(room.turnDirty, false, 'AI must not inherit abandoned dirty draft');
    } else {
      assert.equal(room.deadlineAt, oldDeadline, 'my remaining countdown must be retained');
      assert.equal(room.turnDirty, true, 'my draft status must be retained');
    }
    const win = JSON.parse(JSON.stringify(room.forfeitResult));
    const finalLeave = game.leaveRoom(room, survivor);
    assert.equal(finalLeave.deleted, true);
    assert.deepEqual(finalLeave.forfeitResult, win, 'leaving continuation must retain confirmed win');
    assert.equal(game.rooms.has(room.code), false);
  }
}

// Subsequent 3/4-player departures cannot change original winners or scores.
for (const count of [3, 4]) {
  const { room, ids } = createMatch(count);
  game.leaveRoom(room, ids[1]);
  const official = JSON.parse(JSON.stringify(room.forfeitResult));
  assert.deepEqual(official.winnerIds, ids.filter(id => id !== ids[1]));
  const laterLeavers = [ids[0], ...ids.slice(2)];
  for (const id of laterLeavers.slice(0, -1)) {
    game.leaveRoom(room, id);
    assert.deepEqual(room.forfeitResult, official);
    assert.equal(room.phase, 'playing');
    assert.ok(room.players.some(player => player.id === room.hostId && !player.isBot));
  }
  assert.equal(room.departures.length, count - 1);
  assert.deepEqual(game.leaveRoom(room, laterLeavers.at(-1)).forfeitResult, official);
  assert.equal(game.rooms.has(room.code), false);
}

// An AI completion cannot supersede the already confirmed human win.
{
  const { room, ids } = createMatch();
  const winningRack = ['n-red-10-1', 'n-red-11-1', 'n-red-12-1'];
  room.players[0].rack = ['n-blue-1-1'];
  room.players[1].rack = winningRack;
  room.players[1].hasOpened = true;
  room.deck = game.ALL_TILE_IDS.filter(id => ![...winningRack, 'n-blue-1-1'].includes(id));
  room.activeIndex = 1;
  const tiles = allTiles(room);
  game.leaveRoom(room, ids[1]);
  const official = JSON.parse(JSON.stringify(room.forfeitResult));
  const bot = room.players[1];
  const event = { kind: 'ai', playerId: bot.id, dueAt: room.aiDueAt, deadlineAt: room.deadlineAt };
  assert.equal(game.processScheduledEvent(room, event, room.aiDueAt + 1), true);
  assert.equal(room.phase, 'finished');
  assert.equal(bot.rack.length, 0);
  assert.deepEqual(allTiles(room), tiles);
  assert.deepEqual(room.result, official);
  assert.deepEqual(room.forfeitResult, official);
  assert.equal(room.continuationResult.reason, 'empty-rack');
  assert.deepEqual(room.continuationResult.winnerIds, [bot.id]);
  assert.equal(game.processScheduledEvent(room, event, event.dueAt + 2), false);
  const view = game.roomView(room, ids[0]);
  assert.deepEqual(view.result.winnerIds, [ids[0]]);
  assert.deepEqual(view.continuationResult, room.continuationResult);
  assert.deepEqual(game.leaveRoom(room, ids[0]).forfeitResult, official);
}

// Leaving a lobby or solo game still removes the room without a forfeit win.
{
  const id = 'takeover-lobby-owner-1111111111111';
  const lobby = game.createRoom({ clientId: id });
  assert.equal(game.leaveRoom(lobby, id).deleted, true);
  const solo = game.createRoom({ clientId: id, mode: 'solo' });
  const result = game.leaveRoom(solo, id);
  assert.equal(result.deleted, true);
  assert.ok(!result.forfeitResult);
}

game.rooms.clear();
game.configureGameRuntime({ durable: false });
console.log('AI takeover, rack ownership and immutable forfeit result: passed');