const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const game = require('../server');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const functions = source.slice(source.indexOf('function knownTileFace('), source.indexOf('function rackOrderKey('));
const movement = source.slice(source.indexOf('function findDraftTile('), source.indexOf('function compareRackTiles('));
const sandbox = { colors: ['red','blue','orange','black'], draft: null, state: {turn:{isYourTurn:true},you:{hasOpened:true},board:[]}, rememberRackOrder(){},afterDraftChange(){},showToast(message){throw Error(message);} };
vm.createContext(sandbox);
vm.runInContext(functions + movement, sandbox);
const tile = (value,color='red') => ({id:`n-${color}-${value}-1`,kind:'number',value,color});
const joker = (value=9) => ({id:'j-1',kind:'joker',resolvedFace:{color:'red',value}});
const ids = group => Array.from(group.tiles,t=>t.id);
function compare(group, expected) {
 sandbox.sortDraftMeld(group);
 assert.deepStrictEqual(ids(group),expected);
 const details=game.validateMeld(ids(group));
 assert.deepStrictEqual(game.sortMeldTiles(ids(group),details),expected);
 for(const t of group.tiles.filter(t=>t.kind==='joker')) assert.deepStrictEqual(JSON.parse(JSON.stringify(t.resolvedFace)),details.jokerBindings[t.id]);
}
// A number fills a joker's old gap; the joker must move to the new end.
compare({type:'run',tiles:[tile(8),tile(9),joker(),tile(10)]},['n-red-8-1','n-red-9-1','n-red-10-1','j-1']);
// Explicitly place the joker at either end; the server must preserve that choice.
compare({type:'run',tiles:[joker(11),tile(8),tile(9),tile(10)]},['j-1','n-red-8-1','n-red-9-1','n-red-10-1']);
compare({type:'',tiles:[tile(10),joker(),tile(8)]},['n-red-8-1','j-1','n-red-10-1']);
compare({type:'run',tiles:[tile(12),tile(13),joker()]},['j-1','n-red-12-1','n-red-13-1']);
compare({type:'run',tiles:[tile(1),joker(),tile(3)]},['n-red-1-1','j-1','n-red-3-1']);
compare({type:'run',tiles:[tile(7,'red'),joker(),tile(7,'blue')]},['n-red-7-1','j-1','n-blue-7-1']);
const incomplete={type:'run',tiles:[tile(8),joker()]};sandbox.sortDraftMeld(incomplete);assert.equal(incomplete.tiles[1].resolvedFace,undefined);assert.equal(incomplete.type,'');
// Exercise the actual same-group drop path, including the previously blocked trailing zone.
const group={id:'g',type:'run',existing:true,tiles:[joker(7),tile(8),tile(9),tile(10)]};
sandbox.draft={groups:[group],rack:[tile(11)]};
assert(sandbox.moveDraftTile({source:'group',groupId:'g',tileId:'j-1'},{type:'group',groupId:'g'}));
assert.deepStrictEqual(ids(group),['n-red-8-1','n-red-9-1','n-red-10-1','j-1']);
assert(sandbox.moveDraftTile({source:'rack',tileId:'n-red-11-1'},{type:'group',groupId:'g',targetTileId:'j-1'}));
assert.deepStrictEqual(ids(group),['n-red-8-1','n-red-9-1','n-red-10-1','n-red-11-1','j-1']);
assert.equal(group.tiles.at(-1).resolvedFace.value,12);
assert.equal(sandbox.draft.rack.length,0);
console.log('joker insertion and repositioning smoke tests: passed');