const assert = require('assert');
const { Readable } = require('stream');

process.env.NODE_ENV = 'production';
process.env.DCA_SESSION_SECRET = 'solo-session-smoke-secret';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.QSTASH_TOKEN;
delete process.env.QSTASH_CURRENT_SIGNING_KEY;
delete process.env.QSTASH_NEXT_SIGNING_KEY;

const sessionHandler = require('../api/session');
const soloHandler = require('../api/solo');

function invoke(handler, { method = 'POST', body = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = Readable.from([JSON.stringify(body)]);
    request.method = method;
    request.headers = headers;
    request.url = '/';
    const response = {
      writeHead(status, responseHeaders) {
        this.status = status;
        this.headers = responseHeaders || {};
      },
      end(raw) {
        try {
          resolve({ status: this.status, headers: this.headers, body: JSON.parse(raw) });
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(handler(request, response)).catch(reject);
  });
}

async function run() {
  const session = await invoke(sessionHandler);
  assert.equal(session.status, 200);
  const cookie = session.headers['Set-Cookie'];
  assert.ok(cookie);

  const created = await invoke(soloHandler, {
    headers: { cookie },
    body: { action: 'create', playerName: '나', turnSeconds: 30 },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.state.room.mode, 'solo');
  assert.equal(created.body.state.turn.isYourTurn, true);
  assert.ok(created.body.token);

  const drawn = await invoke(soloHandler, {
    headers: { cookie },
    body: { action: 'action', token: created.body.token, payload: { action: 'draw' } },
  });
  assert.equal(drawn.status, 200);
  assert.equal(drawn.body.state.turn.isYourTurn, false);

  await new Promise((resolve) => setTimeout(resolve, 850));
  const advanced = await invoke(soloHandler, {
    headers: { cookie },
    body: { action: 'state', token: drawn.body.token },
  });
  assert.equal(advanced.status, 200);
  assert.equal(advanced.body.state.turn.isYourTurn, true);

  const tampered = await invoke(soloHandler, {
    headers: { cookie },
    body: { action: 'state', token: `${advanced.body.token}x` },
  });
  assert.equal(tampered.status, 401);
  console.log('stateless solo session smoke tests: passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});