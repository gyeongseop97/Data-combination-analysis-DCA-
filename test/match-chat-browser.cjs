const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require(process.env.DCA_PLAYWRIGHT_MODULE || 'playwright-core');
const engine = require('../server');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
  + '\nglobalThis.chatAudit = { refreshRoomState, get state() { return state; }, get draft() { return draft; } };';
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
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
      await host.locator('#createRoomForm [name="playerName"]').fill(label + ' 방장');
      await host.locator('#createRoomForm [name="maxPlayers"]').selectOption('2');
      await host.locator('#createRoomForm [name="turnSeconds"]').selectOption('120');
      await host.locator('#createRoomForm button[type="submit"]').click();
      await host.locator('.lobby-page').waitFor();
      const code = (await host.locator('.invite-box strong').innerText()).trim();
      await guest.locator('#joinRoomForm [name="playerName"]').fill(label + ' 상대');
      await guest.locator('#joinRoomForm [name="code"]').fill(code);
      await guest.locator('#joinRoomForm button[type="submit"]').click();
      await guest.locator('.lobby-page').waitFor();
      assert.equal(await host.locator('[data-match-chat]').count(), 0, 'lobby must not have match chat');
      await host.waitForFunction(() => chatAudit.state.room.players.length === 2);
      await host.locator('[data-action="start-game"]').click();
      await host.locator('.game-page').waitFor();
      await guest.locator('.game-page').waitFor();
      const room = engine.rooms.get(code);
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
      room.activeIndex = room.players.findIndex(player => player.id === room.hostId);
      room.deadlineAt = Date.now() + 600000;
      await host.evaluate(() => chatAudit.refreshRoomState());
      await guest.evaluate(() => chatAudit.refreshRoomState());
      return { host, guest, code, room };
    }
    const input = page => page.locator('#matchChatForm [name="message"]');
    async function send(page, text) {
      await input(page).fill(text);
      await input(page).press('Enter');
      await page.waitForFunction(text => chatAudit.state.chatMessages.some(message => message.text === text), text);
      assert.equal(await input(page).inputValue(), '', 'successful send did not clear the input');
    }
    async function receive(page, text) {
      // Normal polling must deliver the message, without a forced state refresh.
      await page.waitForFunction(text => [...document.querySelectorAll('[data-chat-message]')].some(message => message.textContent.includes(text)), text);
    }
    async function setTheme(page, theme) {
      if (await page.locator('body').getAttribute('data-theme') !== theme) await page.locator('.game-theme-button').click();
    }

    const first = await pair('채팅');
    assert(await first.host.locator('[data-match-chat]').isVisible(), 'desktop chat is missing');
    assert.equal(await input(first.host).getAttribute('maxlength'), '300');
    assert.equal(await first.guest.evaluate(() => chatAudit.state.turn.isYourTurn), false);
    await send(first.host, '안녕하세요! 이번 판 잘 부탁해요.');
    await receive(first.guest, '안녕하세요! 이번 판 잘 부탁해요.');
    const literal = '<img src=x onerror="window.__chatXss=1"> 안녕 & <script>alert(1)</script>';
    await send(first.guest, literal);
    await receive(first.host, literal);
    assert.equal(await first.host.locator('[data-chat-messages] img, [data-chat-messages] script').count(), 0, 'chat text created HTML elements');
    assert.equal(await first.host.evaluate(() => window.__chatXss), undefined);
    console.log('PASS bidirectional Korean chat on either turn and literal HTML/XSS safety via normal polling');
    const chatRequests = [];
    first.host.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/action')) return;
      const payload = request.postDataJSON();
      if (payload?.action === 'chat') chatRequests.push(payload);
    });
    await first.host.waitForTimeout(850);
    await input(first.host).fill('한글 확정 후 바로 엔터');
    await input(first.host).evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '터' }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      // The UI composing flag also protects engines that omit isComposing.
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '터' }));
      // Safari can end composition before the confirming Enter, retaining 229.
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true, bubbles: true, cancelable: true }));
    });
    await first.host.waitForTimeout(120);
    assert.equal(chatRequests.length, 0, 'IME confirmation or held Enter sent chat prematurely');
    assert.equal(await input(first.host).inputValue(), '한글 확정 후 바로 엔터');
    await input(first.host).evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '터' }));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '터' }));
      // Deliberate non-composing Enter in the same task must not hit a timer guard.
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    });
    await receive(first.guest, '한글 확정 후 바로 엔터');
    assert.equal(chatRequests.length, 1);
    assert.equal(await input(first.host).inputValue(), '');
    assert.equal(first.room.chatMessages.filter(message => message.text === '한글 확정 후 바로 엔터').length, 1);
    await first.host.waitForTimeout(850);
    await input(first.host).fill('조합 확정 직후 버튼도 전송');
    await input(first.host).evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '송' }));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '송' }));
      element.form.querySelector('button[type="submit"]').click();
    });
    await receive(first.guest, '조합 확정 직후 버튼도 전송');
    assert.equal(chatRequests.length, 2);
    assert.equal(await input(first.host).inputValue(), '');
    console.log('PASS explicit Enter send, IME/229 protection, held-key suppression, and immediate post-composition Enter/button send');

    const hostPlayer = first.room.players.find(player => player.id === first.room.hostId);
    const guestPlayer = first.room.players.find(player => player.id !== first.room.hostId);
    hostPlayer.rack = ['n-red-10-1', 'n-red-11-1', 'n-red-12-1', 'n-orange-2-1'];
    guestPlayer.rack = ['n-blue-1-1', 'n-blue-4-1', 'n-blue-7-1'];
    first.room.board = [];
    first.room.deadlineAt = Date.now() + 600000;
    first.room.turnDirty = false;
    const dealt = new Set(first.room.players.flatMap(player => player.rack));
    first.room.deck = engine.ALL_TILE_IDS.filter(id => !dealt.has(id));
    await first.host.evaluate(() => chatAudit.refreshRoomState());
    await first.host.locator('.rack-tiles [data-tile-id="n-red-10-1"]').click();
    await first.host.locator('[data-action="new-group"]').click();
    await first.host.waitForFunction(() => chatAudit.state.turn.dirty === true);
    const draftBefore = await first.host.evaluate(() => JSON.stringify(chatAudit.draft));
    await input(first.host).fill('작성 중인 한글 문장');
    await input(first.host).evaluate(element => { element.focus(); element.setSelectionRange(3, 5); globalThis.__chatInput = element; });
    await first.guest.waitForTimeout(850);
    await send(first.guest, '작성 중에도 수신되는 메시지');
    await receive(first.host, '작성 중에도 수신되는 메시지');
    const preserved = await input(first.host).evaluate(element => ({
      value: element.value, start: element.selectionStart, end: element.selectionEnd,
      focused: document.activeElement === element, sameNode: globalThis.__chatInput === element,
    }));
    assert.deepEqual(preserved, { value: '작성 중인 한글 문장', start: 3, end: 5, focused: true, sameNode: true }, 'chat-only update interrupted the composer');
    assert.equal(await first.host.evaluate(() => JSON.stringify(chatAudit.draft)), draftBefore, 'chat-only update reset board draft');
    console.log('PASS incoming chat preserves draft, text, selection, focus, and input DOM');

    // Synthetic composition exercises the real browser event path; an OS IME
    // itself cannot be driven portably by this headless Chrome harness.
    await input(first.host).evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '한' })));
    first.room.log.unshift({ text: '채팅 입력 중 상대 상태 갱신', at: Date.now() });
    await first.host.waitForFunction(() => chatAudit.state.log.some(item => item.text === '채팅 입력 중 상대 상태 갱신'));
    assert.equal(await input(first.host).inputValue(), '작성 중인 한글 문장');
    assert.equal(await input(first.host).evaluate(element => globalThis.__chatInput === element && document.activeElement === element), true, 'game poll replaced composing input');
    await input(first.host).evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' })));
    await first.host.waitForTimeout(100);
    assert.deepEqual(await input(first.host).evaluate(element => ({ value: element.value, start: element.selectionStart, end: element.selectionEnd, focused: document.activeElement === element })), { value: '작성 중인 한글 문장', start: 3, end: 5, focused: true }, 'game render lost input/caret');
    assert.equal(await first.host.evaluate(() => JSON.stringify(chatAudit.draft)), draftBefore);
    console.log('PASS gameplay polling and IME composition do not interrupt chat or draft');

    let releaseChatReply;
    let markChatReplyReady;
    const chatReplyReady = new Promise(resolve => { markChatReplyReady = resolve; });
    const chatReplyGate = new Promise(resolve => { releaseChatReply = resolve; });
    const chatRoute = '**/api/rooms/' + first.code + '/action';
    await first.host.route(chatRoute, async route => {
      const payload = route.request().postDataJSON();
      if (payload?.action !== 'chat' || payload.text !== '응답 도착 중 조합') return route.continue();
      const response = await route.fetch();
      markChatReplyReady();
      await chatReplyGate;
      await route.fulfill({ response });
    });
    await input(first.host).fill('응답 도착 중 조합');
    await input(first.host).press('Enter');
    await chatReplyReady;
    await input(first.host).press('Enter');
    await input(first.host).press('Enter');
    assert.equal(chatRequests.filter(payload => payload.text === '응답 도착 중 조합').length, 1, 'repeated Enter sent duplicate requests while awaiting acknowledgement');
    await input(first.host).evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '한' })));
    releaseChatReply();
    await first.host.waitForFunction(() => !document.querySelector('#matchChatForm button[type="submit"]').disabled);
    assert.equal(await input(first.host).inputValue(), '응답 도착 중 조합', 'delayed send acknowledgement cleared an active composition');
    assert.equal(await input(first.host).evaluate(element => document.activeElement === element), true, 'delayed acknowledgement lost IME focus');
    await input(first.host).evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' })));
    await first.host.unroute(chatRoute);
    console.log('PASS a delayed send acknowledgement cannot clear an in-progress Korean composition');

    first.room.chatMessages = Array.from({ length: 45 }, (_, index) => ({
      id: 'scroll-fixture-' + index, playerId: guestPlayer.id, playerName: guestPlayer.name,
      text: '스크롤 보존 메시지 ' + String(index).padStart(2, '0') + ' · 이전 대화를 읽는 중입니다.',
      sentAt: Date.now() - (45 - index) * 1000, clientMessageId: 'scroll-client-' + index,
    }));
    await first.host.waitForFunction(() => [...document.querySelectorAll('[data-chat-message]')].some(element => element.textContent.includes('스크롤 보존 메시지 44')));
    const scroller = first.host.locator('[data-chat-messages]');
    const scrollFixture = await scroller.evaluate(element => { element.scrollTop = 100; return { top: element.scrollTop, max: element.scrollHeight - element.clientHeight }; });
    assert(scrollFixture.max > 200, 'chat fixture did not overflow inside the message log');
    await first.guest.waitForTimeout(850);
    await send(first.guest, '이전 메시지를 읽는 동안 도착');
    await receive(first.host, '이전 메시지를 읽는 동안 도착');
    const scrollAfter = await scroller.evaluate(element => element.scrollTop);
    assert(Math.abs(scrollAfter - scrollFixture.top) <= 2, 'incoming chat jumped away from the older messages');
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await first.guest.waitForTimeout(850);
    await send(first.guest, '맨 아래에서는 새 메시지 따라가기');
    await receive(first.host, '맨 아래에서는 새 메시지 따라가기');
    assert(await scroller.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop <= 3), 'bottom-pinned chat did not reveal the new message');
    console.log('PASS old-message scroll stays put and bottom-pinned log follows new messages');

    const second = await pair('다른 방');
    assert.equal(await second.host.locator('[data-chat-message]').count(), 0, 'another room leaked chat history');
    await send(second.host, '다른 방 전용 대화');
    await receive(second.guest, '다른 방 전용 대화');
    await first.host.waitForTimeout(1700);
    assert.equal(await first.host.locator('[data-chat-message]').filter({ hasText: '다른 방 전용 대화' }).count(), 0, 'cross-room message leakage');
    console.log('PASS separate room conversations remain isolated');

    for (const viewport of [{ width: 1280, height: 720 }, { width: 1280, height: 900 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await first.host.setViewportSize(viewport);
      for (const theme of ['classic', 'sheet']) {
        await setTheme(first.host, theme);
        await first.host.waitForTimeout(100);
        const layout = await first.host.evaluate(() => {
          const rect = selector => { const bounds = document.querySelector(selector).getBoundingClientRect(); return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, height: bounds.height, width: bounds.width }; };
          return { board: rect('.board-grid'), chat: rect('[data-match-chat]'), composer: rect('#matchChatForm'), banner: rect('.game-banner'), seats: rect('.seat-grid'), width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth };
        });
        assert(layout.scrollWidth <= viewport.width + 2, theme + ' horizontal overflow: ' + JSON.stringify(layout));
        if (viewport.width >= 1100) {
          assert(await first.host.locator('[data-match-chat]').isVisible(), theme + ' desktop chat hidden');
          assert(layout.chat.left >= layout.board.right - 2, theme + ' chat is not to the right of the board: ' + JSON.stringify(layout));
          assert(layout.chat.right <= viewport.width + 2, theme + ' chat extends outside viewport');
          assert(layout.composer.bottom <= viewport.height + 2, theme + ' chat composer falls below the visible viewport: ' + JSON.stringify(layout));
          assert(layout.seats.top >= layout.banner.bottom - 2, theme + ' seats overlap the banner: ' + JSON.stringify(layout));
          assert.equal(await first.host.locator('.sheet-menu').isVisible(), false, theme + ' obsolete menu occupies the chat grid');
          assert(layout.board.width >= 500 && layout.board.height >= 100, theme + ' chat displaced the usable board');
        } else {
          assert.equal(await first.host.locator('[data-match-chat]').isVisible(), false, theme + ' chat consumes mobile screen');
          assert(layout.board.height > 70 && layout.board.bottom <= viewport.height + 2, theme + ' mobile board no longer fits: ' + JSON.stringify(layout));
        }
        const screenshotPath = path.join(process.env.TEMP || process.cwd(), 'dca-match-chat-' + viewport.width + 'x' + viewport.height + '-' + theme + '.png');
        await first.host.screenshot({ path: screenshotPath });
        console.log('SCREENSHOT ' + screenshotPath);
      }
    }
    console.log('PASS 1280x720/900 and 1920 desktop right-side panel and mobile portrait/landscape layout in both themes');

    await first.host.setViewportSize({ width: 1280, height: 900 });
    await input(first.host).fill('');
    await first.host.locator('[data-action="undo-draft"]').click();
    hostPlayer.rack = ['n-red-10-1', 'n-red-11-1', 'n-red-12-1'];
    first.room.deadlineAt = Date.now() + 600000;
    first.room.turnDirty = false;
    const finalDealt = new Set(first.room.players.flatMap(player => player.rack));
    first.room.deck = engine.ALL_TILE_IDS.filter(id => !finalDealt.has(id));
    await first.host.evaluate(() => chatAudit.refreshRoomState());
    for (const [index, id] of hostPlayer.rack.entries()) {
      await first.host.locator('.rack-tiles [data-tile-id="' + id + '"]').click();
      await first.host.locator(index === 0 ? '[data-action="new-group"]' : '[data-action="add-to-group"]').click();
    }
    await first.host.locator('[data-action="submit-turn"]').click();
    await first.host.locator('.result-overlay').waitFor();
    await first.guest.locator('.result-overlay').waitFor();
    assert.deepEqual(first.room.chatMessages, [], 'match completion kept chat server-side');
    assert.equal(await first.host.locator('[data-match-chat]').count(), 0, 'finished match still displays chat');
    await first.host.locator('.result-overlay [data-action="home"]').click();
    await first.host.locator('#createRoomForm').waitFor();
    assert.equal(await first.host.locator('[data-chat-message]').count(), 0, 'home retained chat');
    await first.host.reload();
    await first.host.locator('#createRoomForm').waitFor();
    assert.equal(await first.host.locator('[data-match-chat]').count(), 0, 'home reload restored chat');
    console.log('PASS actual winning submit clears match messages and leaving/reloading home cannot restore chat');
    assert.deepEqual(errors, [], 'browser runtime errors');
  } finally {
    await browser.close();
    for (const room of engine.rooms.values()) { clearTimeout(room.turnTimer); clearTimeout(room.aiTimer); }
    engine.rooms.clear();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exit(1); });
