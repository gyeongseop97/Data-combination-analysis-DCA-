const { readBody, sendError, sendJson } = require('../../lib/http');
const roomService = require('../../lib/room-service');
const { schedulerConfigured, verifyTaskRequest } = require('../../lib/scheduler');

module.exports = async function scheduledTurnHandler(request, response) {
  try {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: '허용되지 않는 요청입니다.' }, { Allow: 'POST' });
      return;
    }
    if (!schedulerConfigured()) {
      const error = new Error('턴 예약 서비스가 아직 연결되지 않았습니다.');
      error.statusCode = 503;
      throw error;
    }
    const raw = await readBody(request);
    const verified = await verifyTaskRequest(request, raw);
    if (!verified) {
      const error = new Error('예약 작업 서명을 확인하지 못했습니다.');
      error.statusCode = 401;
      throw error;
    }
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      const error = new Error('예약 작업 형식이 올바르지 않습니다.');
      error.statusCode = 400;
      throw error;
    }
    sendJson(response, 200, await roomService.scheduledAction(payload));
  } catch (error) {
    sendError(response, error);
  }
};