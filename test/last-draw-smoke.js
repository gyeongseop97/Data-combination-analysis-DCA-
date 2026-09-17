const assert = require('assert');
const game = require('../server');

game.configureGameRuntime({ durable: true });
const playerId = 'draw-owner-1111111111111111111111111111';
const room = game.createRoom({
  clientId: playerId,
  playerName: '나',
  mode: 'solo',
  turnSeconds: 30,
});

const player = room.players[0];
const bot = room.players[1];
const rackSize = player.rack.length;
game.action(room, player.id, { action: 'draw' });

const ownView = game.roomView(room, player.id);
const otherView = game.roomView(room, bot.id);
assert.equal(player.rack.length, rackSize + 1);
assert.ok(ownView.lastDrawTileId);
assert.equal(ownView.you.rack.some((tile) => tile.id === ownView.lastDrawTileId), true);
assert.equal(otherView.lastDrawTileId, null);

game.rooms.clear();
game.configureGameRuntime({ durable: false });
console.log('last draw smoke tests: passed');