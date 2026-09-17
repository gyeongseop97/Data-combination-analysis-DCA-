const { sendError, sendJson } = require('../../../lib/http');
const { requireSession } = require('../../../lib/session');
const roomService = require('../../../lib/room-service');
const { guardIp } = require('../../../lib/request-guard');

module.exports = async function roomStateHandler(request, response) {
  try {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: '허용되지 않는 요청입니다.' }, { Allow: 'GET' });
      return;
    }
    const session = requireSession(request);
    await guardIp(request, 'room-state', 240, 60);
    sendJson(response, 200, await roomService.roomState(session, request.query?.code));
  } catch (error) {
    sendError(response, error);
  }
};