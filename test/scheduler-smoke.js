const assert = require('assert');
const { Client } = require('@upstash/qstash');
const requests = [];
Client.prototype.publishJSON = async function (request) {
  assert.match(request.label, /^[A-Za-z0-9_.-]+$/, 'QStash labels must not contain colons');
  requests.push(request);
  return { messageId: 'test' };
};
process.env.QSTASH_TOKEN='test';
process.env.QSTASH_CURRENT_SIGNING_KEY='test';
process.env.QSTASH_NEXT_SIGNING_KEY='test';
process.env.DCA_APP_ORIGIN='https://example.test';
const scheduler = require('../lib/scheduler');
(async () => {
 const room={code:'ABC123',phase:'playing',deadlineAt:Date.now()+30000,revision:1};
 const results=await scheduler.scheduleRoomTasks(room,{});
 assert.equal(results[0].status,'fulfilled');
 await scheduler.scheduleTask(room,'departure',Date.now()+8000,{playerId:'host'});
 assert.equal(requests.length,2);
 assert.equal(requests[1].body.kind,'departure');
 assert.equal(requests[1].body.playerId,'host');
 console.log('scheduler turn and departure requests: passed');
})().catch(error=>{console.error(error);process.exitCode=1;});