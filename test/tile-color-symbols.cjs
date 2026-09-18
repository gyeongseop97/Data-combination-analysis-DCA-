const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(process.env.DCA_PLAYWRIGHT_MODULE || 'playwright-core');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(os.tmpdir(), 'dca-tile-color-symbols');
const harness = `
globalThis.colorSymbolAudit = {
  seed(options = {}) {
    localStorage.clear();
    localStorage.setItem(THEME_KEY, options.theme || 'classic');
    rackOrderCache.clear();
    const tile = (id, color, value) => ({ id, kind: 'number', color, value });
    const palette = ['red', 'blue', 'orange', 'black'];
    const rack = [
      ...palette.flatMap(color => [1, 10, 13].map(value => tile('r-' + color + '-' + value, color, value))),
      { id: 'rack-joker', kind: 'joker' },
      ...[7, 8, 9].map(value => tile('hold-' + value, 'red', value))
    ];
    const board = Array.from({ length: options.count || 9 }, (_, index) => {
      const color = palette[index % 4];
      const start = index % 2 ? 11 : 1;
      return { id: 'g' + index, type: 'run', tiles: [0, 1, 2].map(offset => tile('b' + index + '-' + offset, color, start + offset)) };
    });
    board[0].tiles = [tile('board-7', 'red', 7), { id: 'board-joker', kind: 'joker', resolvedFace: { color: 'red', value: 8 } }, tile('board-9', 'red', 9)];
    const now = Date.now();
    activeRoomCode = 'SYMB01';
    state = {
      room: { code: 'SYMB01', name: '색상 기호 확인', phase: 'playing', mode: 'multiplayer', turnSeconds: 180, players: [
        { id: 'me', name: '나', isYou: true, isActive: true, tileCount: rack.length, hasOpened: true },
        { id: 'other', name: '상대', isYou: false, isActive: false, tileCount: 14, hasOpened: true }
      ] },
      you: { id: 'me', name: '나', rack, hasOpened: true }, board,
      turn: { isYourTurn: true, activePlayerId: 'me', deadlineAt: now + 180000 },
      serverNow: now, poolCount: 30,
      recentSubmissions: [{ player: { id: 'other' }, tiles: board[1].tiles }],
      lastDrawTileId: 'r-orange-10', log: [], chatMessages: []
    };
    soloSessionToken = '';
    turnActionInFlight = false;
    clearTimeout(draftSyncTimer);
    clearTimeout(toastTimer);
    toast.className = 'toast';
    selected = null;
    batchSelection = null;
    lastDragAt = 0;
    suppressTileClickUntil = 0;
    hydrateDraft();
    render();
  },
  stopSync() { clearTimeout(draftSyncTimer); },
  get draft() { return draft; }
};`;
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert(app.includes('\ninit();'), 'cannot intercept app startup');
const source = app.replace('\ninit();', '\n' + harness);
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.DCA_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://tile-symbols.test/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: source });
    if (pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (pathname.startsWith('/api/')) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Browser fixture: no server mutation' }) });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  async function seed(theme, count = 9) {
    await page.evaluate(options => colorSymbolAudit.seed(options), { theme, count });
    await page.locator('.board-grid').waitFor();
    await page.waitForTimeout(200);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function measure() {
    return page.evaluate(() => {
      const board = document.querySelector('.board-grid');
      const boardRect = board.getBoundingClientRect();
      const shapeByColor = {};
      const inkByColor = {};
      const problems = [];
      const normals = [...document.querySelectorAll('.board-grid .tile:not(.joker), .rack-tiles .tile:not(.joker)')];
      const colorNames = { red: '빨강', blue: '파랑', orange: '주황', black: '검정' };
      const rectInside = (a, b) => a.left >= b.left - .5 && a.top >= b.top - .5 && a.right <= b.right + .5 && a.bottom <= b.bottom + .5;
      const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .2;
      for (const tile of normals) {
        const color = Object.keys(colorNames).find(name => tile.classList.contains(name));
        const label = tile.getAttribute('aria-label');
        const prefix = color + ' ' + tile.querySelector('b')?.textContent + ' ' + (tile.closest('.board-grid') ? 'board' : 'rack');
        const symbols = tile.querySelectorAll('svg.tile-color-symbol');
        if (symbols.length !== 1) { problems.push(prefix + ': expected one symbol, got ' + symbols.length); continue; }
        const symbol = symbols[0];
        const b = tile.querySelector('b');
        const s = symbol.getBoundingClientRect();
        const n = b.getBoundingClientRect();
        const t = tile.getBoundingClientRect();
        const style = getComputedStyle(symbol);
        const numberColor = getComputedStyle(b).color;
        if (style.color !== numberColor || style.fill !== numberColor) problems.push(prefix + ': symbol color/fill does not match number');
        if ([...symbol.children].some(shape => getComputedStyle(shape).fill !== numberColor)) problems.push(prefix + ': painted shape does not match number color');
        if (symbol.getAttribute('aria-hidden') !== 'true') problems.push(prefix + ': decorative symbol exposed');
        if (symbol.getAttribute('data-color-symbol') !== color) problems.push(prefix + ': symbol/color mismatch');
        if (!label.includes(colorNames[color])) problems.push(prefix + ': accessible name lacks color');
        if (s.width <= 1 || s.height <= 1 || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) problems.push(prefix + ': symbol not visible');
        if (!rectInside(s, t)) problems.push(prefix + ': symbol clipped');
        if (!rectInside(n, t)) problems.push(prefix + ': number clipped');
        if (s.right > n.left + .25 || intersects(s, n)) problems.push(prefix + ': symbol overlaps/is not left of number');
        if (tile.closest('.board-grid') && !rectInside(t, boardRect)) problems.push(prefix + ': board tile clipped');
        const oldMarker = tile.querySelector('i');
        if (oldMarker && getComputedStyle(oldMarker).display !== 'none' && intersects(s, oldMarker.getBoundingClientRect())) problems.push(prefix + ': legacy marker overlaps symbol');
        const shape = symbol.innerHTML.trim();
        if (shapeByColor[color] && shapeByColor[color] !== shape) problems.push(prefix + ': inconsistent shape');
        shapeByColor[color] = shape;
        inkByColor[color] = getComputedStyle(tile).color;
      }
      const jokers = [...document.querySelectorAll('.board-grid .tile.joker, .rack-tiles .tile.joker')];
      for (const joker of jokers) {
        if (joker.querySelector('.tile-color-symbol')) problems.push('joker: ordinary symbol should not replace its star');
        if (joker.querySelector('b')?.textContent !== '★') problems.push('joker: star missing');
        if (!joker.getAttribute('aria-label').includes('조커')) problems.push('joker: accessible name missing');
      }
      const resolved = document.querySelector('.board-grid .tile.joker');
      if (!resolved.getAttribute('aria-label').includes('8') || !resolved.getAttribute('aria-label').includes('빨강')) problems.push('resolved joker: represented value/color missing');
      return {
        normalCount: normals.length, jokerCount: jokers.length,
        shapeCount: new Set(Object.values(shapeByColor)).size,
        colorCount: new Set(Object.values(inkByColor)).size,
        rows: new Set([...board.querySelectorAll('.meld')].map(el => Math.round(el.getBoundingClientRect().top))).size,
        density: board.dataset.boardDensity, scale: Number(board.style.getPropertyValue('--board-scale') || 1),
        overflowX: board.scrollWidth - board.clientWidth, overflowY: board.scrollHeight - board.clientHeight,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        problems
      };
    });
  }
  function check(result, label, count) {
    assert.equal(result.normalCount, count * 3 - 1 + 15, label + ': normal tile count');
    assert.equal(result.jokerCount, 2, label + ': joker count');
    assert.equal(result.shapeCount, 4, label + ': colors need four distinct shapes');
    assert.equal(result.colorCount, 4, label + ': colors should remain distinct');
    assert(result.overflowX <= 1 && result.overflowY <= 1 && result.pageOverflow <= 1, label + ': overflow');
    assert.deepEqual(result.problems, [], label + ': geometry or accessibility problems');
  }
  async function longPress(theme, mobile, source) {
    const selector = source === 'rack' ? '.rack-tiles [data-tile-id="hold-7"]' : '.board-grid [data-tile-id="board-7"]';
    const anchor = page.locator(selector);
    await anchor.scrollIntoViewIfNeeded();
    const box = await anchor.boundingBox();
    if (mobile) {
      await anchor.evaluate(el => {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 101, isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      });
    } else {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
    }
    await page.waitForFunction(() => /3/.test(document.querySelector('.hold-selection-bubble')?.textContent || ''));
    assert.equal(await page.locator((source === 'rack' ? '.rack-tiles' : '.board-grid') + ' .batch-selected').count(), 3, theme + ': long press count');
    if (mobile) {
      await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 101, isPrimary: true })));
    } else await page.mouse.up();
  }
  try {
    await page.goto('https://tile-symbols.test/');
    for (const theme of ['classic', 'sheet']) {
      for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844], [844, 390], [320, 568]]) {
        await page.setViewportSize({ width, height });
        for (const count of [9, 32]) {
          await seed(theme, count);
          const result = await measure();
          const label = theme + ' ' + width + 'x' + height + ' ' + count + ' melds';
          check(result, label, count);
          assert(result.rows >= 2, label + ': board should wrap into rows');
          if (width >= 1280 && count === 9) assert.equal(result.density, 'normal', label + ': premature shrinking');
          console.log('PASS', label, JSON.stringify(result));
          if ((width === 1280 || width === 390 || width === 844) && count === 9) await page.screenshot({ path: path.join(outputDir, theme + '-' + width + '.png') });
        }
        if (width === 1280 || width === 390) {
          await seed(theme);
          await longPress(theme, width < 1000, 'rack');
          await seed(theme);
          await longPress(theme, width < 1000, 'board');
          console.log('PASS', theme, width, 'rack and board long press including resolved joker');
        }
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      await seed(theme);
      const drag = await page.evaluate(() => {
        const from = document.querySelector('.rack-tiles [data-tile-id="r-red-1"]');
        const symbol = from.querySelector('.tile-color-symbol');
        const target = document.querySelector('.board-grid [data-tile-id="b2-0"]');
        const targetGroup = target.dataset.groupId;
        const transfer = new DataTransfer();
        symbol.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        const r = target.getBoundingClientRect();
        const event = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: r.left + 1, clientY: r.top + r.height / 2 };
        target.dispatchEvent(new DragEvent('dragover', event));
        target.dispatchEvent(new DragEvent('drop', event));
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
        colorSymbolAudit.stopSync();
        return colorSymbolAudit.draft.groups.find(group => group.id === targetGroup).tiles.some(tile => tile.id === 'r-red-1');
      });
      assert(drag, theme + ': drag bubbling from symbol no longer works');
      console.log('PASS', theme, 'rack-to-board drag originating at symbol');
    }
    assert.deepEqual(errors, [], 'browser runtime errors');
    console.log('PASS tile color symbols: four shapes, visible/non-overlapping faces, jokers, responsive boards and interactions');
    console.log('Screenshots:', outputDir);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
