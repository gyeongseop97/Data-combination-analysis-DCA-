const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.DCA_PLAYWRIGHT_MODULE || 'playwright-core');

const root = path.resolve(__dirname, '..');
const harness = `
globalThis.rackSortAudit = {
  seed(themeName) {
    localStorage.clear();
    rackOrderCache.clear();
    localStorage.setItem(THEME_KEY, themeName);
    activeRoomCode = 'SORT01';
    soloSessionToken = 'test-token';
    globalThis.turnActionInFlight = false;
    lastDragAt = 0;
    suppressTileClickUntil = 0;
    const tile = (id, color, value) => ({ id, kind: 'number', color, value });
    const rack = [tile('b7', 'blue', 7), tile('r9', 'red', 9), tile('o1', 'orange', 1), tile('k7', 'black', 7), tile('r7', 'red', 7), tile('r8', 'red', 8), tile('r4', 'red', 4)];
    const now = Date.now();
    const next = {
      room: { code: 'SORT01', phase: 'playing', mode: 'solo', turnSeconds: 60, players: [
        { id: 'me', name: '나', isYou: true, isActive: false, tileCount: rack.length, hasOpened: true },
        { id: 'ai', name: 'AI', isBot: true, isActive: true, tileCount: 14, hasOpened: true }
      ] },
      you: { id: 'me', name: '나', rack, hasOpened: true },
      board: [{ id: 'g1', type: 'run', tiles: [tile('r5b', 'red', 5), tile('r6b', 'red', 6), tile('r7b', 'red', 7)] }],
      turn: { isYourTurn: false, activePlayerId: 'ai', deadlineAt: now + 60000 },
      serverNow: now, poolCount: 30, recentSubmissions: [], log: []
    };
    state = null;
    draft = null;
    receiveState(next);
  },
  update(ownTurn = false) {
    const next = structuredClone(state);
    next.serverNow = Date.now();
    next.poolCount -= 1;
    next.room.players[1].tileCount += 1;
    next.log.unshift({ text: '상대가 패를 뽑았습니다.' });
    if (ownTurn) {
      next.turn = { isYourTurn: true, activePlayerId: 'me', deadlineAt: Date.now() + 60000 };
      next.room.players[0].isActive = true;
      next.room.players[1].isActive = false;
    }
    receiveState(next);
  },
  get draft() { return draft; },
  get state() { return state; }
};
`;
const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert(source.includes('\ninit();'), 'cannot intercept app startup');
const instrumented = source.replace('\ninit();', '\n' + harness);
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const sequenceOrder = ['r4', 'r7', 'r8', 'r9', 'b7', 'o1', 'k7'];
const groupOrder = ['o1', 'r4', 'r7', 'b7', 'k7', 'r8', 'r9'];

(async () => {
  const browser = await chromium.launch({ channel: process.env.DCA_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
  page.setDefaultTimeout(5000);
  const pageErrors = [];
  const actionRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('https://rack-sort.test/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: instrumented });
    if (pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (pathname.startsWith('/api/')) {
      actionRequests.push(route.request().postData());
      return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Unexpected action"}' });
    }
    return route.fulfill({ contentType: 'text/html', body: html });
  });

  const rackOrder = () => page.locator('.rack-tiles [data-tile-id]').evaluateAll(tiles => tiles.map(tile => tile.dataset.tileId));
  const boardOrder = () => page.locator('.board-grid .tile').evaluateAll(tiles => tiles.map(tile => tile.getAttribute('aria-label') || tile.textContent.trim()));
  const rackTile = id => '.rack-tiles [data-tile-id="' + id + '"]';
  async function desktopDrag(sourceId, targetSelector) {
    await page.evaluate(({ sourceId, targetSelector }) => {
      const source = document.querySelector('.rack-tiles [data-tile-id="' + sourceId + '"]');
      const target = document.querySelector(targetSelector);
      const rect = target.getBoundingClientRect();
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 2, clientY: rect.top + rect.height / 2 }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 2, clientY: rect.top + rect.height / 2 }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
    }, { sourceId, targetSelector });
  }
  async function touchDrag(sourceId, targetSelector, updateDuringDrag = false) {
    await page.evaluate(({ sourceId, targetSelector }) => {
      const source = document.querySelector('.rack-tiles [data-tile-id="' + sourceId + '"]');
      const sourceRect = source.getBoundingClientRect();
      const targetRect = document.querySelector(targetSelector).getBoundingClientRect();
      const event = (name, x, y) => new PointerEvent(name, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 101, isPrimary: true, clientX: x, clientY: y });
      source.dispatchEvent(event('pointerdown', sourceRect.left + sourceRect.width / 2, sourceRect.top + sourceRect.height / 2));
      document.dispatchEvent(event('pointermove', targetRect.left + 2, targetRect.top + targetRect.height / 2));
    }, { sourceId, targetSelector });
    if (updateDuringDrag) await page.evaluate(() => rackSortAudit.update());
    await page.evaluate(targetSelector => {
      const rect = document.querySelector(targetSelector).getBoundingClientRect();
      const event = name => new PointerEvent(name, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 101, isPrimary: true, clientX: rect.left + 2, clientY: rect.top + rect.height / 2 });
      document.dispatchEvent(event('pointermove'));
      document.dispatchEvent(event('pointerup'));
    }, targetSelector);
  }
  async function assertOpponentRestrictions() {
    assert(await page.locator('[data-action="draw-tile"]').isDisabled(), 'draw enabled during opponent turn');
    assert(await page.locator('[data-action="submit-turn"]').isDisabled(), 'submit enabled during opponent turn');
    assert.equal(await page.locator('.board-grid [data-drag-tile]').count(), 0, 'opponent board tiles are draggable');
    assert.equal(await page.locator('[data-action="new-group"]').count(), 0, 'new meld available during opponent turn');
  }

  try {
    await page.goto('https://rack-sort.test/');
    for (const theme of ['classic', 'sheet']) {
      await page.setViewportSize({ width: 1000, height: 760 });
      await page.evaluate(themeName => rackSortAudit.seed(themeName), theme);
      await assertOpponentRestrictions();
      for (const [mode, expected] of [['sequence', sequenceOrder], ['group', groupOrder]]) {
        const button = page.locator('[data-action="sort-rack"][data-sort="' + mode + '"]');
        assert(await button.isVisible() && await button.isEnabled(), theme + ' opponent sorting unavailable');
        await button.click();
        assert.deepEqual(await rackOrder(), expected, theme + ' ' + mode + ' sort order');
      }
      await desktopDrag('r9', rackTile('o1'));
      const reordered = ['r9', ...groupOrder.filter(id => id !== 'r9')];
      assert.deepEqual(await rackOrder(), reordered, theme + ' opponent desktop reorder failed');
      const originalBoard = await boardOrder();
      assert.equal(originalBoard.length, 3, 'board fixture must expose three readable tiles');
      await desktopDrag('r9', '.board-grid');
      assert.deepEqual(await rackOrder(), reordered, theme + ' opponent rack tile escaped to board');
      assert.deepEqual(await boardOrder(), originalBoard, theme + ' opponent board changed');
      await page.evaluate(() => rackSortAudit.update());
      assert.deepEqual(await rackOrder(), reordered, theme + ' poll reset rack order');
      await page.evaluate(() => rackSortAudit.update(true));
      assert.deepEqual(await rackOrder(), reordered, theme + ' next turn reset rack order');
      assert.deepEqual(await page.evaluate(() => rackSortAudit.draft.rack.map(tile => tile.id)), reordered, theme + ' next-turn draft order differs');
      assert(await page.locator('[data-action="draw-tile"]').isEnabled(), 'own turn did not regain actions');
      assert(await page.locator('[data-action="submit-turn"]').isDisabled(), 'rack ordering incorrectly made a board draft dirty');
      console.log('PASS ' + theme + ' opponent sorting, desktop drag, board restrictions, polling, next-turn order');

      for (const [width, height] of [[390, 844], [844, 390]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(themeName => rackSortAudit.seed(themeName), theme);
        await page.locator('[data-action="sort-rack"][data-sort="group"]').click();
        await touchDrag('r9', rackTile('o1'), true);
        assert.deepEqual(await rackOrder(), reordered, theme + ' mobile touch reorder/poll failed at ' + width + 'x' + height);
        await touchDrag('r9', '.board-grid');
        assert.deepEqual(await rackOrder(), reordered, theme + ' mobile opponent tile escaped to board');
        assert.deepEqual(await boardOrder(), originalBoard, theme + ' mobile opponent board changed');
        await assertOpponentRestrictions();
        await page.evaluate(() => rackSortAudit.update(true));
        assert.deepEqual(await rackOrder(), reordered, theme + ' mobile next turn reset rack order');
        console.log('PASS ' + theme + ' ' + width + 'x' + height + ' touch sorting across polling and turn transition');
      }
    }
    assert.deepEqual(actionRequests, [], 'local sorting sent a game action request');
    assert.deepEqual(pageErrors, [], 'browser runtime errors');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });