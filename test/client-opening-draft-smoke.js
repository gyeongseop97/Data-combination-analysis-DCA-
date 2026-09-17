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

function extractAsyncFunction(name, nextName) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`async function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `could not extract ${name}`);
  return source.slice(start, end);
}

const initialDraft = {
  groups: [{ id: 'draft-low', type: 'run', existing: false, tiles: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] }],
  rack: [{ id: 'b13' }],
};

const sandbox = {};
vm.runInNewContext(`
  let draft = ${JSON.stringify(initialDraft)};
  let baselineSignature = 'opening-baseline';
  let draftTurnKey = 'turn-one';
  let state = { turn: { isYourTurn: true, deadlineAt: 'turn-one' } };
  let selected = { tileId: 'r1' };
  let clientId = 'opening-test-client';
  let activeRoomCode = 'ABC123';
  let toastMessage = '';
  function isDraftDirty() { return true; }
  function sortDraftMelds() {}
  function isStatelessSolo() { return false; }
  async function api() {
    draft = { groups: [], rack: [] };
    throw new Error('첫 등록은 내 손패만으로 30점 이상이어야 합니다. (현재 06점)');
  }
  function clearBatchSelection() {}
  function syncDraftStatus() {}
  function render() {}
  function showToast(message) { toastMessage = message; }
  ${extractFunction('cloneTile', 'knownTileFace')}
  ${extractFunction('cloneDraftModel', 'hydrateDraft')}
  ${extractAsyncFunction('submitTurn', 'drawTile')}
  globalThis.finish = async () => {
    await submitTurn();
    return { draft, baselineSignature, draftTurnKey, selected, toastMessage };
  };
`, sandbox);

(async () => {
  const result = await sandbox.finish();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result.draft)), initialDraft);
  assert.equal(result.baselineSignature, 'opening-baseline');
  assert.equal(result.draftTurnKey, 'turn-one');
  assert.equal(result.selected, null);
  assert.match(result.toastMessage, /현재 06점/);
  console.log('client opening draft recovery smoke tests: passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});