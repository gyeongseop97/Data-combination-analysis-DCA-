const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const rulesDialog = document.querySelector('#rulesDialog');
const ROOM_KEY = 'office-rummikub-room';
const CLIENT_KEY = 'office-rummikub-client';
const THEME_KEY = 'office-rummikub-theme';
const RACK_ORDER_PREFIX = 'office-rummikub-rack-order';
const colors = ['red', 'blue', 'orange', 'black'];
const RACK_HOLD_DELAY = 360;
const RACK_HOLD_STEP = 220;
const GAME_TITLE = '데이터 조합 분석_v1.xlsx';

let clientId = localStorage.getItem(CLIENT_KEY);
if (!clientId) {
  clientId = `client-${crypto.randomUUID().replace(/-/g, '')}`;
  localStorage.setItem(CLIENT_KEY, clientId);
}

let state = null;
let activeRoomCode = '';
let pendingRoomCode = new URLSearchParams(location.search).get('room')?.toUpperCase() || '';
let eventSource = null;
let selected = null;
let draft = null;
let baselineSignature = '';
let draftTurnKey = null;
let draftSyncTimer = null;
let toastTimer = null;
let connection = 'idle';
let draggedTile = null;
let lastDragAt = 0;
let batchSelection = null;
let tileHold = null;
let tileHoldDelayTimer = null;
let tileHoldStepTimer = null;
let suppressTileClickUntil = 0;
let renderSequence = 0;
let boardFitTimer = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

function shortCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function showToast(message, kind = '') {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3600);
}

function theme() {
  return localStorage.getItem(THEME_KEY) === 'classic' ? 'classic' : 'sheet';
}

function applyTheme(nextTheme, shouldRender = true) {
  localStorage.setItem(THEME_KEY, nextTheme);
  document.body.dataset.theme = nextTheme;
  document.querySelectorAll('[data-theme-button]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.themeButton === nextTheme);
  });
  if (shouldRender && app?.childElementCount) render();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
  return data;
}

function draftSignature(model) {
  if (!model) return '';
  const ids = (tiles) => tiles.map((tile) => tile.id).sort();
  return JSON.stringify({
    groups: model.groups
      .map((group) => ({ id: group.id, tileIds: ids(group.tiles) }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    rack: ids(model.rack),
  });
}

function cloneTile(tile) {
  return { ...tile, resolvedFace: tile.resolvedFace ? { ...tile.resolvedFace } : undefined };
}

function rackOrderKey(snapshot = state) {
  if (!activeRoomCode || !snapshot?.you?.id) return '';
  return `${RACK_ORDER_PREFIX}:${activeRoomCode}:${snapshot.you.id}`;
}

function rememberRackOrder(rack, snapshot = state) {
  const key = rackOrderKey(snapshot);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(rack.map((tile) => tile.id)));
  } catch {
    // The game remains playable if a privacy mode blocks local storage writes.
  }
}

function applyRememberedRackOrder(rack, snapshot = state) {
  const key = rackOrderKey(snapshot);
  if (!key) return rack;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(saved)) return rack;
    const byId = new Map(rack.map((tile) => [tile.id, tile]));
    const arranged = saved.map((id) => byId.get(id)).filter(Boolean);
    const known = new Set(arranged.map((tile) => tile.id));
    return [...arranged, ...rack.filter((tile) => !known.has(tile.id))];
  } catch {
    return rack;
  }
}

function batchMatches(source, groupId, tileId) {
  return Boolean(
    batchSelection
    && batchSelection.source === source
    && batchSelection.groupId === (groupId || '')
    && batchSelection.tileIds.includes(tileId),
  );
}

function batchStatusText(selection = batchSelection) {
  if (!selection?.tileIds?.length) return '';
  return selection.source === 'group'
    ? `보드 뒤쪽 패 ${selection.tileIds.length}장 선택됨 · 드래그하면 함께 이동합니다`
    : `연속 패 ${selection.tileIds.length}장 선택됨 · 드래그하면 함께 이동합니다`;
}

function refreshSelectedLabel() {
  const label = document.querySelector('.selected-label');
  if (!label) return;
  label.textContent = selectedLabel();
  label.classList.toggle('has-selection', Boolean(selected || batchSelection));
}

function paintBatchSelection() {
  document.querySelectorAll('[data-drag-tile]').forEach((tile) => {
    const source = tile.dataset.source;
    const groupId = tile.dataset.groupId || '';
    const selectedHere = batchMatches(source, groupId, tile.dataset.tileId);
    const originHere = Boolean(
      tileHold?.active
      && tileHold.source === source
      && tileHold.groupId === groupId
      && tileHold.anchorTileId === tile.dataset.tileId,
    );
    tile.classList.toggle('batch-selected', selectedHere);
    tile.classList.toggle('batch-origin', originHere);
  });

  const selection = batchSelection;
  const rackStatus = document.querySelector('[data-rack-batch-status]');
  if (rackStatus) {
    rackStatus.textContent = selection?.source === 'rack' ? batchStatusText(selection) : '';
    rackStatus.hidden = selection?.source !== 'rack';
  }
  const boardStatus = document.querySelector('[data-board-batch-status]');
  if (boardStatus) {
    boardStatus.textContent = selection?.source === 'group' ? batchStatusText(selection) : '';
    boardStatus.hidden = selection?.source !== 'group';
  }
  refreshSelectedLabel();
}

function stopTileHold() {
  clearTimeout(tileHoldDelayTimer);
  clearInterval(tileHoldStepTimer);
  tileHoldDelayTimer = null;
  tileHoldStepTimer = null;
  tileHold = null;
}

function clearBatchSelection() {
  stopTileHold();
  batchSelection = null;
  paintBatchSelection();
}

function setBatchSelection(source, groupId, tileIds) {
  batchSelection = {
    source,
    groupId: groupId || '',
    tileIds: [...new Set(tileIds)],
  };
  paintBatchSelection();
}

function rackConsecutiveTileIds(tileId) {
  if (!draft) return [];
  const startIndex = draft.rack.findIndex((tile) => tile.id === tileId);
  if (startIndex < 0) return [];
  const first = draft.rack[startIndex];
  if (first.kind === 'joker') return [];

  const ids = [first.id];
  let previous = first;
  let direction = 0;
  for (let index = startIndex + 1; index < draft.rack.length; index += 1) {
    const next = draft.rack[index];
    if (next.kind === 'joker' || next.color !== previous.color) break;
    const difference = Number(next.value) - Number(previous.value);
    if (!direction) {
      if (Math.abs(difference) !== 1) break;
      direction = difference;
    } else if (difference !== direction) {
      break;
    }
    ids.push(next.id);
    previous = next;
  }
  return ids;
}

function groupTailTileIds(groupId, tileId) {
  if (!draft) return [];
  const group = draft.groups.find((entry) => entry.id === groupId);
  if (!group || (group.existing && !state?.you?.hasOpened)) return [];
  const startIndex = group.tiles.findIndex((tile) => tile.id === tileId);
  return startIndex < 0 ? [] : group.tiles.slice(startIndex).map((tile) => tile.id);
}

function holdCandidateTileIds(source, groupId, tileId) {
  return source === 'rack'
    ? rackConsecutiveTileIds(tileId)
    : groupTailTileIds(groupId, tileId);
}

function beginTileHold(tile, event) {
  const source = tile.dataset.source;
  const groupId = tile.dataset.groupId || '';
  const tileIds = holdCandidateTileIds(source, groupId, tile.dataset.tileId);
  if (tileIds.length < 2) return;

  clearBatchSelection();
  tileHold = {
    pointerId: event.pointerId,
    source,
    groupId,
    anchorTileId: tile.dataset.tileId,
    tileIds,
    selectedCount: 0,
    active: false,
    startX: event.clientX,
    startY: event.clientY,
  };
  tileHoldDelayTimer = setTimeout(() => {
    if (!tileHold) return;
    tileHoldDelayTimer = null;
    tileHold.active = true;
    tileHold.selectedCount = 1;
    selected = null;
    document.querySelectorAll('.tile.selected').forEach((entry) => entry.classList.remove('selected'));
    setBatchSelection(tileHold.source, tileHold.groupId, tileHold.tileIds.slice(0, tileHold.selectedCount));
    tileHoldStepTimer = setInterval(() => {
      if (!tileHold?.active) return;
      if (tileHold.selectedCount >= tileHold.tileIds.length) {
        clearInterval(tileHoldStepTimer);
        tileHoldStepTimer = null;
        return;
      }
      tileHold.selectedCount += 1;
      setBatchSelection(tileHold.source, tileHold.groupId, tileHold.tileIds.slice(0, tileHold.selectedCount));
    }, RACK_HOLD_STEP);
  }, RACK_HOLD_DELAY);
}function hydrateDraft(nextState = state) {
  clearBatchSelection();
  if (!nextState?.turn?.isYourTurn || !nextState?.you) {
    draft = null;
    selected = null;
    draftTurnKey = null;
    baselineSignature = '';
    return;
  }
  draft = {
    groups: nextState.board.map((group) => ({
      id: group.id,
      type: group.type,
      existing: true,
      tiles: group.tiles.map(cloneTile),
    })),
    rack: applyRememberedRackOrder(nextState.you.rack.map(cloneTile), nextState),
  };
  baselineSignature = draftSignature(draft);
  draftTurnKey = nextState.turn.deadlineAt;
  selected = null;
}

function isDraftDirty() {
  return Boolean(draft && draftSignature(draft) !== baselineSignature);
}

function syncDraftStatus() {
  if (!state?.turn?.isYourTurn) return;
  clearTimeout(draftSyncTimer);
  draftSyncTimer = setTimeout(async () => {
    try {
      const response = await api(`/api/rooms/${activeRoomCode}/action`, {
        method: 'POST',
        body: JSON.stringify({ clientId, action: 'draft', dirty: isDraftDirty() }),
      });
      receiveState(response);
    } catch (error) {
      showToast(error.message, 'error');
    }
  }, 120);
}

function receiveState(nextState) {
  const keepDraft = Boolean(
    draft
    && nextState?.turn?.isYourTurn
    && nextState.turn.deadlineAt === draftTurnKey,
  );
  state = nextState;
  if (!keepDraft) hydrateDraft(nextState);
  render();
}

function connectEvents(code) {
  if (eventSource) eventSource.close();
  connection = 'connecting';
  eventSource = new EventSource(`/api/rooms/${code}/events?clientId=${encodeURIComponent(clientId)}`);
  eventSource.addEventListener('state', (event) => {
    connection = 'online';
    receiveState(JSON.parse(event.data));
  });
  eventSource.onerror = () => {
    connection = 'reconnecting';
    renderConnectionOnly();
  };
}

function renderConnectionOnly() {
  document.querySelectorAll('.connection-dot').forEach((element) => {
    element.className = `connection-dot ${connection}`;
    element.title = connection === 'online' ? '연결됨' : '재연결 중';
  });
}

function activateRoom(code, snapshot) {
  activeRoomCode = code;
  pendingRoomCode = '';
  localStorage.setItem(ROOM_KEY, code);
  history.replaceState(null, '', `?room=${encodeURIComponent(code)}`);
  receiveState(snapshot);
  connectEvents(code);
}

function goHome() {
  clearBatchSelection();
  eventSource?.close();
  eventSource = null;
  state = null;
  draft = null;
  selected = null;
  activeRoomCode = '';
  pendingRoomCode = '';
  connection = 'idle';
  localStorage.removeItem(ROOM_KEY);
  history.replaceState(null, '', location.pathname);
  render();
}

function spreadsheetHeader() {
  const documentTitle = GAME_TITLE;
  return `
    <header class="workbook-chrome">
      <div class="workbook-titlebar">
        <div class="workbook-quick">
          <button class="workbook-home" data-action="home" aria-label="첫 화면으로">⌂</button>
          <span class="quick-separator" aria-hidden="true"></span>
          <button class="workbook-icon" type="button" aria-label="메뉴">☰</button>
          <button class="workbook-icon" type="button" aria-label="실행 취소">↶</button>
          <button class="workbook-icon" type="button" aria-label="저장">▣</button>
        </div>
        <span class="workbook-document">${documentTitle}</span>
        <div class="workbook-window">
          <span class="connection-dot ${connection}" title="${connection === 'online' ? '연결됨' : '연결 상태 확인 중'}"></span>
          <button class="compact-theme" data-action="theme" data-theme="classic">기본 보기</button>
          <button class="workbook-icon help-icon" data-action="rules" aria-label="규칙 보기">?</button>
          <span class="window-control" aria-hidden="true">—</span><span class="window-control" aria-hidden="true">□</span><span class="window-control close" aria-hidden="true">×</span>
        </div>
      </div>
      <nav class="workbook-tabs" aria-label="문서 메뉴">
        <button class="file-tab" type="button">파일</button><button class="active" type="button">홈</button><button type="button">삽입</button><button type="button">페이지 레이아웃</button><button type="button">수식</button><button type="button">데이터</button><button type="button">검토</button><button type="button">보기</button><button type="button">개발 도구</button>
        <span class="ribbon-search">⌕&nbsp; 수행할 작업을 알려 주세요.</span>
      </nav>
      <div class="workbook-ribbon" aria-hidden="true">
        <section class="ribbon-group clipboard-group"><span class="large-glyph">▣</span><div><b>붙여넣기</b><span>잘라내기</span><span>서식 복사</span></div><small>클립보드</small></section>
        <section class="ribbon-group font-group"><div class="font-select">맑은 고딕 <i>⌄</i></div><div class="font-tools"><b>가</b><em>기</em><u>밑</u><span>▦</span><span class="paint">▰</span></div><small>글꼴</small></section>
        <section class="ribbon-group align-group"><div class="align-icons"><span>≡</span><span>☰</span><span>≣</span><span>↔</span></div><small>맞춤</small></section>
        <section class="ribbon-group number-group"><div class="format-select">일반 <i>⌄</i></div><div><span>%</span><span>,</span><span>.0</span></div><small>표시 형식</small></section>
        <section class="ribbon-group styles-group"><div class="style-samples"><b>표준</b><b class="pink">나쁨</b><b class="yellow">보통</b><b class="green">좋음</b></div><small>스타일</small></section>
        <section class="ribbon-group cells-group"><div><span>삽입</span><span>삭제</span><span>서식</span></div><small>셀</small></section>
        <section class="ribbon-group edit-group"><div><span>Σ 자동 합계</span><span>정렬 및 필터</span><span>찾기 및 선택</span></div><small>편집</small></section>
      </div>
    </header>`;
}

function header(compact = false) {
  if (theme() === 'sheet') return spreadsheetHeader();
  return `
    <header class="topbar ${compact ? 'compact' : ''}">
      <button class="brand" data-action="home" aria-label="첫 화면으로">
        <span class="brand-mark"><i></i><i></i><i></i></span>
        <span>${escapeHtml(GAME_TITLE)}</span>
      </button>
      <div class="topbar-actions">
        <span class="connection-dot ${connection}" title="${connection === 'online' ? '연결됨' : '연결 상태 확인 중'}"></span>
        <div class="theme-switch" aria-label="화면 테마">
          <button data-theme-button="classic" data-action="theme" data-theme="classic" class="${theme() === 'classic' ? 'selected' : ''}">기본</button>
          <button data-theme-button="sheet" data-action="theme" data-theme="sheet" class="${theme() === 'sheet' ? 'selected' : ''}">스프레드시트</button>
        </div>
        <button class="ghost-button" data-action="rules">규칙</button>
      </div>
    </header>`;
}

function homePage() {
  const code = pendingRoomCode || '';
  return theme() === 'sheet' ? spreadsheetHomePage(code) : classicHomePage(code);
}

function classicHomePage(code) {
  return `
    ${header()}
    <main class="home-page">
      <section class="hero-copy">
        <p class="eyebrow">DATA COMBINATION ANALYSIS</p>
        <h1 class="home-file-title">${escapeHtml(GAME_TITLE)}</h1>
        <p class="hero-text">개인 분석을 바로 열거나, 공유 분석 세션을 만들어 구성원과 같은 결과를 검토할 수 있습니다.</p>
        <div class="feature-row">
          <span>개인 분석</span><span>공유 세션</span><span>자동 동기화</span>
        </div>
      </section>
      <section class="entry-grid">
        <form id="soloGameForm" class="entry-card solo-card">
          <div class="card-heading"><span class="step">01</span><div><p class="eyebrow">PRIVATE ANALYSIS</p><h2>개인 분석 열기</h2></div></div>
          <label>분석자<input required maxlength="24" name="playerName" autocomplete="nickname" value="나" /></label>
          <label>분석 주기<select name="turnSeconds"><option value="30">30초</option><option value="60" selected>60초</option><option value="90">90초</option><option value="120">120초</option><option value="150">150초</option><option value="180">180초</option></select></label>
          <button class="primary-button" type="submit">개인 분석 시작 <span>→</span></button>
          <p class="field-note">개인 작업 영역이 바로 열립니다. 자동 분석도 같은 기준으로 동작합니다.</p>
        </form>
        <form id="createRoomForm" class="entry-card create-card">
          <div class="card-heading"><span class="step">02</span><div><p class="eyebrow">SHARED ANALYSIS</p><h2>공유 분석 만들기</h2></div></div>
          <label>분석자<input required maxlength="24" name="playerName" autocomplete="nickname" placeholder="예: 민지" /></label>
          <label>세션 이름<input required maxlength="36" name="name" value="정기 조합 검토" /></label>
          <div class="form-two">
            <label>검토 인원<select name="maxPlayers"><option value="2">2명</option><option value="3">3명</option><option value="4" selected>4명</option></select></label>
            <label>검토 시간<select name="turnSeconds"><option value="30">30초</option><option value="60" selected>60초</option><option value="90">90초</option><option value="120">120초</option><option value="150">150초</option><option value="180">180초</option></select></label>
          </div>
          <button class="primary-button" type="submit">공유 세션 생성 <span>→</span></button>
          <p class="field-note">세션을 만들면 검토 코드가 생성됩니다.</p>
        </form>
        <form id="joinRoomForm" class="entry-card join-card">
          <div class="card-heading"><span class="step">03</span><div><p class="eyebrow">OPEN WORKSPACE</p><h2>공유 분석 열기</h2></div></div>
          <label>분석자<input required maxlength="24" name="playerName" autocomplete="nickname" placeholder="예: 준" /></label>
          <label>세션 코드<input required maxlength="6" pattern="[A-Za-z0-9]{6}" name="code" value="${escapeHtml(code)}" placeholder="ABC123" class="code-input" /></label>
          <button class="secondary-button" type="submit">세션 불러오기 <span>→</span></button>
          <p class="field-note">공유 받은 6자리 세션 코드를 입력하세요.</p>
        </form>
      </section>
      <p class="quiet-note">표시 방식은 각 브라우저에서 개별 설정됩니다.</p>
    </main>`;
}

function spreadsheetHomePage(code) {
  const columns = Array.from({ length: 16 }, (_, index) => `<span>${String.fromCharCode(65 + index)}</span>`).join('');
  const rows = Array.from({ length: 28 }, (_, index) => `<span>${index + 1}</span>`).join('');
  return `
    ${header()}
    <main class="home-page sheet-home-page">
      <div class="sheet-home-formula" aria-hidden="true"><span class="sheet-home-name-box">C8</span><span class="sheet-home-formula-mark">fx</span><p>=DCA_WORKBOOK("READY")</p></div>
      <section class="sheet-home-workspace" aria-label="${escapeHtml(GAME_TITLE)} 시작 화면">
        <div class="sheet-home-corner" aria-hidden="true"></div>
        <div class="sheet-home-columns" aria-hidden="true">${columns}</div>
        <div class="sheet-home-rows" aria-hidden="true">${rows}</div>
        <div class="sheet-home-canvas">
          <section class="sheet-home-file-panel">
            <div>
              <p>DATA COMBINATION ANALYSIS</p>
              <h1>${escapeHtml(GAME_TITLE)}</h1>
              <small>통합 문서 · 분석 시트 · 자동 저장됨</small>
            </div>
            <dl><div><dt>상태</dt><dd>준비</dd></div><div><dt>버전</dt><dd>v1.0</dd></div><div><dt>표시</dt><dd>100%</dd></div></dl>
          </section>
          <section class="sheet-home-cards">
            <form id="soloGameForm" class="sheet-home-card sheet-home-auto-card">
              <div class="sheet-home-card-title"><span>01</span><div><p>PRIVATE ANALYSIS</p><h2>개인 분석</h2></div></div>
              <label>분석자<input required maxlength="24" name="playerName" autocomplete="nickname" value="나" /></label>
              <label>분석 주기<select name="turnSeconds"><option value="30">30초</option><option value="60" selected>60초</option><option value="90">90초</option><option value="120">120초</option><option value="150">150초</option><option value="180">180초</option></select></label>
              <button class="sheet-home-action" type="submit">분석 시작</button>
              <p>개인 작업 영역을 바로 엽니다.</p>
            </form>
            <form id="createRoomForm" class="sheet-home-card">
              <div class="sheet-home-card-title"><span>02</span><div><p>SHARED ANALYSIS</p><h2>공유 분석</h2></div></div>
              <label>분석자<input required maxlength="24" name="playerName" autocomplete="nickname" placeholder="예: 민지" /></label>
              <label>세션 이름<input required maxlength="36" name="name" value="정기 조합 검토" /></label>
              <div class="sheet-home-form-two"><label>검토 인원<select name="maxPlayers"><option value="2">2명</option><option value="3">3명</option><option value="4" selected>4명</option></select></label><label>검토 시간<select name="turnSeconds"><option value="30">30초</option><option value="60" selected>60초</option><option value="90">90초</option><option value="120">120초</option><option value="150">150초</option><option value="180">180초</option></select></label></div>
              <button class="sheet-home-action" type="submit">공유 세션 생성</button>
              <p>검토용 세션 코드가 생성됩니다.</p>
            </form>
            <form id="joinRoomForm" class="sheet-home-card">
              <div class="sheet-home-card-title"><span>03</span><div><p>OPEN WORKSPACE</p><h2>기존 분석</h2></div></div>
              <label>분석자<input required maxlength="24" name="playerName" autocomplete="nickname" placeholder="예: 준" /></label>
              <label>세션 코드<input required maxlength="6" pattern="[A-Za-z0-9]{6}" name="code" value="${escapeHtml(code)}" placeholder="ABC123" class="code-input" /></label>
              <button class="sheet-home-action secondary" type="submit">세션 불러오기</button>
              <p>공유 받은 6자리 코드를 입력하세요.</p>
            </form>
          </section>
          <p class="sheet-home-footer">변경 사항은 현재 브라우저에서만 표시됩니다.</p>
        </div>
      </section>
    </main>`;
}
function playerRow(player) {
  const initials = escapeHtml(player.name.slice(0, 1).toUpperCase());
  return `
    <li class="player-row ${player.isYou ? 'is-you' : ''}">
      <span class="avatar">${initials}</span>
      <span class="player-name">${escapeHtml(player.name)}${player.isYou ? ' <small>나</small>' : ''}</span>
      ${player.isBot ? '<span class="ai-chip">AI</span>' : player.host ? '<span class="host-chip">방장</span>' : ''}
      <span class="row-status">${player.isActive ? '진행 중' : player.hasOpened ? '등록 완료' : '대기 중'}</span>
    </li>`;
}

function lobbyPage() {
  const room = state.room;
  const you = state.you;
  const isHost = you.isHost;
  const joined = room.players.length;
  return `
    ${header(true)}
    <main class="lobby-page">
      <section class="room-banner">
        <div>
          <p class="eyebrow">WAITING ROOM · ${joined}/${room.maxPlayers}</p>
          <h1>${escapeHtml(room.name)}</h1>
          <p>최대 ${room.maxPlayers}명 · 한 턴 ${room.turnSeconds}초 · 최소 2명부터 시작</p>
        </div>
        <div class="invite-box">
          <span>초대 코드</span>
          <strong>${room.code}</strong>
          <button class="copy-button" data-action="copy-invite">링크 복사</button>
        </div>
      </section>
      <section class="lobby-grid">
        <article class="lobby-card people-card">
          <div class="card-title-row"><div><p class="eyebrow">AT THE TABLE</p><h2>참가자</h2></div><span class="capacity">${joined} / ${room.maxPlayers}</span></div>
          <ul class="player-list">${room.players.map(playerRow).join('')}</ul>
          <div class="waiting-strip"><span class="pulse"></span>${joined < 2 ? '한 명만 더 오면 시작할 수 있어요.' : '모두 준비됐어요. 방장이 시작할 수 있습니다.'}</div>
          ${isHost ? `<button class="primary-button start-button" data-action="start-game" ${joined < 2 ? 'disabled' : ''}>게임 시작 <span>→</span></button>` : '<p class="guest-wait">방장이 게임을 시작할 때까지 잠시 기다려 주세요.</p>'}
        </article>
        <article class="lobby-card settings-card">
          <div class="card-title-row"><div><p class="eyebrow">ROOM SETTINGS</p><h2>방 설정</h2></div>${isHost ? '<span class="editable-chip">방장만 편집</span>' : ''}</div>
          <form id="roomSettingsForm">
            <label>방 이름<input name="name" maxlength="36" value="${escapeHtml(room.name)}" ${isHost ? '' : 'disabled'} /></label>
            <div class="form-two">
              <label>최대 인원<select name="maxPlayers" ${isHost ? '' : 'disabled'}>${[2, 3, 4].map((count) => `<option value="${count}" ${count === room.maxPlayers ? 'selected' : ''}>${count}명</option>`).join('')}</select></label>
              <label>턴 제한<select name="turnSeconds" ${isHost ? '' : 'disabled'}>${[30, 60, 90, 120, 150, 180].map((seconds) => `<option value="${seconds}" ${seconds === room.turnSeconds ? 'selected' : ''}>${seconds}초</option>`).join('')}</select></label>
            </div>
            ${isHost ? '<button class="secondary-button save-settings" type="submit">설정 저장</button>' : '<p class="field-note">이 방의 턴 제한은 방장이 정합니다.</p>'}
          </form>
          <div class="theme-reminder"><span class="sheet-icon">▦</span><p><strong>스프레드시트 테마는 개인 설정입니다.</strong><br>같은 게임 상태를 각자 원하는 화면으로 볼 수 있어요.</p></div>
        </article>
      </section>
      <section class="lobby-rule-strip"><span>01</span><p>첫 등록은 내 손패로만 <strong>30점 이상</strong></p><span>02</span><p>그 뒤에는 매 턴 손패를 <strong>1장 이상</strong> 내려놓기</p><span>03</span><p>제출할 때 보드의 모든 조합이 <strong>유효해야 함</strong></p></section>
    </main>`;
}

function faceDescription(tile) {
  if (tile.kind === 'joker') {
    return tile.resolvedFace ? `조커: ${tile.resolvedFace.value} ${colorName(tile.resolvedFace.color)}` : '조커';
  }
  return `${tile.value} ${colorName(tile.color)}`;
}

function colorName(color) {
  return ({ red: '빨강', blue: '파랑', orange: '주황', black: '검정' })[color] || '';
}

function tileHtml(tile, source, groupId, editable) {
  const selectedHere = selected && selected.tileId === tile.id && selected.source === source && selected.groupId === groupId;
  const batchSelected = batchMatches(source, groupId || '', tile.id);
  const resolved = tile.kind === 'joker' && tile.resolvedFace ? `<small>${tile.resolvedFace.value}${tile.resolvedFace.color.slice(0, 1).toUpperCase()}</small>` : '';
  const color = tile.kind === 'joker' ? 'joker' : tile.color;
  const tag = editable ? 'button' : 'span';
  const data = editable ? `data-action="select-tile" data-source="${source}" data-group-id="${escapeHtml(groupId || '')}" data-tile-id="${tile.id}"` : '';
  const drag = editable ? 'draggable="true" data-drag-tile="true"' : '';
  return `<${tag} class="tile ${color} ${selectedHere ? 'selected' : ''} ${batchSelected ? 'batch-selected' : ''}" ${data} ${drag} aria-label="${faceDescription(tile)}" title="${faceDescription(tile)}"><b>${tile.kind === 'joker' ? '★' : tile.value}</b>${resolved}<i></i></${tag}>`;
}

function meldHtml(group, editable) {
  const canTarget = editable && (state.you.hasOpened || !group.existing);
  const dropData = editable && canTarget
    ? `data-drop-zone="group" data-group-id="${escapeHtml(group.id)}"` 
    : editable && group.existing ? 'data-drop-blocked="true"' : '';
  return `
    <article class="meld ${group.existing ? 'existing' : 'new'}" ${dropData}>
      <div class="meld-header"><span>${group.type === 'run' ? '연속 수열' : group.type === 'group' ? '숫자 그룹' : '새 조합'}</span>${group.existing ? '<small>보드</small>' : '<small>초안</small>'}</div>
      <div class="meld-tiles">
        ${group.tiles.map((tile) => tileHtml(tile, 'group', group.id, editable && (state.you.hasOpened || !group.existing))).join('')}
        ${canTarget ? `<button class="tile-target" data-action="add-to-group" data-group-id="${group.id}" ${selected ? '' : 'disabled'}>+<span>선택 타일</span></button>` : ''}
      </div>
    </article>`;
}

function selectedLabel() {
  if (batchSelection) return batchStatusText(batchSelection);
  if (!selected) return '타일을 하나 선택하세요';
  const source = selected.source === 'rack' ? '손패' : '보드';
  return `${source}의 ${faceDescription(selected.tile)} 선택됨`;
}

function opponentsHtml() {
  return state.room.players.map((player) => {
    const status = player.isActive
      ? (player.isBot ? 'AI가 수를 계산 중' : '지금 플레이 중')
      : player.hasOpened ? '첫 등록 완료' : '첫 등록 전';
    return `
      <article class="seat-card ${player.isActive ? 'active' : ''} ${player.isYou ? 'me' : ''} ${player.isBot ? 'bot' : ''}">
        <div class="seat-top"><span class="avatar">${player.isBot ? 'AI' : escapeHtml(player.name.slice(0, 1))}</span><span>${escapeHtml(player.name)}${player.isYou ? ' <small>나</small>' : ''}</span>${player.isBot ? '<i class="ai-chip">AI</i>' : player.host ? '<i>방장</i>' : ''}</div>
        <strong>${player.isYou ? '내 손패' : '남은 타일'} <b>${player.tileCount}</b></strong>
        <span class="seat-state">${status}</span>
      </article>`;
  }).join('');
}

function opponentSubmissionHistoryHtml() {
  const entries = (state.recentSubmissions || [])
    .filter((entry) => entry?.player?.id && entry.player.id !== state.you?.id)
    .slice(0, 4);
  const cards = entries.length
    ? entries.map((entry) => {
      const meldTypes = [...new Set((entry.groups || []).map((group) => (
        group.type === 'run' ? '연속 수열' : group.type === 'group' ? '숫자 그룹' : '새 조합'
      )))].join(' · ');
      const playerName = entry.player.isBot ? `${entry.player.name} AI` : entry.player.name;
      return `
        <article class="submission-entry">
          <header><strong>${escapeHtml(playerName)}</strong><span>${entry.tiles.length}장 제출</span></header>
          <div class="submission-tiles">${entry.tiles.map((tile) => tileHtml(tile, 'history', '', false)).join('')}</div>
          ${meldTypes ? `<small>${escapeHtml(meldTypes)}</small>` : ''}
        </article>`;
    }).join('')
    : '<p class="submission-empty">아직 상대가 낸 패가 없습니다.</p>';
  return `
    <section class="submission-history-card" aria-live="polite">
      <div class="submission-history-heading"><div><p class="eyebrow">RECENT OPPONENT PLAY</p><h2>상대가 최근 낸 패</h2></div><span>최근 ${entries.length}건</span></div>
      <div class="submission-history-list">${cards}</div>
    </section>`;
}
function turnClock() {
  const turn = state.turn;
  if (!turn) return '';
  const active = state.room.players.find((player) => player.id === turn.activePlayerId);
  const status = turn.isYourTurn
    ? '내 턴'
    : active?.isBot ? `${escapeHtml(turn.activePlayerName)}가 생각 중` : `${escapeHtml(turn.activePlayerName)}의 턴`;
  const renderedAt = Date.now();
  return `<div class="turn-status ${turn.isYourTurn ? 'your-turn' : ''} ${active?.isBot ? 'ai-turn' : ''}"><span>${status}</span><strong class="turn-clock" data-deadline="${turn.deadlineAt}" data-server-now="${state.serverNow}" data-rendered-at="${renderedAt}">--:--</strong></div>`;
}

function gamePage() {
  const turn = state.turn;
  const isYourTurn = Boolean(turn?.isYourTurn);
  const canEdit = isYourTurn && state.room.phase === 'playing';
  const soloMode = state.room.mode === 'solo';
  const activeOpponent = state.room.players.find((player) => player.id === turn?.activePlayerId);
  const shownGroups = canEdit && draft ? draft.groups : state.board.map((group) => ({ ...group, existing: true }));
  const shownRack = canEdit && draft ? draft.rack : applyRememberedRackOrder(state.you.rack.map(cloneTile));
  const opening = !state.you.hasOpened;
  const dirty = canEdit && isDraftDirty();
  const formulaText = soloMode && activeOpponent?.isBot && !canEdit
    ? '=AI_STATUS("계산 중")'
    : canEdit
      ? `=TURN("${escapeHtml(state.you.name)}") · ${opening ? 'FIRST_MELD ≥ 30' : dirty ? 'DRAFT_EDITING' : 'READY'}`
      : '=TURN_STATUS("읽기 전용")';
  const columnHeaders = Array.from({ length: 26 }, (_, index) => `<span>${String.fromCharCode(65 + index)}</span>`).join('');
  const rowHeaders = Array.from({ length: 38 }, (_, index) => `<span>${index + 1}</span>`).join('');
  const rackControls = canEdit
    ? `<div class="rack-tools" aria-label="손패 정렬"><span>정렬</span><button class="text-button" data-action="sort-rack" data-sort="sequence" title="색상별 1부터 13까지 정렬">숫자순</button><button class="text-button" data-action="sort-rack" data-sort="group" title="같은 숫자의 색상을 모아 정렬">같은 숫자 모으기</button></div>`
    : '';
  const boardContent = shownGroups.length
    ? shownGroups.map((group) => meldHtml(group, canEdit)).join('')
    : `<div class="empty-board"><span>◇</span><p>아직 보드 위에 조합이 없습니다.</p><small>${canEdit ? '손패 타일을 선택해 새 조합을 만드세요.' : '첫 번째 유효 조합을 기다리는 중입니다.'}</small></div>`;
  return `
    ${header(true)}
    <main class="game-page ${soloMode ? 'solo-mode' : ''}">
      <div class="workbook-formula-row" aria-hidden="true"><span class="name-box">E24</span><span class="formula-confirm">×</span><span class="formula-confirm ok">✓</span><strong>fx</strong><p>${formulaText}</p></div>
      <div class="worksheet-frame">
        <div class="worksheet-corner" aria-hidden="true"></div>
        <div class="workbook-column-headers" aria-hidden="true">${columnHeaders}</div>
        <div class="workbook-row-headers" aria-hidden="true">${rowHeaders}</div>
        <div class="workbook-sheet-content">
          <div class="sheet-menu" aria-hidden="true"><span>파일</span><span>편집</span><span>보기</span><span>게임</span><div></div><small>공유됨 · 자동 저장됨</small></div>
          <section class="game-banner">
            <div class="room-label"><span class="eyebrow">${soloMode ? 'AI PRACTICE' : `ROOM ${state.room.code}`}</span><h1>${escapeHtml(GAME_TITLE)}</h1></div>
            ${turnClock()}
            <div class="pool-badge"><span>풀</span><strong>${state.poolCount}</strong></div>
          </section>
          <section class="seat-grid">${opponentsHtml()}</section>
          <section class="board-card ${canEdit ? 'editing' : ''}">
            <div class="formula-bar"><span>fx</span><p>${opening ? '첫 등록: 손패 타일만으로 30점 이상' : canEdit ? (dirty ? '개인 초안 편집 중 · 상대에게는 아직 보이지 않음' : '보드 중간 패를 길게 눌러 뒤쪽을 함께 잡을 수 있어요') : '보드의 유효한 조합'}</p><small>${canEdit ? `${state.room.turnSeconds}초 턴` : '읽기 전용'}</small></div>
            <div class="board-toolbar">
              <div><p class="eyebrow">TABLE</p><h2>게임 보드</h2></div>
              ${canEdit ? `<div class="edit-tools"><span class="selected-label ${selected || batchSelection ? 'has-selection' : ''}">${escapeHtml(selectedLabel())}</span><button class="outline-button" data-action="new-group" ${selected ? '' : 'disabled'}>+ 새 조합</button>${selected?.source === 'group' ? '<button class="outline-button" data-action="to-rack">임시 손패로</button>' : ''}<button class="text-button" data-action="undo-draft" ${dirty ? '' : 'disabled'}>되돌리기</button></div>` : ''}
            </div>
            <div class="board-grid" data-board-density="normal" role="region" tabindex="0" aria-label="게임 보드" ${canEdit ? 'data-drop-zone="board"' : ''}>${boardContent}</div>
            <p class="board-density-status" data-board-density-status aria-live="polite" hidden></p>${canEdit ? `<p class="board-batch-status" data-board-batch-status aria-live="polite" hidden></p>` : ''}
            ${canEdit && opening && state.board.length > 0 ? '<p class="opening-alert">첫 등록 전에는 기존 보드를 바꾸거나 타일을 더할 수 없습니다.</p>' : ''}
          </section>
          ${opponentSubmissionHistoryHtml()}
          <section class="rack-card ${canEdit ? 'editing' : ''}">
            <div class="rack-heading"><div><p class="eyebrow">MY RACK</p><h2>${canEdit ? '내 손패와 임시 대기열' : '내 손패'}</h2></div><div class="rack-heading-actions"><div class="rack-hint">${canEdit ? '손패는 연속 패를 길게 눌러 묶고 · 보드는 중간을 길게 눌러 뒤쪽 묶기' : soloMode && activeOpponent?.isBot ? 'AI가 수를 계산 중입니다' : '상대 턴에는 읽기 전용'}</div>${rackControls}</div></div>
            <div class="rack-tiles ${shownRack.length ? '' : 'empty'}" ${canEdit ? 'data-drop-zone="rack"' : ''}>${shownRack.length ? shownRack.map((tile) => tileHtml(tile, 'rack', '', canEdit)).join('') : '<span>손패가 없습니다.</span>'}</div>${canEdit ? `<p class="rack-batch-status" data-rack-batch-status aria-live="polite" ${batchSelection?.source === 'rack' ? '' : 'hidden'}>${escapeHtml(batchStatusText())}</p>` : ''}
            <div class="turn-actions">
              <button class="draw-button" data-action="draw-tile" ${canEdit ? '' : 'disabled'}><span>＋</span>${state.poolCount ? '1장 뽑고 턴 끝내기' : '패스하고 턴 끝내기'}</button>
              <button class="submit-button" data-action="submit-turn" ${canEdit && dirty ? '' : 'disabled'}>검증 후 제출 <span>↗</span></button>
            </div>
            ${canEdit ? `<p class="turn-note">${opening ? '첫 등록은 30점 이상이어야 합니다. 손패와 새 조합은 드래그로 정리할 수 있어요.' : '타일을 드래그해 조합·손패 사이를 옮길 수 있고, 제출 시 조합은 서버가 검증합니다.'}</p>` : ''}
          </section>
          <section class="activity-card"><p class="eyebrow">ACTIVITY</p><div>${state.log.slice(0, 4).map((item) => `<span>${escapeHtml(item.text)}</span>`).join('')}</div></section>
        </div>
      </div>
      <footer class="workbook-bottom-bar" aria-hidden="true"><span class="workbook-status">준비 · 자동 저장됨</span><div class="workbook-sheets"><b>기록</b><b class="active">게임</b><b class="new-sheet">＋</b></div><div class="workbook-views"><span>▦</span><span>▤</span><i></i><small>100%</small><span>＋</span></div></footer>
      ${state.room.phase === 'finished' ? resultOverlay() : ''}
    </main>`;
}

function resultOverlay() {
  const result = state.result;
  if (!result) return '';
  const winnerNames = result.winnerIds.map((id) => result.scores.find((score) => score.id === id)?.name).filter(Boolean).join(', ');
  return `
    <div class="result-overlay">
      <section class="result-card">
        <p class="eyebrow">GAME COMPLETE</p>
        <h2>${winnerNames ? `${escapeHtml(winnerNames)} ${result.winnerIds.length > 1 ? '공동 승리' : '승리'}` : '게임 종료'}</h2>
        <p>${result.reason === 'empty-rack' ? '손패를 모두 내려 먼저 승리했습니다.' : '풀이 소진되어 가장 낮은 손패 합계로 종료했습니다.'}</p>
        <div class="score-table">${result.scores.map((score) => `<div class="${result.winnerIds.includes(score.id) ? 'winner' : ''}"><span>${escapeHtml(score.name)}</span><small>손패 ${score.tilesLeft}장 · ${score.tileTotal}점</small><strong>${score.score > 0 ? '+' : ''}${score.score}</strong></div>`).join('')}</div>
        ${state.room.mode === 'solo' ? '<button class="primary-button" data-action="play-solo-again">AI와 다시 하기 <span>↻</span></button>' : ''}
        <button class="${state.room.mode === 'solo' ? 'secondary-button' : 'primary-button'}" data-action="home">첫 화면으로 <span>→</span></button>
      </section>
    </div>`;
}

function captureScrollState() {
  const board = document.querySelector('.board-grid');
  const sheet = document.querySelector('.workbook-sheet-content');
  return {
    board: board ? { left: board.scrollLeft, top: board.scrollTop } : null,
    sheet: sheet ? { left: sheet.scrollLeft, top: sheet.scrollTop } : null,
    page: { left: window.scrollX || 0, top: window.scrollY || 0 },
  };
}

function syncWorksheetHeaderOffsets() {
  const sheet = document.querySelector('.workbook-sheet-content');
  const columns = document.querySelector('.workbook-column-headers');
  const rows = document.querySelector('.workbook-row-headers');
  if (!sheet || (!columns && !rows)) return;
  if (columns) columns.style.transform = `translateX(${-sheet.scrollLeft}px)`;
  if (rows) rows.style.transform = `translateY(${-sheet.scrollTop}px)`;
}

function fitBoardDensity() {
  const board = document.querySelector('.board-grid');
  if (!board) return;
  const densities = ['normal', 'compact', 'tight', 'ultra'];
  let density = densities[densities.length - 1];
  for (const candidate of densities) {
    board.dataset.boardDensity = candidate;
    if (board.scrollHeight <= board.clientHeight + 1) {
      density = candidate;
      break;
    }
  }
  board.dataset.boardDensity = density;
  const overflowing = board.scrollHeight > board.clientHeight + 1;
  board.classList.toggle('board-overflowing', overflowing);
  const status = document.querySelector('[data-board-density-status]');
  if (status) {
    status.hidden = density === 'normal' && !overflowing;
    status.textContent = overflowing
      ? '패가 많아 가장 작은 보기로 압축했습니다 · 보드 안에서만 스크롤됩니다'
      : `패가 많아 ${density === 'compact' ? '한 단계' : density === 'tight' ? '두 단계' : '세 단계'} 압축해 표시 중입니다`;
  }
}

function restoreScrollState(snapshot, sequence) {
  const restore = () => {
    if (sequence !== renderSequence) return;
    const board = document.querySelector('.board-grid');
    const sheet = document.querySelector('.workbook-sheet-content');
    if (board && snapshot.board) {
      board.scrollLeft = snapshot.board.left;
      board.scrollTop = snapshot.board.top;
    }
    if (sheet && snapshot.sheet) {
      sheet.scrollLeft = snapshot.sheet.left;
      sheet.scrollTop = snapshot.sheet.top;
    }
    if (snapshot.page && typeof window.scrollTo === 'function') {
      window.scrollTo(snapshot.page.left, snapshot.page.top);
    }
    syncWorksheetHeaderOffsets();
  };
  restore();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
}

function render() {
  const scrollState = captureScrollState();
  const sequence = ++renderSequence;
  document.body.dataset.theme = theme();
  if (!state) app.innerHTML = homePage();
  else if (!state.you) app.innerHTML = homePage();
  else if (state.room.phase === 'lobby') app.innerHTML = lobbyPage();
  else app.innerHTML = gamePage();
  updateClock();
  fitBoardDensity();
  restoreScrollState(scrollState, sequence);
  syncWorksheetHeaders();
}

function syncWorksheetHeaders() {
  const sheet = document.querySelector('.workbook-sheet-content');
  const columns = document.querySelector('.workbook-column-headers');
  const rows = document.querySelector('.workbook-row-headers');
  if (!sheet || (!columns && !rows)) return;
  sheet.addEventListener('scroll', syncWorksheetHeaderOffsets, { passive: true });
  syncWorksheetHeaderOffsets();
}
function updateClock() {
  document.querySelectorAll('.turn-clock').forEach((clock) => {
    const deadline = Number(clock.dataset.deadline);
    const serverNow = Number(clock.dataset.serverNow);
    const renderedAt = Number(clock.dataset.renderedAt);
    if (!Number.isFinite(deadline) || !Number.isFinite(serverNow) || !Number.isFinite(renderedAt)) {
      clock.textContent = '--:--';
      return;
    }
    const initialRemaining = Math.max(0, deadline - serverNow);
    const remaining = Math.max(0, initialRemaining - (Date.now() - renderedAt));
    const seconds = Math.ceil(remaining / 1000);
    clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    clock.classList.toggle('urgent', seconds <= 10);
  });
}
setInterval(updateClock, 250);

function findDraftTile(source, groupId, tileId) {
  if (!draft) return null;
  if (source === 'rack') {
    const index = draft.rack.findIndex((tile) => tile.id === tileId);
    return index === -1 ? null : { tile: draft.rack[index], list: draft.rack, index };
  }
  const group = draft.groups.find((entry) => entry.id === groupId);
  if (!group) return null;
  const index = group.tiles.findIndex((tile) => tile.id === tileId);
  return index === -1 ? null : { tile: group.tiles[index], list: group.tiles, index, group };
}

function takeDraftTile(source, groupId, tileId) {
  const found = findDraftTile(source, groupId, tileId);
  if (!found) return null;
  found.list.splice(found.index, 1);
  if (found.group && found.group.tiles.length === 0) {
    draft.groups = draft.groups.filter((group) => group.id !== found.group.id);
  }
  return found.tile;
}

function insertDroppedTiles(list, tiles, targetTileId = '', placeAfter = false) {
  const targetIndex = targetTileId ? list.findIndex((entry) => entry.id === targetTileId) : -1;
  if (targetIndex < 0) list.push(...tiles);
  else list.splice(targetIndex + (placeAfter ? 1 : 0), 0, ...tiles);
}

function dragTileIds(drag) {
  const ids = Array.isArray(drag?.tileIds) && drag.tileIds.length ? drag.tileIds : [drag?.tileId];
  return [...new Set(ids.filter(Boolean))];
}

function isOriginalBoardTile(tileId) {
  return Boolean(state?.board?.some((group) => group.tiles.some((tile) => tile.id === tileId)));
}

function moveDraftTile(drag, destination) {
  if (!draft || !state?.turn?.isYourTurn || !drag || !destination) return false;
  const tileIds = dragTileIds(drag);
  if (!tileIds.length || !['rack', 'group', 'new-group'].includes(destination.type)) return false;

  const sourceTiles = tileIds.map((tileId) => findDraftTile(drag.source, drag.groupId, tileId));
  if (sourceTiles.some((source) => !source)) return false;
  if (sourceTiles.some((source) => source.group?.existing && !state.you.hasOpened)) {
    showToast('첫 등록 전에는 기존 보드 타일을 움직일 수 없습니다.', 'error');
    return false;
  }
  if (destination.type === 'rack' && tileIds.some(isOriginalBoardTile)) {
    showToast('턴 시작 시 보드에 있던 타일은 손패로 가져갈 수 없습니다.', 'error');
    return false;
  }

  let targetGroup = null;
  if (destination.type === 'group') {
    targetGroup = draft.groups.find((group) => group.id === destination.groupId);
    if (!targetGroup) return false;
    if (targetGroup.existing && !state.you.hasOpened) {
      showToast('첫 등록 전에는 기존 조합에 타일을 더할 수 없습니다.', 'error');
      return false;
    }
    if (drag.source === 'group' && drag.groupId === destination.groupId
      && (!destination.targetTileId || tileIds.includes(destination.targetTileId))) return false;
  }
  if (destination.type === 'rack' && drag.source === 'rack'
    && destination.targetTileId && tileIds.includes(destination.targetTileId)) return false;

  const tiles = tileIds.map((tileId) => takeDraftTile(drag.source, drag.groupId, tileId));
  if (tiles.some((tile) => !tile)) return false;

  if (destination.type === 'rack') {
    insertDroppedTiles(draft.rack, tiles, destination.targetTileId, destination.placeAfter);
  } else if (destination.type === 'group') {
    insertDroppedTiles(targetGroup.tiles, tiles, destination.targetTileId, destination.placeAfter);
  } else {
    draft.groups.push({
      id: `draft-${crypto.randomUUID().replace(/-/g, '')}`,
      type: '',
      existing: false,
      tiles,
    });
  }
  if (drag.source === 'rack' || destination.type === 'rack') rememberRackOrder(draft.rack);
  afterDraftChange();
  return true;
}

function compareRackTiles(left, right, mode) {
  const leftJoker = left.kind === 'joker';
  const rightJoker = right.kind === 'joker';
  if (leftJoker || rightJoker) return Number(leftJoker) - Number(rightJoker);
  const leftColor = colors.indexOf(left.color);
  const rightColor = colors.indexOf(right.color);
  return mode === 'sequence'
    ? leftColor - rightColor || left.value - right.value
    : left.value - right.value || leftColor - rightColor;
}

function sortRack(mode) {
  if (!draft || !state?.turn?.isYourTurn) return;
  clearBatchSelection();
  draft.rack = draft.rack
    .map((tile, index) => ({ tile, index }))
    .sort((left, right) => compareRackTiles(left.tile, right.tile, mode) || left.index - right.index)
    .map(({ tile }) => tile);
  rememberRackOrder(draft.rack);
  render();
}
function selectTile(button) {
  if (!state?.turn?.isYourTurn || !draft) return;
  clearBatchSelection();
  const source = button.dataset.source;
  const groupId = button.dataset.groupId || '';
  const tileId = button.dataset.tileId;
  const found = findDraftTile(source, groupId, tileId);
  if (!found) return;
  if (found.group?.existing && !state.you.hasOpened) {
    showToast('첫 등록 전에는 기존 보드 타일을 움직일 수 없습니다.', 'error');
    return;
  }
  if (selected?.tileId === tileId && selected?.source === source && selected?.groupId === groupId) selected = null;
  else selected = { source, groupId, tileId, tile: found.tile };
  render();
}

function takeSelected() {
  if (!selected) return null;
  return takeDraftTile(selected.source, selected.groupId, selected.tileId);
}

function afterDraftChange() {
  clearBatchSelection();
  selected = null;
  syncDraftStatus();
  render();
}

function createGroupFromSelected() {
  if (!selected || !draft) return;
  const tile = takeSelected();
  if (!tile) return;
  draft.groups.push({ id: `draft-${crypto.randomUUID().replace(/-/g, '')}`, type: '', existing: false, tiles: [tile] });
  afterDraftChange();
}

function addSelectedToGroup(groupId) {
  if (!selected || !draft) return;
  const target = draft.groups.find((group) => group.id === groupId);
  if (!target) return;
  if (!state.you.hasOpened && target.existing) {
    showToast('첫 등록 전에는 기존 조합에 타일을 더할 수 없습니다.', 'error');
    return;
  }
  if (selected.source === 'group' && selected.groupId === groupId) return;
  const tile = takeSelected();
  if (!tile) return;
  target.tiles.push(tile);
  afterDraftChange();
}

function moveSelectedToRack() {
  if (!selected || selected.source !== 'group' || !draft) return;
  if (isOriginalBoardTile(selected.tileId)) {
    showToast('턴 시작 시 보드에 있던 타일은 손패로 가져갈 수 없습니다.', 'error');
    return;
  }
  const tile = takeSelected();
  if (!tile) return;
  draft.rack.push(tile);
  afterDraftChange();
}

function undoDraft() {
  hydrateDraft(state);
  syncDraftStatus();
  render();
}

async function submitTurn() {
  if (!draft || !isDraftDirty()) return;
  try {
    const response = await api(`/api/rooms/${activeRoomCode}/action`, {
      method: 'POST',
      body: JSON.stringify({
        clientId,
        action: 'submit',
        board: draft.groups.map((group) => ({ id: group.id, tileIds: group.tiles.map((tile) => tile.id) })),
        rackIds: draft.rack.map((tile) => tile.id),
      }),
    });
    receiveState(response);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function drawTile() {
  if (!state?.turn?.isYourTurn) return;
  try {
    const response = await api(`/api/rooms/${activeRoomCode}/action`, {
      method: 'POST',
      body: JSON.stringify({ clientId, action: 'draw' }),
    });
    receiveState(response);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function startSoloGame(form = null, replay = null) {
  const data = form ? new FormData(form) : null;
  const playerName = data ? data.get('playerName') : replay?.playerName || state?.you?.name || '나';
  const turnSeconds = data ? data.get('turnSeconds') : replay?.turnSeconds || state?.room?.turnSeconds || 60;
  try {
    const response = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        clientId,
        playerName,
        name: 'AI 연습전',
        maxPlayers: 2,
        turnSeconds,
        mode: 'solo',
      }),
    });
    activateRoom(response.roomCode, response.state);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function createRoom(form) {
  const data = new FormData(form);
  try {
    const response = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        clientId,
        playerName: data.get('playerName'),
        name: data.get('name'),
        maxPlayers: data.get('maxPlayers'),
        turnSeconds: data.get('turnSeconds'),
      }),
    });
    activateRoom(response.roomCode, response.state);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function joinRoom(form) {
  const data = new FormData(form);
  const code = shortCode(data.get('code'));
  if (code.length !== 6) {
    showToast('6자리 초대 코드를 입력해 주세요.', 'error');
    return;
  }
  try {
    const response = await api(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: JSON.stringify({ clientId, playerName: data.get('playerName') }),
    });
    activateRoom(code, response.state);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function saveSettings(form) {
  const data = new FormData(form);
  try {
    const response = await api(`/api/rooms/${activeRoomCode}/settings`, {
      method: 'POST',
      body: JSON.stringify({ clientId, name: data.get('name'), maxPlayers: data.get('maxPlayers'), turnSeconds: data.get('turnSeconds') }),
    });
    receiveState(response);
    showToast('방 설정을 저장했습니다.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function startGame() {
  try {
    const response = await api(`/api/rooms/${activeRoomCode}/action`, {
      method: 'POST',
      body: JSON.stringify({ clientId, action: 'start' }),
    });
    receiveState(response);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function copyInvite() {
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(activeRoomCode)}`;
  try {
    await navigator.clipboard.writeText(link);
    showToast('초대 링크를 복사했습니다.');
  } catch {
    showToast(`초대 코드: ${activeRoomCode}`);
  }
}

function clearDragFeedback() {
  document.querySelectorAll('.dragging, .batch-dragging, .drag-over').forEach((element) => {
    element.classList.remove('dragging', 'batch-dragging', 'drag-over');
  });
}

function dropDestination(target, clientX) {
  if (target.dataset.dragTile) {
    const box = target.getBoundingClientRect();
    const placeAfter = clientX > box.left + box.width / 2;
    return target.dataset.source === 'rack'
      ? { type: 'rack', targetTileId: target.dataset.tileId, placeAfter }
      : { type: 'group', groupId: target.dataset.groupId, targetTileId: target.dataset.tileId, placeAfter };
  }
  if (target.dataset.dropZone === 'rack') return { type: 'rack' };
  if (target.dataset.dropZone === 'group') return { type: 'group', groupId: target.dataset.groupId };
  if (target.dataset.dropZone === 'board') return { type: 'new-group' };
  return null;
}

document.addEventListener('pointerdown', (event) => {
  if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
  const tile = event.target.closest('[data-drag-tile]');
  if (!tile || !draft || !state?.turn?.isYourTurn) return;
  const source = tile.dataset.source;
  const groupId = tile.dataset.groupId || '';
  if (batchMatches(source, groupId, tile.dataset.tileId)) return;
  beginTileHold(tile, event);
});

document.addEventListener('pointermove', (event) => {
  if (!tileHold || tileHold.pointerId !== event.pointerId || tileHold.active) return;
  if (Math.hypot(event.clientX - tileHold.startX, event.clientY - tileHold.startY) > 8) stopTileHold();
});

document.addEventListener('pointerup', (event) => {
  if (!tileHold || tileHold.pointerId !== event.pointerId) return;
  const completedHold = tileHold.active;
  stopTileHold();
  paintBatchSelection();
  if (completedHold) suppressTileClickUntil = Date.now() + 420;
});

document.addEventListener('pointercancel', (event) => {
  if (!tileHold || tileHold.pointerId !== event.pointerId) return;
  const completedHold = tileHold.active;
  stopTileHold();
  paintBatchSelection();
  if (completedHold) suppressTileClickUntil = Date.now() + 420;
});

window.addEventListener('blur', clearBatchSelection);
window.addEventListener('resize', () => {
  clearTimeout(boardFitTimer);
  boardFitTimer = setTimeout(fitBoardDensity, 120);
});

document.addEventListener('dragstart', (event) => {
  const tile = event.target.closest('[data-drag-tile]');
  if (!tile || !draft || !state?.turn?.isYourTurn) return;
  const sourceName = tile.dataset.source;
  const groupId = tile.dataset.groupId || '';
  const tileId = tile.dataset.tileId;
  const useBatch = batchMatches(sourceName, groupId, tileId);
  const tileIds = (useBatch ? batchSelection.tileIds : [tileId])
    .filter((id) => Boolean(findDraftTile(sourceName, groupId, id)));
  if (!tileIds.length) return;
  if (tileHold) {
    stopTileHold();
    paintBatchSelection();
  }
  if (!useBatch) clearBatchSelection();

  const source = findDraftTile(sourceName, groupId, tileId);
  if (!source || (source.group?.existing && !state.you.hasOpened)) return;
  draggedTile = { source: sourceName, groupId, tileId, tileIds: [...tileIds] };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', tileIds.join(','));
  document.querySelectorAll('[data-drag-tile]').forEach((entry) => {
    if (tileIds.includes(entry.dataset.tileId)) entry.classList.add('dragging', 'batch-dragging');
  });
});

document.addEventListener('dragover', (event) => {
  if (!draggedTile) return;
  const target = event.target.closest('[data-drag-tile], [data-drop-zone], [data-drop-blocked]');
  if (!target || target.dataset.dropBlocked) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drag-over').forEach((element) => element.classList.remove('drag-over'));
  if (!(target.dataset.dragTile && draggedTile.tileIds.includes(target.dataset.tileId))) target.classList.add('drag-over');
});

document.addEventListener('drop', (event) => {
  if (!draggedTile) return;
  const target = event.target.closest('[data-drag-tile], [data-drop-zone], [data-drop-blocked]');
  if (!target || target.dataset.dropBlocked) return;
  event.preventDefault();
  const destination = dropDestination(target, event.clientX);
  moveDraftTile(draggedTile, destination);
  lastDragAt = Date.now();
  draggedTile = null;
  clearDragFeedback();
});

document.addEventListener('dragend', () => {
  if (draggedTile) lastDragAt = Date.now();
  draggedTile = null;
  stopTileHold();
  paintBatchSelection();
  clearDragFeedback();
});

document.addEventListener('submit', (event) => {
  if (event.target.id === 'soloGameForm') { event.preventDefault(); startSoloGame(event.target); }
  if (event.target.id === 'createRoomForm') { event.preventDefault(); createRoom(event.target); }
  if (event.target.id === 'joinRoomForm') { event.preventDefault(); joinRoom(event.target); }
  if (event.target.id === 'roomSettingsForm') { event.preventDefault(); saveSettings(event.target); }
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'select-tile' && (Date.now() - lastDragAt < 260 || Date.now() < suppressTileClickUntil)) return;
  if (action === 'home') goHome();
  if (action === 'theme') applyTheme(button.dataset.theme);
  if (action === 'rules') rulesDialog.showModal();
  if (action === 'copy-invite') copyInvite();
  if (action === 'start-game') startGame();
  if (action === 'play-solo-again') startSoloGame(null, { playerName: state?.you?.name, turnSeconds: state?.room?.turnSeconds });
  if (action === 'select-tile') selectTile(button);
  if (action === 'new-group') createGroupFromSelected();
  if (action === 'add-to-group') addSelectedToGroup(button.dataset.groupId);
  if (action === 'to-rack') moveSelectedToRack();
  if (action === 'undo-draft') undoDraft();
  if (action === 'submit-turn') submitTurn();
  if (action === 'draw-tile') drawTile();
  if (action === 'sort-rack') sortRack(button.dataset.sort);
});

async function init() {
  applyTheme(theme(), false);
  const saved = localStorage.getItem(ROOM_KEY);
  const code = pendingRoomCode || saved;
  if (code) {
    try {
      const snapshot = await api(`/api/rooms/${shortCode(code)}?clientId=${encodeURIComponent(clientId)}`);
      if (snapshot.you) activateRoom(shortCode(code), snapshot);
      else {
        pendingRoomCode = shortCode(code);
        render();
      }
      return;
    } catch {
      localStorage.removeItem(ROOM_KEY);
      pendingRoomCode = '';
    }
  }
  render();
}

init();

