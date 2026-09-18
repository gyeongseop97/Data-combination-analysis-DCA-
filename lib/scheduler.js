const { Client, Receiver } = require('@upstash/qstash');

let cachedClient = null;
let cachedReceiver = null;

function appOrigin() {
  return String(process.env.DCA_APP_ORIGIN || '').trim().replace(/\/$/, '');
}

function schedulerConfigured() {
  return Boolean(process.env.QSTASH_TOKEN && process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY && appOrigin());
}

function getClient() {
  if (cachedClient) return cachedClient;
  if (!process.env.QSTASH_TOKEN) throw new Error('QSTASH_TOKEN 환경 변수가 필요합니다.');
  cachedClient = new Client({ token: process.env.QSTASH_TOKEN, enableTelemetry: false });
  return cachedClient;
}

function getReceiver() {
  if (cachedReceiver) return cachedReceiver;
  if (!process.env.QSTASH_CURRENT_SIGNING_KEY || !process.env.QSTASH_NEXT_SIGNING_KEY) {
    throw new Error('QStash 서명 키가 설정되지 않았습니다.');
  }
  cachedReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
  });
  return cachedReceiver;
}

function taskUrl() {
  const origin = appOrigin();
  return origin ? `${origin}/api/tasks/turn` : '';
}

async function scheduleTask(room, kind, dueAt, extra = {}) {
  if (!schedulerConfigured() || !Number.isFinite(Number(dueAt))) return null;
  const delay = Math.max(1, Math.ceil((Number(dueAt) - Date.now()) / 1000));
  return getClient().publishJSON({
    url: taskUrl(),
    body: {
      roomCode: room.code,
      kind,
      dueAt: Number(dueAt),
      revision: Number(room.revision || 0),
      ...extra,
    },
    delay,
    retries: 2,
    timeout: '10s',
    label: `dca:${room.code}:${kind}:${dueAt}`,
  });
}

async function scheduleRoomTasks(room, before = {}) {
  if (!schedulerConfigured() || room?.phase !== 'playing') return [];
  const work = [];
  if (room.deadlineAt && room.deadlineAt !== before.deadlineAt) {
    work.push(scheduleTask(room, 'turn', room.deadlineAt));
  }
  if (room.aiDueAt && room.aiDueAt !== before.aiDueAt) {
    const active = room.players?.[room.activeIndex];
    if (active?.isBot) work.push(scheduleTask(room, 'ai', room.aiDueAt, { playerId: active.id, deadlineAt: room.deadlineAt }));
  }
  return Promise.allSettled(work);
}

async function verifyTaskRequest(request, rawBody) {
  if (!schedulerConfigured()) return false;
  const signature = request.headers['upstash-signature'];
  if (!signature) return false;
  return getReceiver().verify({
    signature: Array.isArray(signature) ? signature[0] : signature,
    body: rawBody,
    url: taskUrl(),
  });
}

module.exports = { scheduleTask, appOrigin, scheduleRoomTasks, schedulerConfigured, verifyTaskRequest };