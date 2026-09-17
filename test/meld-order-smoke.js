const assert = require('assert');
const game = require('../server');

function assertCanonicalOrder(tileIds, expected) {
  const details = game.validateMeld(tileIds);
  const sorted = game.sortMeldTiles(tileIds, details);
  assert.deepEqual(sorted, expected);
  assert.deepEqual(game.sortMeldTiles(sorted, details), expected);
}

assertCanonicalOrder(
  ['n-red-10-1', 'n-red-8-1', 'n-red-9-1'],
  ['n-red-8-1', 'n-red-9-1', 'n-red-10-1'],
);

assertCanonicalOrder(
  ['n-orange-7-1', 'n-black-7-1', 'n-red-7-1'],
  ['n-red-7-1', 'n-orange-7-1', 'n-black-7-1'],
);

assertCanonicalOrder(
  ['n-red-10-1', 'j-1', 'n-red-8-1'],
  ['n-red-8-1', 'j-1', 'n-red-10-1'],
);

console.log('meld order smoke tests: passed');