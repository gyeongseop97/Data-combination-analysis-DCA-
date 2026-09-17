const assert = require('assert');
const game = require('../server');

game.configureGameRuntime({ durable: true });
const playerId = 'opening-owner-111111111111111111111111111';
const room = game.createRoom({ clientId: playerId, playerName: '나', mode: 'solo', turnSeconds: 30 });
const player = room.players[0];
const rack = ['n-red-1-1', 'n-red-2-1', 'n-red-3-1', 'n-blue-13-1'];
player.rack = [...rack];

assert.throws(() => {
  game.action(room, player.id, {
    action: 'submit',
    board: [{ id: 'draft-low-opening', tileIds: rack.slice(0, 3) }],
    rackIds: [rack[3]],
  });
}, /현재 06점/);

assert.deepEqual(player.rack, rack);
assert.deepEqual(room.board, []);
assert.equal(player.hasOpened, false);

game.rooms.clear();
game.configureGameRuntime({ durable: false });
console.log('opening draft smoke tests: passed');