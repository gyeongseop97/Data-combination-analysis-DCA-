/*
 * Office Rummikub — dependency-free Node.js server.
 * The browser never receives other players' racks or the draw-pile order.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, 'public');
const COLORS = ['red', 'blue', 'orange', 'black'];
const COLOR_ORDER = Object.fromEntries(COLORS.map((color, index) => [color, index]));
const rooms = new Map();
const listeners = new Map();

// The local server keeps timers and SSE listeners in memory. Vercel functions
// switch to durable mode and persist only serializable room state in Redis.
let runtimeOptions = { durable: false };

function configureGameRuntime(options = {}) {
  runtimeOptions = { ...runtimeOptions, ...options };
}

function isDurableRuntime() {
  return Boolean(runtimeOptions.durable);
}

const TILE_CATALOG = new Map();
for (const color of COLORS) {
  for (let value = 1; value <= 13; value += 1) {
    for (let copy = 1; copy <= 2; copy += 1) {
      const id = `n-${color}-${value}-${copy}`;
      TILE_CATALOG.set(id, { id, kind: 'number', color, value });
    }
  }
}
for (let copy = 1; copy <= 2; copy += 1) {
  const id = `j-${copy}`;
  TILE_CATALOG.set(id, { id, kind: 'joker' });
}
const ALL_TILE_IDS = [...TILE_CATALOG.keys()];

function randomId(prefix = '') {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function shuffle(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function cleanName(value, fallback) {
  const clean = String(value || '').replace(/[<>]/g, '').trim().slice(0, 24);
  return clean || fallback;
}

function cleanRoomName(value) {
  return cleanName(value, '조용한 루미큐브 방').slice(0, 36);
}

function cleanClientId(value) {
  const clean = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(clean)) {
    throw new Error('브라우저 식별자가 올바르지 않습니다. 새로고침 후 다시 시도해 주세요.');
  }
  return clean;
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function turnSeconds(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 600 || seconds % 30 !== 0) {
    throw new Error('턴 시간은 30초 단위, 30~600초 범위여야 합니다.');
  }
  return seconds;
}

function maxPlayers(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 2 || count > 4) {
    throw new Error('인원은 2명에서 4명 사이여야 합니다.');
  }
  return count;
}

function log(room, text) {
  room.log.unshift({ id: randomId('log-'), text, at: Date.now() });
  room.log = room.log.slice(0, 14);
}

function tileForClient(id, binding) {
  const tile = TILE_CATALOG.get(id);
  if (!tile) return null;
  return binding ? { ...tile, resolvedFace: binding } : { ...tile };
}

function serializeMeld(meld) {
  return {
    id: meld.id,
    type: meld.type,
    tiles: meld.tileIds.map((id) => tileForClient(id, meld.jokerBindings[id])).filter(Boolean),
  };
}

// A submission is deliberately a public-game record: it contains only the
// tiles that have left a player's rack and the already-public melds they went
// into. It never retains a snapshot of a rack or the draw pile.
function serializeRecentSubmission(submission) {
  return {
    id: submission.id,
    at: submission.at,
    player: { ...submission.player },
    tiles: submission.tiles.map((tile) => ({
      ...tile,
      ...(tile.resolvedFace ? { resolvedFace: { ...tile.resolvedFace } } : {}),
    })),
    groups: submission.groups.map((group) => ({
      id: group.id,
      type: group.type,
      newTileIds: [...group.newTileIds],
      tiles: group.tiles.map((tile) => ({
        ...tile,
        ...(tile.resolvedFace ? { resolvedFace: { ...tile.resolvedFace } } : {}),
      })),
    })),
  };
}

function getPlayer(room, clientId) {
  return room.players.find((player) => player.id === clientId) || null;
}

function activePlayer(room) {
  return room.players[room.activeIndex] || null;
}

function publicPlayer(room, player, viewerId) {
  return {
    id: player.id,
    name: player.name,
    isBot: Boolean(player.isBot),
    host: player.id === room.hostId,
    tileCount: player.rack.length,
    hasOpened: player.hasOpened,
    isYou: player.id === viewerId,
    isActive: room.phase === 'playing' && activePlayer(room)?.id === player.id,
  };
}

function roomView(room, viewerId) {
  const viewer = getPlayer(room, viewerId);
  const current = activePlayer(room);
  return {
    serverNow: Date.now(),
    room: {
      code: room.code,
      name: room.name,
      maxPlayers: room.maxPlayers,
      turnSeconds: room.turnSeconds,
      mode: room.mode || 'multiplayer',
      visibility: room.visibility || (room.mode === 'solo' ? 'private' : 'invite'),
      phase: room.phase,
      revision: Number(room.revision || 0),
      hostId: room.hostId,
      players: room.players.map((player) => publicPlayer(room, player, viewerId)),
    },
    you: viewer
      ? {
          id: viewer.id,
          name: viewer.name,
          hasOpened: viewer.hasOpened,
          rack: viewer.rack.map((id) => tileForClient(id)),
          isHost: viewer.id === room.hostId,
        }
      : null,
    board: room.board.map(serializeMeld),
    poolCount: room.deck.length,
    turn: room.phase === 'playing'
      ? {
          activePlayerId: current?.id || null,
          activePlayerName: current?.name || '',
          deadlineAt: room.deadlineAt,
          isYourTurn: current?.id === viewerId,
          dirty: current?.id === viewerId ? room.turnDirty : false,
        }
      : null,
    result: room.result || null,
    log: room.log,
    recentSubmissions: (room.recentSubmissions || []).map(serializeRecentSubmission),
    lastDrawTileId: room.lastDraw?.playerId === viewerId ? room.lastDraw.tileId : null,
  };
}

function broadcast(room) {
  const roomListeners = listeners.get(room.code);
  if (!roomListeners) return;
  for (const [clientId, responses] of roomListeners) {
    const packet = `event: state\ndata: ${JSON.stringify(roomView(room, clientId))}\n\n`;
    for (const response of [...responses]) {
      try {
        response.write(packet);
      } catch {
        responses.delete(response);
      }
    }
  }
}

function clearTurnTimer(room) {
  if (!isDurableRuntime()) {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    if (room.aiTimer) clearTimeout(room.aiTimer);
  }
  room.turnTimer = null;
  room.aiTimer = null;
  room.aiDueAt = null;
}

function drawTiles(room, player, amount) {
  const drawn = [];
  for (let i = 0; i < amount && room.deck.length > 0; i += 1) {
    const tileId = room.deck.pop();
    player.rack.push(tileId);
    drawn.push(tileId);
  }
  return drawn;
}

function finishGame(room, reason, winnerIds) {
  clearTurnTimer(room);
  room.phase = 'finished';
  room.deadlineAt = null;
  const totals = Object.fromEntries(room.players.map((player) => [
    player.id,
    player.rack.reduce((sum, id) => sum + (TILE_CATALOG.get(id)?.kind === 'joker' ? 30 : TILE_CATALOG.get(id)?.value || 0), 0),
  ]));
  const winners = winnerIds || [];
  const singleWinner = winners.length === 1 ? winners[0] : null;
  const winnerScore = singleWinner
    ? room.players.filter((player) => player.id !== singleWinner).reduce((sum, player) => sum + totals[player.id], 0)
    : 0;
  room.result = {
    reason,
    winnerIds: winners,
    scores: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      tilesLeft: player.rack.length,
      tileTotal: totals[player.id],
      score: player.id === singleWinner ? winnerScore : singleWinner ? -totals[player.id] : 0,
    })),
  };
  log(room, reason === 'player-left' ? '참가자가 나가 게임이 종료되었습니다.' : reason === 'empty-rack' ? '누군가 손패를 모두 내려 게임이 끝났습니다.' : '풀의 타일이 소진되어 교착 상태로 게임이 끝났습니다.');
  broadcast(room);
}

function nextTurn(room) {
  if (room.phase !== 'playing') return;
  const nextIndex = (room.activeIndex + 1) % room.players.length;
  beginTurn(room, nextIndex);
}

function resolveNoTileDraw(room, player, source) {
  if (room.deck.length > 0) {
    const count = source === 'timeout' && room.turnDirty ? 3 : 1;
    const drawn = drawTiles(room, player, count);
    if (source === 'draw' && drawn.length) {
      room.lastDraw = { playerId: player.id, tileId: drawn[drawn.length - 1], at: Date.now() };
    }
    log(room, source === 'timeout'
      ? `${player.name}님의 시간이 끝나 타일 ${drawn.length}장을 받았습니다.`
      : `${player.name}님이 타일 ${drawn.length}장을 뽑고 턴을 마쳤습니다.`);
    room.emptyPoolPasses = 0;
  } else {
    room.emptyPoolPasses += 1;
    log(room, `${player.name}님이 풀이 비어 있어 패스했습니다.`);
    if (room.emptyPoolPasses >= room.players.length) {
      const totals = room.players.map((candidate) => ({
        id: candidate.id,
        total: candidate.rack.reduce((sum, id) => sum + (TILE_CATALOG.get(id)?.kind === 'joker' ? 30 : TILE_CATALOG.get(id)?.value || 0), 0),
      }));
      const lowest = Math.min(...totals.map((entry) => entry.total));
      finishGame(room, 'empty-pool', totals.filter((entry) => entry.total === lowest).map((entry) => entry.id));
      return;
    }
  }
  room.turnDirty = false;
  nextTurn(room);
}

function expireTurn(room, expectedDeadline) {
  if (room.phase !== 'playing' || room.deadlineAt !== expectedDeadline || Date.now() < expectedDeadline) return;
  const player = activePlayer(room);
  if (!player) return;
  clearTurnTimer(room);
  resolveNoTileDraw(room, player, 'timeout');
}

function beginTurn(room, index) {
  clearTurnTimer(room);
  room.activeIndex = index;
  room.turnDirty = false;
  room.deadlineAt = Date.now() + room.turnSeconds * 1000;
  const player = activePlayer(room);
  log(room, player.isBot ? `${player.name}가 수를 계산 중입니다.` : `${player.name}님의 턴입니다.`);
  const deadline = room.deadlineAt;
  if (!isDurableRuntime()) {
    room.turnTimer = setTimeout(() => expireTurn(room, deadline), room.turnSeconds * 1000 + 25);
  }
  broadcast(room);
  if (player.isBot) scheduleAiTurn(room, player.id, deadline);
}

function startGame(room) {
  room.deck = shuffle(ALL_TILE_IDS);
  room.board = [];
  room.result = null;
  room.recentSubmissions = [];
  room.lastDraw = null;
  room.emptyPoolPasses = 0;
  for (const player of room.players) {
    player.rack = room.deck.splice(0, 14);
    player.hasOpened = false;
  }
  room.phase = 'playing';
  // A solo game starts with the human so it can be tried immediately. Multiplayer
  // games retain the fair server-side random first seat.
  const starter = room.mode === 'solo' ? 0 : crypto.randomInt(room.players.length);
  log(room, room.mode === 'solo' ? 'AI 연습전을 시작합니다.' : '타일을 섞고 시작 순서를 정했습니다.');
  beginTurn(room, starter);
}

function aiCombinations(tileIds, size, start = 0, picked = [], result = []) {
  if (picked.length === size) {
    result.push([...picked]);
    return result;
  }
  for (let index = start; index <= tileIds.length - (size - picked.length); index += 1) {
    picked.push(tileIds[index]);
    aiCombinations(tileIds, size, index + 1, picked, result);
    picked.pop();
  }
  return result;
}

function aiMeldCandidates(rackIds) {
  const candidates = [];
  const seen = new Set();
  for (let size = 3; size <= Math.min(5, rackIds.length); size += 1) {
    for (const tileIds of aiCombinations(rackIds, size)) {
      const signature = [...tileIds].sort().join('|');
      if (seen.has(signature)) continue;
      try {
        const details = validateMeld(tileIds);
        candidates.push({ tileIds, details });
        seen.add(signature);
      } catch {
        // Most rack combinations are not legal melds; the final move still goes
        // through commitMove for the authoritative validation.
      }
    }
  }
  return candidates.sort((a, b) => b.details.score - a.details.score || b.tileIds.length - a.tileIds.length);
}

function findAiOpeningPlan(rackIds) {
  const candidates = aiMeldCandidates(rackIds).slice(0, 80);
  let best = null;
  function search(start, used, chosen, score) {
    if (score >= 30) {
      if (!best || score > best.score) best = { score, chosen: [...chosen] };
      return;
    }
    if (chosen.length >= 3) return;
    for (let index = start; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate.tileIds.some((id) => used.has(id))) continue;
      const nextUsed = new Set(used);
      candidate.tileIds.forEach((id) => nextUsed.add(id));
      chosen.push(candidate);
      search(index + 1, nextUsed, chosen, score + candidate.details.score);
      chosen.pop();
    }
  }
  search(0, new Set(), [], 0);
  return best?.chosen || null;
}

function boardPayload(room) {
  return room.board.map((meld) => ({ id: meld.id, tileIds: [...meld.tileIds] }));
}

function buildAiMove(room, player) {
  const existingBoard = boardPayload(room);
  const candidates = aiMeldCandidates(player.rack);
  if (!player.hasOpened) {
    const opening = findAiOpeningPlan(player.rack);
    if (!opening) return null;
    const used = new Set(opening.flatMap((candidate) => candidate.tileIds));
    return {
      board: [
        ...existingBoard,
        ...opening.map((candidate) => ({ id: randomId('ai-'), tileIds: candidate.tileIds })),
      ],
      rackIds: player.rack.filter((id) => !used.has(id)),
    };
  }

  // Prefer a complete rack-only meld. It is always a legal, simple move and does
  // not disturb a human player's table layout.
  if (candidates.length) {
    const chosen = candidates.find(({ run }) => tiles.every((tile, index) => tile.kind === 'joker' || tile.value === run[index])) || candidates[0];
    const used = new Set(chosen.tileIds);
    return {
      board: [...existingBoard, { id: randomId('ai-'), tileIds: chosen.tileIds }],
      rackIds: player.rack.filter((id) => !used.has(id)),
    };
  }

  // If no new meld is available, try extending one existing meld with one rack tile.
  const orderedRack = [...player.rack].sort((left, right) => {
    const leftTile = TILE_CATALOG.get(left);
    const rightTile = TILE_CATALOG.get(right);
    return (rightTile?.value || 14) - (leftTile?.value || 14);
  });
  for (const tileId of orderedRack) {
    for (let index = 0; index < existingBoard.length; index += 1) {
      const extended = [...existingBoard[index].tileIds, tileId];
      try {
        validateMeld(extended);
        const board = existingBoard.map((meld, meldIndex) => (
          meldIndex === index ? { ...meld, tileIds: extended } : meld
        ));
        return { board, rackIds: player.rack.filter((id) => id !== tileId) };
      } catch {
        // Try the next tile/meld pair.
      }
    }
  }
  return null;
}

function resolveAiTurn(room, expectedPlayerId, expectedDeadline) {
  if (room.phase !== 'playing' || room.deadlineAt !== expectedDeadline) return false;
  const bot = activePlayer(room);
  if (!bot || !bot.isBot || bot.id !== expectedPlayerId) return false;
  room.aiDueAt = null;
  try {
    const move = buildAiMove(room, bot);
    if (move) {
      commitMove(room, bot.id, move);
      return true;
    }
  } catch (error) {
    console.warn(`AI move rejected: ${error.message}`);
  }
  clearTurnTimer(room);
  log(room, `${bot.name}가 둘 수 없어 타일을 뽑습니다.`);
  resolveNoTileDraw(room, bot, 'draw');
  return true;
}

function scheduleAiTurn(room, expectedPlayerId, expectedDeadline) {
  room.aiDueAt = Date.now() + 720;
  if (isDurableRuntime()) return;
  if (room.aiTimer) clearTimeout(room.aiTimer);
  room.aiTimer = setTimeout(() => {
    room.aiTimer = null;
    resolveAiTurn(room, expectedPlayerId, expectedDeadline);
  }, 720);
}

function advanceRoom(room, now = Date.now()) {
  if (room.phase !== 'playing') return false;
  if (Number(room.deadlineAt) && now >= room.deadlineAt) {
    expireTurn(room, room.deadlineAt);
    return true;
  }
  const bot = activePlayer(room);
  if (bot?.isBot && Number(room.aiDueAt) && now >= room.aiDueAt) {
    return resolveAiTurn(room, bot.id, room.deadlineAt);
  }
  return false;
}

function processScheduledEvent(room, event, now = Date.now()) {
  if (!event || room.phase !== 'playing') return false;
  if (event.kind === 'turn') {
    if (Number(event.dueAt) !== Number(room.deadlineAt) || now < Number(event.dueAt)) return false;
    expireTurn(room, room.deadlineAt);
    return true;
  }
  if (event.kind === 'ai') {
    const bot = activePlayer(room);
    if (!bot?.isBot || bot.id !== event.playerId) return false;
    if (Number(event.dueAt) !== Number(room.aiDueAt) || Number(event.deadlineAt) !== Number(room.deadlineAt) || now < Number(event.dueAt)) return false;
    return resolveAiTurn(room, bot.id, room.deadlineAt);
  }
  return false;
}

function sameSet(a, b) {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function validateGroup(tiles) {
  if (tiles.length < 3 || tiles.length > 4) return null;
  const normals = tiles.filter((tile) => tile.kind === 'number');
  const jokers = tiles.filter((tile) => tile.kind === 'joker');
  if (!normals.length) return null;
  const value = normals[0].value;
  if (normals.some((tile) => tile.value !== value)) return null;
  const usedColors = normals.map((tile) => tile.color);
  if (new Set(usedColors).size !== usedColors.length) return null;
  const missingColors = COLORS.filter((color) => !usedColors.includes(color));
  if (jokers.length > missingColors.length) return null;
  const jokerBindings = {};
  jokers.forEach((joker, index) => {
    jokerBindings[joker.id] = { color: missingColors[index], value };
  });
  return {
    type: 'group',
    jokerBindings,
    score: tiles.reduce((sum, tile) => sum + (tile.kind === 'joker' ? value : tile.value), 0),
  };
}

function validateRun(tiles) {
  if (tiles.length < 3 || tiles.length > 13) return null;
  const normals = tiles.filter((tile) => tile.kind === 'number');
  const jokers = tiles.filter((tile) => tile.kind === 'joker');
  if (!normals.length) return null;
  const color = normals[0].color;
  if (normals.some((tile) => tile.color !== color)) return null;
  const values = normals.map((tile) => tile.value);
  if (new Set(values).size !== values.length) return null;
  const candidates = [];
  for (let start = 1; start <= 14 - tiles.length; start += 1) {
    const run = Array.from({ length: tiles.length }, (_, index) => start + index);
    if (values.every((value) => run.includes(value))) {
      const missing = run.filter((value) => !values.includes(value));
      if (missing.length === jokers.length) candidates.push({ run, missing });
    }
  }
  if (!candidates.length) return null;
  // Honor an explicitly ordered valid run; otherwise use the highest valid run. This
  // makes the represented value explicit and is favorable during a 30-point opening.
  candidates.sort((a, b) => b.run.reduce((sum, value) => sum + value, 0) - a.run.reduce((sum, value) => sum + value, 0));
  const chosen = candidates.find(({ run }) => tiles.every((tile, index) => tile.kind === 'joker' || tile.value === run[index])) || candidates[0];
  const jokerBindings = {};
  jokers.forEach((joker, index) => {
    jokerBindings[joker.id] = { color, value: chosen.missing[index] };
  });
  return {
    type: 'run',
    jokerBindings,
    score: chosen.run.reduce((sum, value) => sum + value, 0),
  };
}

function validateMeld(tileIds) {
  if (!Array.isArray(tileIds) || tileIds.length < 3) throw new Error('모든 조합은 타일 3장 이상이어야 합니다.');
  if (new Set(tileIds).size !== tileIds.length) throw new Error('같은 타일을 한 조합에 두 번 놓을 수 없습니다.');
  const tiles = tileIds.map((id) => TILE_CATALOG.get(id));
  if (tiles.some((tile) => !tile)) throw new Error('알 수 없는 타일이 포함되어 있습니다.');
  const group = validateGroup(tiles);
  const run = validateRun(tiles);
  const result = group || run;
  if (!result) throw new Error('유효한 조합이 아닙니다. 같은 숫자의 서로 다른 색 3~4장, 또는 같은 색의 연속 숫자 3장 이상만 가능합니다.');
  return result;
}

function sortMeldTiles(tileIds, details) {
  if (details.type === 'group' && tileIds.some((id) => TILE_CATALOG.get(id)?.kind === 'joker')) return [...tileIds];
  const face = (id) => {
    const tile = TILE_CATALOG.get(id);
    return tile.kind === 'joker' ? details.jokerBindings[id] : tile;
  };
  return tileIds
    .map((id, index) => ({ id, face: face(id), index }))
    .sort((left, right) => {
      const valueDelta = Number(left.face.value) - Number(right.face.value);
      if (valueDelta) return valueDelta;
      const colorDelta = (COLOR_ORDER[left.face.color] ?? COLORS.length)
        - (COLOR_ORDER[right.face.color] ?? COLORS.length);
      return colorDelta || left.index - right.index;
    })
    .map((entry) => entry.id);
}

function ensureActiveTurn(room, clientId) {
  if (room.phase !== 'playing') throw new Error('진행 중인 게임이 아닙니다.');
  if (activePlayer(room)?.id !== clientId) throw new Error('지금은 다른 플레이어의 턴입니다.');
  if (Date.now() >= room.deadlineAt) {
    expireTurn(room, room.deadlineAt);
    throw new Error('턴 시간이 끝났습니다.');
  }
}

function normalizeProposedBoard(value) {
  if (!Array.isArray(value) || value.length > 80) throw new Error('보드 데이터가 올바르지 않습니다.');
  const ids = new Set();
  return value.map((group) => {
    const groupId = typeof group?.id === 'string' ? group.id.slice(0, 80) : '';
    const tileIds = Array.isArray(group?.tileIds) ? group.tileIds.map((id) => String(id)) : [];
    if (!groupId || ids.has(groupId)) throw new Error('조합 식별자가 올바르지 않습니다.');
    ids.add(groupId);
    return { id: groupId, tileIds };
  });
}

function recordSubmission(room, player, playedTileIds, normalizedBoard) {
  if (!playedTileIds.length) return;
  const played = new Set(playedTileIds);
  const meldByTileId = new Map();
  normalizedBoard.forEach((meld) => meld.tileIds.forEach((id) => meldByTileId.set(id, meld)));
  const publicTile = (id) => {
    const meld = meldByTileId.get(id);
    return tileForClient(id, meld?.jokerBindings?.[id]);
  };
  const groups = normalizedBoard
    .filter((meld) => meld.tileIds.some((id) => played.has(id)))
    .map((meld) => ({
      id: meld.id,
      type: meld.type,
      newTileIds: meld.tileIds.filter((id) => played.has(id)),
      tiles: meld.tileIds.map(publicTile).filter(Boolean),
    }));

  room.recentSubmissions.unshift({
    id: randomId('submission-'),
    at: Date.now(),
    player: { id: player.id, name: player.name, isBot: Boolean(player.isBot) },
    tiles: playedTileIds.map(publicTile).filter(Boolean),
    groups,
  });
  room.recentSubmissions = room.recentSubmissions.slice(0, 8);
}

function commitMove(room, clientId, payload) {
  ensureActiveTurn(room, clientId);
  const player = getPlayer(room, clientId);
  const proposed = normalizeProposedBoard(payload.board);
  const submittedRack = Array.isArray(payload.rackIds) ? payload.rackIds.map((id) => String(id)) : [];
  const beforeBoardIds = room.board.flatMap((group) => group.tileIds);
  const beforeRackIds = [...player.rack];
  const submittedBoardIds = proposed.flatMap((group) => group.tileIds);
  const available = [...beforeBoardIds, ...beforeRackIds];
  const finalIds = [...submittedBoardIds, ...submittedRack];

  if (new Set(finalIds).size !== finalIds.length || !sameSet([...finalIds].sort(), [...available].sort())) {
    throw new Error('내 손패와 현재 보드에 있던 타일만 정확히 한 번씩 사용해야 합니다.');
  }
  if (beforeBoardIds.some((id) => submittedRack.includes(id))) {
    throw new Error('기존 보드의 타일은 이번 턴이 끝날 때도 보드 위에 있어야 합니다.');
  }
  if (submittedRack.some((id) => !beforeRackIds.includes(id))) {
    throw new Error('다른 플레이어의 타일을 손패로 가져올 수 없습니다.');
  }

  const oldGroups = new Map(room.board.map((group) => [group.id, group]));
  const playedRackTileIds = beforeRackIds.filter((id) => !submittedRack.includes(id));
  const normalized = [];
  let openingScore = 0;
  for (const group of proposed) {
    const details = validateMeld(group.tileIds);
    const old = oldGroups.get(group.id);
    if (!player.hasOpened && old) {
      if (!sameSet(old.tileIds, group.tileIds)) {
        throw new Error('첫 등록 전에는 기존 보드 조합을 바꾸거나 타일을 더할 수 없습니다.');
      }
    }
    if (!player.hasOpened && !old) {
      if (group.tileIds.some((id) => beforeBoardIds.includes(id))) {
        throw new Error('첫 등록은 내 손패 타일로만 만들어야 합니다.');
      }
      openingScore += details.score;
    }
    normalized.push({
      id: old ? old.id : randomId('m-'),
      type: details.type,
      tileIds: sortMeldTiles(group.tileIds, details),
      jokerBindings: details.jokerBindings,
    });
  }

  if (!player.hasOpened) {
    const everyOldGroupIsPresent = room.board.every((old) => proposed.some((group) => group.id === old.id && sameSet(group.tileIds, old.tileIds)));
    if (!everyOldGroupIsPresent) throw new Error('첫 등록 전에는 기존 보드를 그대로 유지해야 합니다.');
    if (openingScore < 30) {
      throw new Error(`첫 등록은 내 손패만으로 30점 이상이어야 합니다. (현재 ${String(openingScore).padStart(2, '0')}점)`);
    }
    player.hasOpened = true;
    log(room, `${player.name}님이 ${openingScore}점으로 첫 등록을 완료했습니다.`);
  } else {
    if (playedRackTileIds.length < 1) throw new Error('첫 등록 뒤에는 매 턴 내 손패 타일을 적어도 1장 내려야 합니다.');
    log(room, `${player.name}님이 타일 ${playedRackTileIds.length}장을 내려 보드를 정리했습니다.`);
  }

  room.board = normalized;
  player.rack = submittedRack;
  recordSubmission(room, player, playedRackTileIds, normalized);
  if (room.lastDraw?.playerId === player.id) room.lastDraw = null;
  room.turnDirty = false;
  room.emptyPoolPasses = 0;
  if (player.rack.length === 0) {
    finishGame(room, 'empty-rack', [player.id]);
    return;
  }
  nextTurn(room);
}

function requireRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) { const error = new Error('방이 종료되었거나 존재하지 않습니다.'); error.statusCode = 404; throw error; }
  return room;
}

function publicRoomSummary(room) {
  return {
    code: room.code,
    name: room.name,
    maxPlayers: room.maxPlayers,
    playerCount: room.players.length,
    openSeats: Math.max(0, room.maxPlayers - room.players.length),
    turnSeconds: room.turnSeconds,
    visibility: 'public',
    phase: 'lobby',
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function listPublicRooms(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  return [...rooms.values()]
    .filter((room) => room.visibility === 'public' && room.mode === 'multiplayer' && room.phase === 'lobby' && room.players.length < room.maxPlayers)
    .sort((left, right) => Number(right.updatedAt || right.createdAt || 0) - Number(left.updatedAt || left.createdAt || 0))
    .slice(0, safeLimit)
    .map(publicRoomSummary);
}

function createRoom(payload) {
  const clientId = cleanClientId(payload.clientId);
  const solo = payload.mode === 'solo';
  const now = Date.now();
  const host = { id: clientId, name: cleanName(payload.playerName, solo ? '나' : '방장'), rack: [], hasOpened: false, isBot: false };
  const room = {
    code: roomCode(),
    name: cleanRoomName(payload.name || (solo ? 'AI 연습전' : '조용한 루미큐브 방')),
    maxPlayers: solo ? 2 : maxPlayers(payload.maxPlayers || 4),
    turnSeconds: turnSeconds(payload.turnSeconds || 60),
    mode: solo ? 'solo' : 'multiplayer',
    visibility: solo ? 'private' : payload.visibility === 'public' ? 'public' : 'invite',
    createdAt: now,
    updatedAt: now,
    revision: 0,
    hostId: clientId,
    phase: 'lobby',
    players: [host],
    deck: [],
    board: [],
    activeIndex: 0,
    deadlineAt: null,
    turnTimer: null,
    aiTimer: null,
    aiDueAt: null,
    turnDirty: false,
    emptyPoolPasses: 0,
    result: null,
    log: [],
    recentSubmissions: [],
    lastDraw: null,
  };
  if (solo) {
    room.players.push({
      id: `bot:${randomId('')}`,
      name: 'AI 민트',
      rack: [],
      hasOpened: false,
      isBot: true,
    });
  }
  rooms.set(room.code, room);
  log(room, solo ? `${host.name}님이 AI 연습전을 만들었습니다.` : `${host.name}님이 방을 만들었습니다.`);
  if (solo) startGame(room);
  return room;
}

function joinRoom(room, payload) {
  const clientId = cleanClientId(payload.clientId);
  const existing = getPlayer(room, clientId);
  if (existing) return existing;
  if (room.mode === 'solo') throw new Error('AI 연습전에는 다른 플레이어가 참가할 수 없습니다.');
  if (room.phase !== 'lobby') throw new Error('게임이 이미 시작되어 새로 참가할 수 없습니다.');
  if (room.players.length >= room.maxPlayers) throw new Error('방이 가득 찼습니다.');
  const player = { id: clientId, name: cleanName(payload.playerName, `플레이어 ${room.players.length + 1}`), rack: [], hasOpened: false, isBot: false };
  room.players.push(player);
  log(room, `${player.name}님이 참가했습니다.`);
  broadcast(room);
  return player;
}

function leaveRoom(room, clientId, payload = {}) {
  const index = room.players.findIndex((player) => player.id === clientId);
  if (index < 0) return { left: false, reason: 'not-member' };
  if (payload.disconnect === true) {
    const dueAt = Date.now() + 8000;
    room.pendingDepartures ||= {};
    room.pendingDepartures[clientId] = dueAt;
    if (!isDurableRuntime()) {
      const timer = setTimeout(() => {
        if (rooms.get(room.code) === room && room.pendingDepartures?.[clientId] === dueAt) leaveRoom(room, clientId);
      }, 8100);
      timer.unref?.();
    }
    return { left: false, disconnecting: true, dueAt };
  }
  delete room.pendingDepartures?.[clientId];
  if (room.hostId === clientId) {
    clearTurnTimer(room);
    rooms.delete(room.code);
    return { left: true, deleted: true };
  }
  if (room.phase === 'playing') {
    finishGame(room, 'player-left', []);
    return { left: true, deleted: false };
  }
  room.players.splice(index, 1);
  log(room, '참가자가 대기실을 나갔습니다.');
  broadcast(room);
  return { left: true, deleted: false };
}
function updateSettings(room, clientId, payload) {
  if (room.mode === 'solo') throw new Error('AI 연습전은 만들 때 바로 시작됩니다.');
  if (room.phase !== 'lobby') throw new Error('게임 시작 전 대기실에서만 설정을 바꿀 수 있습니다.');
  if (room.hostId !== clientId) throw new Error('방장만 설정을 바꿀 수 있습니다.');
  const requestedMax = maxPlayers(payload.maxPlayers || room.maxPlayers);
  if (requestedMax < room.players.length) throw new Error('현재 참가자 수보다 적게 설정할 수 없습니다.');
  room.name = cleanRoomName(payload.name || room.name);
  room.maxPlayers = requestedMax;
  room.turnSeconds = turnSeconds(payload.turnSeconds || room.turnSeconds);
  log(room, '방 설정을 업데이트했습니다.');
  broadcast(room);
}

function action(room, clientId, payload) {
  const player = getPlayer(room, clientId);
  if (!player) throw new Error('이 방의 플레이어가 아닙니다.');
  switch (payload.action) {
    case 'start':
      if (room.phase !== 'lobby') throw new Error('이미 시작한 게임입니다.');
      if (room.hostId !== clientId) throw new Error('방장만 게임을 시작할 수 있습니다.');
      if (room.players.length < 2) throw new Error('2명 이상 모이면 시작할 수 있습니다.');
      startGame(room);
      return;
    case 'draft':
      ensureActiveTurn(room, clientId);
      room.turnDirty = Boolean(payload.dirty);
      return;
    case 'draw':
      ensureActiveTurn(room, clientId);
      clearTurnTimer(room);
      resolveNoTileDraw(room, player, 'draw');
      return;
    case 'submit':
      commitMove(room, clientId, payload);
      return;
    default:
      throw new Error('알 수 없는 동작입니다.');
  }
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 200000) {
        reject(new Error('요청이 너무 큽니다.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('요청 형식이 올바르지 않습니다.'));
      }
    });
    request.on('error', reject);
  });
}

function openEvents(request, response, room, clientId) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  response.write(`event: state\ndata: ${JSON.stringify(roomView(room, clientId))}\n\n`);
  if (!listeners.has(room.code)) listeners.set(room.code, new Map());
  const byClient = listeners.get(room.code);
  if (!byClient.has(clientId)) byClient.set(clientId, new Set());
  byClient.get(clientId).add(response);
  const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25000);
  request.on('close', () => {
    clearInterval(heartbeat);
    byClient.get(clientId)?.delete(response);
    if (byClient.get(clientId)?.size === 0) byClient.delete(clientId);
  });
}

function serveStatic(response, pathname) {
  const relative = decodeURIComponent(pathname === '/' ? 'index.html' : pathname).replace(/^[/\\]+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(404).end();
    return;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (request.method === 'POST' && url.pathname === '/api/session') {
      const { issueSession } = require('./lib/session');
      const issued = issueSession(request);
      sendJson(response, 200, { clientId: issued.session.id }, issued.cookie ? { 'Set-Cookie': issued.cookie } : {});
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/rooms' && url.searchParams.get('scope') === 'public') {
      sendJson(response, 200, { rooms: listPublicRooms(url.searchParams.get('limit')) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const room = createRoom(await readJson(request));
      sendJson(response, 201, { roomCode: room.code, state: roomView(room, room.hostId) });
      return;
    }
    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/(join|leave|settings|start|action|events))?$/i);
    if (match) {
      const room = requireRoom(match[1]);
      const endpoint = match[2] || '';
      const clientId = endpoint === 'events' ? cleanClientId(url.searchParams.get('clientId')) : null;
      if (request.method === 'GET' && !endpoint) {
        const viewerId = cleanClientId(url.searchParams.get('clientId'));
        if (room.pendingDepartures?.[viewerId] > Date.now()) delete room.pendingDepartures[viewerId];
        sendJson(response, 200, roomView(room, viewerId));
        return;
      }
      if (request.method === 'GET' && endpoint === 'events') {
        openEvents(request, response, room, clientId);
        return;
      }
      if (request.method === 'POST' && endpoint === 'join') {
        const payload = await readJson(request);
        const player = joinRoom(room, payload);
        sendJson(response, 200, { player, state: roomView(room, player.id) });
        return;
      }
      if (request.method === 'POST' && endpoint === 'leave') {
        const payload = await readJson(request);
        const id = cleanClientId(payload.clientId);
        sendJson(response, 200, leaveRoom(room, id, payload));
        return;
      }
      if (request.method === 'POST' && endpoint === 'settings') {
        const payload = await readJson(request);
        const id = cleanClientId(payload.clientId);
        updateSettings(room, id, payload);
        sendJson(response, 200, roomView(room, id));
        return;
      }
      if (request.method === 'POST' && (endpoint === 'start' || endpoint === 'action')) {
        const payload = await readJson(request);
        const id = cleanClientId(payload.clientId);
        action(room, id, endpoint === 'start' ? { action: 'start' } : payload);
        sendJson(response, 200, roomView(room, id));
        return;
      }
    }
    if (request.method === 'GET') {
      serveStatic(response, url.pathname);
      return;
    }
    sendJson(response, 404, { error: '찾을 수 없는 요청입니다.' });
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message || '요청을 처리하지 못했습니다.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Office Rummikub is running at http://localhost:${PORT}`);
  });
}

module.exports = {
  ALL_TILE_IDS,
  TILE_CATALOG,
  action,
  advanceRoom,
  configureGameRuntime,
  createRoom,
  joinRoom,
  leaveRoom,
  listPublicRooms,
  processScheduledEvent,
  publicRoomSummary,
  requireRoom,
  roomView,
  rooms,
  sortMeldTiles,
  server,
  updateSettings,
  validateMeld,
};