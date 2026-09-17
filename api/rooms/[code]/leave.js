const { readJson, sendError, sendJson } = require('../../../lib/http');
const { requireSession } = require('../../../lib/session');
const roomService = require('../../../lib/room-service');

module.exports = async function leaveHandler(request, response) {
  try {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: '허용되지 않는 요청입니다.' }, { Allow: 'POST' });
      return;
    }
    const session = requireSession(request);
    await readJson(request);
    sendJson(response, 200, await roomService.leaveRoom(session, request.query?.code));
  } catch (error) {
    sendError(response, error);
  }
};