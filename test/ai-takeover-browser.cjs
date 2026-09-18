const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require(process.env.DCA_PLAYWRIGHT_MODULE || 'playwright-core');
const engine = require('../server');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
  + '\nglobalThis.takeoverAudit = { refreshRoomState, get state() { return state; }, get draft() { return draft; } };';
const server = http.createServer((request, response) => {
  if (request.url === '/app.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(appSource);
    return;
  }
  for (const room of engine.rooms.values()) engine.advanceRoom(room);
  engine.server.emit('request', request, response);
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch({ channel: process.env.DCA_BROWSER_CHANNEL || 'chrome', headless: true });
  const errors = [];
  try {
    async function fresh() {
      const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.locator('#createRoomForm').waitFor();
      return page;
    }
    async function pair(label) {
      const host = await fresh();
      const guest = await fresh();
      await host.locator('#createRoomForm [name="playerName"]').fill(label + ' host');
      await host.locator('#createRoomForm [name="maxPlayers"]').selectOption('2');
      await host.locator('#createRoomForm [name="turnSeconds"]').selectOption('120');
      await host.locator('#createRoomForm button[type="submit"]').click();
      await host.locator('.lobby-page').waitFor();
      const code = (await host.locator('.invite-box strong').innerText()).trim();
      await guest.locator('#joinRoomForm [name="playerName"]').fill(label + ' guest');
      await guest.locator('#joinRoomForm [name="code"]').fill(code);
      await guest.locator('#joinRoomForm button[type="submit"]').click();
      await guest.locator('.lobby-page').waitFor();
      await host.waitForFunction(() => takeoverAudit.state.room.players.length === 2);
      await host.locator('[data-action="start-game"]').click();
      await host.locator('.game-page').waitFor();
      await guest.locator('.game-page').waitFor();
      return { host, guest, code, room: engine.rooms.get(code) };
    }
    async function expectTakeover(page, departedName) {
      await page.locator('[data-forfeit-notice]').waitFor();
      assert.match(await page.locator('[data-forfeit-notice]').innerText(), /몰수승/);
      await page.waitForFunction(name => {
        const snapshot = takeoverAudit.state;
        return snapshot.room.players.some(player => player.isBot && player.replacedPlayerName === name);
      }, departedName);
      assert.equal(await page.locator('.game-page').count(), 1, 'remaining player left the game');
      assert.equal(await page.locator('.result-overlay').count(), 0, 'AI continuation was blocked by result overlay');
      assert.equal(await page.evaluate(() => takeoverAudit.state.room.phase), 'playing');
      assert.match(await page.locator('#toast').innerText(), /나갔|퇴장/);
    }
    async function expectWinAtHome(page) {
      await page.locator('.game-home-button').click();
      await page.locator('#createRoomForm').waitFor();
      await page.locator('[data-forfeit-history]').waitFor();
      assert.match(await page.locator('[data-forfeit-history]').innerText(), /몰수승/);
      await page.reload();
      await page.locator('[data-forfeit-history]').waitFor();
      assert.match(await page.locator('[data-forfeit-history]').innerText(), /몰수승/);
      assert.equal(await page.locator('.game-page').count(), 0, 'reload reopened the abandoned AI game');
      assert.equal(new URL(page.url()).search, '', 'home kept a game URL');
    }

    const first = await pair('Draft');
    const firstHost = first.room.players.find(player => player.name === 'Draft host');
    const firstGuest = first.room.players.find(player => player.name === 'Draft guest');
    clearTimeout(first.room.turnTimer);
    first.room.turnTimer = null;
    first.room.activeIndex = first.room.players.indexOf(firstHost);
    first.room.deadlineAt = Date.now() + 120000;
    first.room.turnDirty = false;
    first.room.board = [];
    firstHost.rack = ['n-red-10-1', 'n-red-11-1', 'n-red-12-1', 'n-orange-2-1'];
    firstGuest.rack = ['n-blue-1-1', 'n-blue-4-1', 'n-blue-7-1'];
    const dealt = new Set(first.room.players.flatMap(player => player.rack));
    first.room.deck = engine.ALL_TILE_IDS.filter(id => !dealt.has(id));
    await first.host.evaluate(() => takeoverAudit.refreshRoomState());
    await first.guest.evaluate(() => takeoverAudit.refreshRoomState());
    await first.host.locator('.rack-tiles [data-tile-id="n-red-10-1"]').click();
    await first.host.locator('[data-action="new-group"]').click();
    const draftBefore = await first.host.evaluate(() => JSON.stringify(takeoverAudit.draft));
    await first.guest.locator('.game-home-button').click();
    await first.guest.locator('#createRoomForm').waitFor();
    // Normal server push/poll must deliver the departure without manual refresh.
    await expectTakeover(first.host, 'Draft guest');
    assert.equal(await first.host.evaluate(() => JSON.stringify(takeoverAudit.draft)), draftBefore, 'opponent departure discarded the current draft');
    const firstResult = await first.host.evaluate(() => takeoverAudit.state.forfeitResult);
    assert(firstResult.winnerIds.includes(firstHost.id), 'remaining player was not awarded the forfeit');
    assert.equal(first.room.players.length, 2);
    assert.equal(first.room.players.filter(player => player.isBot).length, 1);
    console.log('PASS guest departure automatically announces AI takeover, preserves active draft, and confirms win');

    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await first.host.setViewportSize(viewport);
      for (const theme of ['classic', 'sheet']) {
        if (await first.host.locator('body').getAttribute('data-theme') !== theme) {
          await first.host.locator('.game-theme-button').click();
        }
        await first.host.waitForTimeout(150);
        const layout = await first.host.evaluate(() => {
          const board = document.querySelector('.board-grid').getBoundingClientRect();
          const notice = document.querySelector('[data-forfeit-notice]').getBoundingClientRect();
          return { boardHeight: board.height, boardBottom: board.bottom, noticeHeight: notice.height, scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight };
        });
        assert(layout.boardHeight > 70, 'departure notice left no usable board: ' + JSON.stringify(layout));
        assert(layout.boardBottom <= layout.viewportHeight + 2, 'board extended below mobile viewport: ' + JSON.stringify(layout));
        assert(layout.scrollWidth <= layout.viewportWidth + 2, 'departure notice caused horizontal overflow: ' + JSON.stringify(layout));
        assert(layout.noticeHeight < 90, 'departure notice is too tall on mobile: ' + JSON.stringify(layout));
        const screenshotPath = path.join(process.env.TEMP || process.cwd(), 'dca-ai-takeover-' + viewport.width + 'x' + viewport.height + '-' + theme + '.png');
        await first.host.screenshot({ path: screenshotPath });
        console.log('SCREENSHOT ' + screenshotPath);
      }
    }
    console.log('PASS permanent win notice fits both mobile orientations and themes');

    await first.host.setViewportSize({ width: 1100, height: 760 });
    await first.host.locator('[data-action="undo-draft"]').click();
    const botBefore = first.room.players.find(player => player.isBot).rack.length;
    await first.host.locator('[data-action="draw-tile"]').click();
    await first.host.waitForFunction(count => takeoverAudit.state.turn.isYourTurn && takeoverAudit.state.room.players.some(player => player.isBot && player.tileCount === count), botBefore + 1);
    assert.equal(first.room.players.find(player => player.isBot).rack.length, botBefore + 1, 'replacement AI did not execute its turn');
    assert.deepEqual(await first.host.evaluate(() => takeoverAudit.state.forfeitResult), firstResult, 'AI play changed the confirmed forfeit');
    await expectWinAtHome(first.host);
    assert.equal(engine.rooms.has(first.code), false, 'AI-only room remained after the final human left');
    console.log('PASS replacement AI executes a turn and human can leave with win retained through reload');

    const second = await pair('Owner');
    const secondHost = second.room.players.find(player => player.name === 'Owner host');
    const secondGuest = second.room.players.find(player => player.name === 'Owner guest');
    clearTimeout(second.room.turnTimer);
    second.room.turnTimer = null;
    second.room.activeIndex = second.room.players.indexOf(secondHost);
    second.room.deadlineAt = Date.now() + 120000;
    second.room.turnDirty = false;
    secondHost.rack = ['n-black-1-1', 'n-black-4-1', 'n-black-7-1'];
    const secondDealt = new Set(second.room.players.flatMap(player => player.rack));
    second.room.deck = engine.ALL_TILE_IDS.filter(id => !secondDealt.has(id));
    await second.host.evaluate(() => takeoverAudit.refreshRoomState());
    await second.guest.evaluate(() => takeoverAudit.refreshRoomState());
    await second.host.locator('.game-home-button').click();
    await second.host.locator('#createRoomForm').waitFor();
    await expectTakeover(second.guest, 'Owner host');
    await second.guest.waitForFunction(() => takeoverAudit.state.turn.isYourTurn);
    assert.equal(second.room.hostId, secondGuest.id, 'room ownership did not pass to remaining human');
    const secondResult = await second.guest.evaluate(() => takeoverAudit.state.forfeitResult);
    assert(secondResult.winnerIds.includes(secondGuest.id));
    await expectWinAtHome(second.guest);
    assert.equal(engine.rooms.has(second.code), false);
    console.log('PASS active host departure transfers room, runs replacement AI, and retains guest victory');
    const third = await pair('Disconnect');
    const thirdHost = third.room.players.find(player => player.name === 'Disconnect host');
    clearTimeout(third.room.turnTimer);
    third.room.turnTimer = null;
    third.room.activeIndex = third.room.players.indexOf(thirdHost);
    third.room.deadlineAt = Date.now() + 120000;
    await third.host.evaluate(() => takeoverAudit.refreshRoomState());
    await third.guest.reload();
    await third.guest.locator('.game-page').waitFor();
    assert.equal(third.room.forfeitResult, null, 'a normal reload forfeited the game');
    await third.guest.goto('about:blank');
    await third.host.waitForFunction(() => Boolean(takeoverAudit.state?.forfeitResult), null, { timeout: 20000 });
    await expectTakeover(third.host, 'Disconnect guest');
    await expectWinAtHome(third.host);
    assert.equal(engine.rooms.has(third.code), false);
    console.log('PASS normal reload reconnects, while navigation away expires into automatic AI takeover');
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