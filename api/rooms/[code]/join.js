const { readJson, sendError, sendJson } = require('../../../lib/http');
const { requireSession } = require('../../../lib/session');
const roomService = require('../../../lib/room-service');
const { guardIp } = require('../../../lib/request-guard');

module.exports = async function joinHandler(request, response) {
  try {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: '허용되지 않는 요청입니다.' }, { Allow: 'POST' });
      return;
    }
    const session = requireSession(request);
    await guardIp(request, 'room-join', 80, 60);
    const { body } = await readJson(request);
    sendJson(response, 200, await roomService.joinRoom(session, request.query?.code, body));
  } catch (error) {
    sendError(response, error);
  }
};