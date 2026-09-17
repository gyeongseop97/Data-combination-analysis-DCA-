const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extractFunction(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `could not extract ${name}`);
  return source.slice(start, end);
}

const sandbox = {};
vm.runInNewContext([
  extractFunction('knownTileFace', 'inferredMeldType'),
  extractFunction('compatibleTileIds', 'rackConsecutiveTileIds'),
  'globalThis.compatibleTileIds = compatibleTileIds;',
].join('\n'), sandbox);

function numberTile(id, color, value) {
  return { id, kind: 'number', color, value };
}

function compatibleIds(tiles, anchorId) {
  return Array.from(sandbox.compatibleTileIds(tiles, anchorId));
}

assert.deepStrictEqual(
  compatibleIds([numberTile('r6', 'red', 6), numberTile('r7', 'red', 7)], 'r6'),
  ['r6', 'r7'],
);
assert.deepStrictEqual(
  compatibleIds([numberTile('r7', 'red', 7), numberTile('b7', 'blue', 7)], 'r7'),
  ['r7', 'b7'],
);
assert.deepStrictEqual(
  compatibleIds([numberTile('r7', 'red', 7), numberTile('b7', 'blue', 7), numberTile('k7', 'black', 7)], 'r7'),
  ['r7', 'b7', 'k7'],
);
assert.deepStrictEqual(
  compatibleIds([numberTile('r6', 'red', 6), numberTile('r7', 'red', 7), numberTile('r8', 'red', 8)], 'r6'),
  ['r6', 'r7', 'r8'],
);

const holdSource = source.slice(source.indexOf('function beginTileHold('), source.indexOf('function cloneDraftModel('));
assert.match(holdSource, /pointerType: event\.pointerType,/);
assert.match(holdSource, /tileHold\.selectedCount = Math\.min\(2, tileHold\.tileIds\.length\);/);
assert.match(source, /const TOUCH_HOLD_MOVE_TOLERANCE = 20;/);

console.log('client long-press smoke tests: passed');