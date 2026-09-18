const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.DCA_PLAYWRIGHT_MODULE || 'playwright-core');

const root = path.resolve(__dirname, '..');
const tile = (id, color, value) => ({ id, kind: 'number', color, value });
const harness = [
  'globalThis.featureAudit = {',
  '  seed(options = {}) {',
  '    localStorage.setItem(THEME_KEY, options.theme || "classic");',
  '    const tile = (id, color, value) => ({ id, kind: "number", color, value });',
  '    const rack = [tile("r4", "red", 4), tile("r7", "red", 7), tile("r8", "red", 8), tile("r9", "red", 9), tile("b7", "blue", 7), tile("k7", "black", 7), tile("o1", "orange", 1)];',
  '    const board = options.emptyBoard ? [] : [{ id: "g1", type: "run", tiles: [tile("r5", "red", 5), tile("r6", "red", 6), tile("r5b", "red", 7)] }];',
  '    const now = Date.now();',
  '    state = { room: { code: "FEAT01", phase: "playing", mode: "solo", turnSeconds: 30, players: [',
  '      { id: "me", name: "나", isYou: true, isActive: true, tileCount: rack.length, hasOpened: true },',
  '      { id: "ai", name: "AI", isBot: true, isActive: false, tileCount: 14, hasOpened: true }',
  '    ] }, you: { id: "me", name: "나", rack, hasOpened: true }, board,',
  '      turn: { isYourTurn: true, activePlayerId: "me", deadlineAt: now + (options.remainingMs || 15000) },',
  '      serverNow: now, poolCount: 30, recentSubmissions: [], log: [] };',
  '    soloSessionToken = "test-token";',
  '    globalThis.turnActionInFlight = false;',
  '    lastDragAt = 0; suppressTileClickUntil = 0;',
  '    hydrateDraft();',
  '    render();',
  '  },',
  '  get draft() { return draft; },',
  '  get state() { return state; }',
  '};'
].join('\n');

const appSource = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert(appSource.includes('\ninit();'), 'browser test could not intercept app startup');
const instrumentedSource = appSource.replace('\ninit();', '\n' + harness);
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');

(async () => {
  const browser = await chromium.launch({ channel: process.env.DCA_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('https://feature.test/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: instrumentedSource });
    if (pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (pathname.startsWith('/api/')) {
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '조합을 확인해 주세요.' }) });
    }
    return route.fulfill({ contentType: 'text/html', body: html });
  });

  async function seed(options) {
    await page.evaluate(value => featureAudit.seed(value), options || {});
    await page.locator('.game-page').waitFor();
  }
  async function addToNewGroup(id) {
    await page.locator('.rack-tiles [data-tile-id="' + id + '"]').click();
    await page.locator('[data-action="new-group"]').click();
  }
  async function addToLastGroup(id) {
    await page.locator('.rack-tiles [data-tile-id="' + id + '"]').click();
    await page.locator('.meld [data-action="add-to-group"]').last().click();
  }
  async function heldRequest(action) {
    await page.evaluate(() => {
      featureAudit.requestCount = 0;
      featureAudit.releaseRequest = null;
      window.fetch = () => {
        featureAudit.requestCount += 1;
        return new Promise(resolve => {
          featureAudit.releaseRequest = () => resolve(new Response(JSON.stringify({ error: '일시적인 연결 오류' }), {
            status: 503, headers: { 'Content-Type': 'application/json' }
          }));
        });
      };
    });
    await page.locator('[data-action="' + action + '"]').click();
    await page.locator('[data-action="' + action + '"].action-pending').waitFor();
    await page.locator('[data-action="' + action + '"]').dispatchEvent('click');
    assert.equal(await page.evaluate(() => featureAudit.requestCount), 1, action + ' sent twice while pending');
    await page.evaluate(() => featureAudit.releaseRequest());
    await page.waitForFunction(() => !turnActionInFlight);
    await page.locator('[data-action="' + action + '"].action-pending').waitFor({ state: 'detached' });
  }

  try {
    await page.goto('https://feature.test/');
    await seed();

    // The active player's time bar should visibly shrink while the turn clock counts down.
    const timer = page.locator('.seat-card.active .seat-timer-progress-fill');
    await timer.waitFor({ state: 'visible' });
    const initialRatio = await timer.evaluate(el => el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width);
    assert(initialRatio > 0.1 && initialRatio < 0.9, 'timer fill should represent roughly half of a 30-second turn');
    await page.waitForFunction(previous => {
      const el = document.querySelector('.seat-card.active .seat-timer-progress-fill');
      return el && el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width < previous - 0.008;
    }, initialRatio);
    console.log('PASS active player time progress');

    // Desktop drag must show which side of a tile will receive the inserted tile.
    const preview = await page.evaluate(() => {
      const source = document.querySelector('.rack-tiles [data-tile-id="r4"]');
      const target = document.querySelector('.meld [data-tile-id="r5"]');
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      const x = target.getBoundingClientRect().left + 1;
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x }));
      const visible = Boolean(document.querySelector('.drop-preview-before'));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      return visible;
    });
    assert(preview, 'drag insertion preview did not appear before drop');
    assert.deepEqual(await page.locator('.board-grid .meld').first().locator('.tile b').allTextContents(), ['4', '5', '6', '7']);
    console.log('PASS drag insertion preview and placement');

    // Undo and redo should change the draft one move at a time.
    await seed({ emptyBoard: true });
    await addToNewGroup('r7');
    assert.equal(await page.locator('.board-grid .tile').count(), 1);
    await page.locator('[data-action="step-undo"]').click();
    assert.equal(await page.locator('.board-grid .tile').count(), 0);
    assert.equal(await page.locator('.rack-tiles [data-tile-id="r7"]').count(), 1);
    await page.locator('[data-action="step-redo"]').click();
    assert.equal(await page.locator('.board-grid .tile').count(), 1);
    assert.equal(await page.locator('.rack-tiles [data-tile-id="r7"]').count(), 0);
    console.log('PASS step undo and redo');

    // A failed submit keeps the draft and identifies its invalid meld.
    await seed({ emptyBoard: true });
    await addToNewGroup('r4');
    await addToLastGroup('r7');
    await addToLastGroup('b7');
    await page.locator('[data-action="submit-turn"]').click();
    await page.locator('.board-grid .meld.invalid-meld').waitFor();
    const explanation = await page.locator('.meld-validation-message').first().innerText();
    assert(explanation.trim().length >= 4, 'invalid meld lacks an explanation');
    assert.equal(await page.locator('.board-grid .tile').count(), 3, 'failed submit removed the draft');
    console.log('PASS invalid meld reason and preserved draft');

    // Submission and drawing should show pending feedback and reject duplicate taps.
    await seed({ emptyBoard: true });
    await addToNewGroup('r7');
    await addToLastGroup('r8');
    await addToLastGroup('r9');
    await heldRequest('submit-turn');
    assert.equal(await page.locator('.board-grid .tile').count(), 3, 'failed submit did not retain tiles');
    await seed({ emptyBoard: true });
    await heldRequest('draw-tile');
    console.log('PASS submit and draw pending feedback and duplicate prevention');

    // A held run should expose the selected count near the pointer.
    await seed({ emptyBoard: true });
    const holdTile = page.locator('.rack-tiles [data-tile-id="r7"]');
    const box = await holdTile.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.locator('.hold-selection-bubble').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const text = document.querySelector('.hold-selection-bubble')?.textContent || '';
      return /3/.test(text);
    });
    assert((await page.locator('.rack-tiles .batch-selected').count()) >= 3, 'held run did not select three tiles');
    await page.mouse.up();
    console.log('PASS held tile count feedback');

    // Keep the same controls usable in both themes and both phone orientations.
    for (const theme of ['classic', 'sheet']) {
      for (const [width, height] of [[390, 844], [844, 390]]) {
        await page.setViewportSize({ width, height });
        await seed({ theme });
        const layout = await page.evaluate(() => {
          const box = selector => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
          };
          return {
            board: box('.board-grid'),
            rack: box('.rack-tiles'),
            action: box('[data-action="draw-tile"]'),
            timer: box('.seat-timer-progress-fill'),
            pageWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
          };
        });
        assert(layout.board.width > 100 && layout.board.height > 50, theme + ' mobile board collapsed');
        assert(layout.board.top >= -1 && layout.board.bottom <= height + 2, theme + ' mobile board outside screen');
        assert(layout.rack.width > 100 && layout.rack.height > 15, theme + ' mobile rack collapsed');
        assert(layout.rack.bottom <= height + 2, theme + ' mobile rack outside screen');
        assert(layout.action.bottom <= height + 2, theme + ' mobile action outside screen');
        assert(layout.timer.width > 0 && layout.timer.height > 0, theme + ' mobile timer hidden');
        assert(layout.pageWidth <= width + 2, theme + ' mobile horizontal overflow');
        for (const selector of ['[data-action="step-undo"]', '[data-action="step-redo"]', '[data-action="submit-turn"]', '[data-action="draw-tile"]']) {
          assert(await page.locator(selector).isVisible(), theme + ' mobile control hidden: ' + selector);
        }

        await seed({ theme, emptyBoard: true });
        await addToNewGroup('r7');
        assert(await page.locator('[data-action="step-undo"]').isEnabled(), theme + ' mobile undo unavailable');
        await page.locator('[data-action="step-undo"]').click();
        assert(await page.locator('[data-action="step-redo"]').isEnabled(), theme + ' mobile redo unavailable');

        await seed({ theme, emptyBoard: true });
        await page.evaluate(() => {
          const target = document.querySelector('.rack-tiles [data-tile-id="r7"]');
          const rect = target.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          target.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 101,
            isPrimary: true, clientX: x, clientY: y
          }));
        });
        await page.locator('.hold-selection-bubble').waitFor({ state: 'visible' });
        await page.waitForFunction(() => /3/.test(document.querySelector('.hold-selection-bubble')?.textContent || ''));
        const bubble = await page.locator('.hold-selection-bubble').boundingBox();
        assert(bubble.x >= -2 && bubble.x + bubble.width <= width + 2, theme + ' mobile hold bubble clipped');
        await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, pointerType: 'touch', pointerId: 101, isPrimary: true
        })));
        await page.locator('.hold-selection-bubble').waitFor({ state: 'detached' });
        console.log('PASS mobile ' + theme + ' ' + width + 'x' + height + ' layout, controls, undo and touch hold');
      }
    }

    assert.deepEqual(pageErrors, [], 'browser runtime errors');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
