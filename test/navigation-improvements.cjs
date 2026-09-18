const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require(process.env.DCA_PLAYWRIGHT_MODULE || 'playwright-core');
const engine = require('../server');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
  + '\nglobalThis.navAudit = { refreshRoomState, get state() { return state; } };';
const server = http.createServer((request, response) => {
  if (request.url === '/app.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(appSource);
    return;
  }
  for (const room of engine.rooms.values()) engine.advanceRoom(room);
  engine.server.emit('request', request, response);
});

function routeMatches(url, view, code) {
  const parsed = new URL(url);
  if (!view) return parsed.search === '';
  return parsed.searchParams.get('view') === view && parsed.searchParams.get('room') === code;
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch({ channel: process.env.DCA_BROWSER_CHANNEL || 'chrome', headless: true });
  const errors = [];
  try {
    async function pageAt(url = base) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      return page;
    }
    async function expectRoute(page, view, code) {
      await page.waitForFunction(({ view, code }) => {
        const parsed = new URL(location.href);
        return view
          ? parsed.searchParams.get('view') === view && parsed.searchParams.get('room') === code
          : parsed.search === '';
      }, { view, code: code || null });
      assert(routeMatches(page.url(), view, code), 'unexpected URL: ' + page.url());
    }
    async function createRoom(page, name) {
      await page.locator('#createRoomForm [name="playerName"]').fill(name);
      await page.locator('#createRoomForm button[type="submit"]').click();
      await page.locator('.lobby-page').waitFor();
      const code = (await page.locator('.invite-box strong').innerText()).trim();
      assert.match(code, /^[A-Z0-9]{6}$/);
      await expectRoute(page, 'lobby', code);
      return code;
    }

    const host = await pageAt();
    await host.locator('#createRoomForm').waitFor();
    await expectRoute(host, null, null);
    const firstCode = await createRoom(host, 'Back host');
    const firstLeave = host.waitForRequest(request =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/rooms/' + firstCode + '/leave'
    );
    await host.goBack();
    await firstLeave;
    await host.locator('#createRoomForm').waitFor();
    await expectRoute(host, null, null);
    await host.waitForFunction(code => !window.__roomExists?.(code), firstCode).catch(() => {});
    for (let attempt = 0; attempt < 30 && engine.rooms.has(firstCode); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(engine.rooms.has(firstCode), false, 'host Back did not remove the room');
    console.log('PASS lobby Back returns home and sends room leave');

    const code = await createRoom(host, 'Route host');
    const guest = await pageAt(base + '?room=' + code);
    await guest.locator('#joinRoomForm').waitFor();
    assert.equal(await guest.locator('#joinRoomForm [name="code"]').inputValue(), code, 'invite link did not prefill room code');
    await guest.locator('#joinRoomForm [name="playerName"]').fill('Invite guest');
    await guest.locator('#joinRoomForm button[type="submit"]').click();
    await guest.locator('.lobby-page').waitFor();
    await expectRoute(guest, 'lobby', code);
    assert.equal(engine.rooms.get(code).players.length, 2, 'invite join did not add guest');
    console.log('PASS direct invitation link joins the correct lobby');

    await guest.reload();
    await guest.locator('.lobby-page').waitFor();
    await expectRoute(guest, 'lobby', code);
    await host.reload();
    await host.locator('.lobby-page').waitFor();
    await expectRoute(host, 'lobby', code);
    assert.equal(engine.rooms.get(code).players.length, 2, 'reload duplicated or removed a player');
    console.log('PASS lobby refresh restores host and guest');

    await host.locator('[data-action="start-game"]').click();
    await host.locator('.game-page').waitFor();
    await expectRoute(host, 'game', code);
    await guest.evaluate(() => navAudit.refreshRoomState());
    await guest.locator('.game-page').waitFor();
    await expectRoute(guest, 'game', code);
    await host.reload();
    await host.locator('.game-page').waitFor();
    await expectRoute(host, 'game', code);
    console.log('PASS lobby to game URL and game refresh restore');

    const room = engine.rooms.get(code);
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.phase = 'finished';
    room.deadlineAt = null;
    room.result = {
      reason: 'empty-rack',
      winnerIds: [room.hostId],
      scores: room.players.map(player => ({
        id: player.id, name: player.name, tilesLeft: player.rack.length,
        tileTotal: 0, score: player.id === room.hostId ? 0 : 0
      }))
    };
    await host.evaluate(() => navAudit.refreshRoomState());
    await guest.evaluate(() => navAudit.refreshRoomState());
    await host.locator('.result-overlay').waitFor();
    await guest.locator('.result-overlay').waitFor();
    await expectRoute(host, 'result', code);
    await expectRoute(guest, 'result', code);
    console.log('PASS game to result URL');

    const resultLeave = guest.waitForRequest(request =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/rooms/' + code + '/leave'
    );
    await guest.goBack();
    await resultLeave;
    await guest.locator('#createRoomForm').waitFor();
    await expectRoute(guest, null, null);
    console.log('PASS result Back returns home and sends room leave');

    assert.deepEqual(errors, [], 'browser runtime errors');
  } finally {
    await browser.close();
    for (const room of engine.rooms.values()) {
      clearTimeout(room.turnTimer);
      clearTimeout(room.aiTimer);
    }
    engine.rooms.clear();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exit(1); });
