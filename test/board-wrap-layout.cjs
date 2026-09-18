
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(process.env.DCA_PLAYWRIGHT_MODULE || 'playwright-core');
const root = path.resolve(__dirname, '..');
const outputDir = path.join(os.tmpdir(), 'dca-board-wrap-layout');
const reportOnly = process.env.DCA_BOARD_LAYOUT_REPORT_ONLY === '1';
const harness = `
globalThis.boardWrapAudit = {
  seed(options = {}) {
    localStorage.setItem(THEME_KEY, options.theme || 'classic');
    const tile = (id, color, value) => ({ id, kind: 'number', color, value });
    const palette = ['red', 'blue', 'black', 'orange'];
    const size = options.longRuns ? 13 : 3;
    const board = Array.from({ length: options.count || 9 }, (_, index) => ({
      id: 'g' + index, type: 'run',
      tiles: Array.from({ length: size }, (_, offset) => tile('b' + index + '-' + offset, palette[index % 4], (options.longRuns ? 1 : index % 11 + 1) + offset))
    }));
    const rack = Array.from({ length: 14 }, (_, index) => tile('rack-' + index, palette[index % 4], index % 13 + 1));
    const activeId = options.ownTurn ? 'me' : 'other';
    const now = Date.now();
    activeRoomCode = 'WRAP01';
    state = {
      room: { code: 'WRAP01', name: '보드 줄바꿈 확인', phase: 'playing', mode: 'multiplayer', turnSeconds: 180, players: [
        { id: 'me', name: '나', isYou: true, isActive: activeId === 'me', tileCount: rack.length, hasOpened: true },
        { id: 'other', name: '상대', isYou: false, isActive: activeId === 'other', tileCount: 14, hasOpened: true }
      ] },
      you: { id: 'me', name: '나', rack, hasOpened: true }, board,
      turn: { isYourTurn: activeId === 'me', activePlayerId: activeId, deadlineAt: now + 180000 },
      serverNow: now, poolCount: 30, recentSubmissions: [], log: [], chatMessages: []
    };
    soloSessionToken = '';
    turnActionInFlight = false;
    selected = null;
    batchSelection = null;
    lastDragAt = 0;
    suppressTileClickUntil = 0;
    hydrateDraft();
    render();
  },
  get draft() { return draft; }
};`;
const appSource = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert(appSource.includes('\ninit();'), 'cannot intercept app startup');
const source = appSource.replace('\ninit();', '\n' + harness);
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.DCA_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const failures = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://board-wrap.test/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: source });
    if (pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (pathname.startsWith('/api/')) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Layout fixture: no server mutation' }) });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  const check = (condition, message) => {
    if (condition) return;
    if (!reportOnly) assert(condition, message);
    failures.push(message);
  };
  async function settle() {
    await page.waitForTimeout(220);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function seed(options) {
    await page.evaluate(value => boardWrapAudit.seed(value), options);
    await page.locator('.board-grid').waitFor();
    await settle();
  }
  async function measure() {
    return page.evaluate(() => {
      const board = document.querySelector('.board-grid');
      const rect = board.getBoundingClientRect();
      const children = [...board.querySelectorAll('.meld, .tile, .tile-target')];
      const clipped = children.filter(el => {
        const r = el.getBoundingClientRect();
        return r.left < rect.left - 1 || r.right > rect.right + 1 || r.top < rect.top - 1 || r.bottom > rect.bottom + 1;
      }).map(el => ({ className: el.className, text: el.textContent.trim().slice(0, 25) }));
      const rows = [...new Set([...board.querySelectorAll('.meld')].map(el => Math.round(el.getBoundingClientRect().top)))];
      const tile = board.querySelector('.tile');
      return {
        width: rect.width, height: rect.height, bottom: rect.bottom,
        density: board.dataset.boardDensity,
        scale: Number(board.style.getPropertyValue('--board-scale') || 1),
        rows: rows.length, tiles: board.querySelectorAll('.tile').length,
        tileWidth: tile?.getBoundingClientRect().width || 0,
        font: tile ? Number.parseFloat(getComputedStyle(tile).fontSize) : 0,
        overflowX: board.scrollWidth - board.clientWidth,
        overflowY: board.scrollHeight - board.clientHeight,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        clipped
      };
    });
  }
  function visible(result, label, tileCount) {
    check(result.height > 40 && result.width > 100, label + ': board collapsed');
    check(result.tiles === tileCount, label + ': unexpected tile count');
    check(result.overflowX <= 1 && result.overflowY <= 1, label + ': scroll overflow');
    check(result.pageOverflow <= 1, label + ': horizontal page overflow');
    check(result.clipped.length === 0, label + ': clipped tiles/melds ' + JSON.stringify(result.clipped));
  }
  try {
    await page.goto('https://board-wrap.test/');
    for (const theme of ['classic', 'sheet']) {
      for (const [width, height] of [[1920, 1080], [1280, 800]]) {
        await page.setViewportSize({ width, height });
        for (const ownTurn of [false, true]) {
          await seed({ theme, count: 9, ownTurn });
          const result = await measure();
          const label = theme + ' ' + width + 'x' + height + ' nine melds ' + (ownTurn ? 'own turn' : 'opponent turn');
          console.log(label, JSON.stringify(result));
          visible(result, label, 27);
          check(result.density === 'normal' && result.scale === 1, label + ': shrank despite free vertical space');
          check(result.rows >= 2, label + ': melds did not wrap to another row');
          check(result.font >= 12, label + ': desktop tile text unreadable');
          if (!ownTurn) await page.screenshot({ path: path.join(outputDir, theme + '-' + width + '-nine-melds.png') });
        }
      }
      for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844], [844, 390]]) {
        await page.setViewportSize({ width, height });
        await seed({ theme, count: 9, ownTurn: true });
        const baseline = await measure();
        for (const options of [{ count: 32 }, { count: 8, longRuns: true }]) {
          await seed({ theme, ownTurn: true, ...options });
          const result = await measure();
          const label = theme + ' ' + width + 'x' + height + ' ' + (options.longRuns ? 'eight 13-tile runs' : '32 melds');
          console.log(label, JSON.stringify(result));
          visible(result, label, options.longRuns ? 104 : 96);
          check(Math.abs(result.height - baseline.height) <= 2, label + ': board grew with content');
          check(result.rows >= 2, label + ': crowded board remains one row');
          if (width < 1000) check(result.bottom <= height + 1, label + ': board falls outside mobile viewport');
          if (!options.longRuns) await page.screenshot({ path: path.join(outputDir, theme + '-' + width + '-stress.png') });
        }
      }
      // Resize the existing DOM; the observer must restore full-size wrapped tiles.
      await page.setViewportSize({ width: 390, height: 844 });
      await seed({ theme, count: 9, ownTurn: true });
      await page.setViewportSize({ width: 1280, height: 800 });
      await settle();
      const resized = await measure();
      visible(resized, theme + ' resize recovery', 27);
      check(resized.density === 'normal' && resized.scale === 1 && resized.rows >= 2, theme + ': resize did not restore normal wrapped layout');
      // The lower row is a live drop target, not merely a visual arrangement.
      const drop = await page.evaluate(() => {
        const melds = [...document.querySelectorAll('.board-grid .meld')];
        const firstY = melds[0].getBoundingClientRect().top;
        const lower = melds.find(el => el.getBoundingClientRect().top > firstY + 5);
        if (!lower) return { found: false };
        const target = lower.querySelector('.tile');
        const groupId = target.dataset.groupId;
        const from = document.querySelector('.rack-tiles [data-tile-id="rack-0"]');
        const transfer = new DataTransfer();
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        const r = target.getBoundingClientRect();
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: r.left + 1, clientY: r.top + r.height / 2 }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: r.left + 1, clientY: r.top + r.height / 2 }));
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
        return { found: true, moved: boardWrapAudit.draft.groups.find(group => group.id === groupId).tiles.some(tile => tile.id === 'rack-0') };
      });
      check(drop.found && drop.moved, theme + ': lower-row drag insertion failed');
      await settle();
      visible(await measure(), theme + ' lower-row drop', 28);
    }
    check(errors.length === 0, 'browser errors: ' + errors.join('; '));
    if (failures.length) console.log('BASELINE FAILURES', JSON.stringify(failures, null, 2));
    else console.log('PASS board wraps down before shrinking; dense/long boards fit, resize restores, lower-row drag works');
    console.log('Screenshots:', outputDir);
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
