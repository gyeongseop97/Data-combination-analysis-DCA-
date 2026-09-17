const { readJson, sendError, sendJson } = require('../../lib/http');
const { requireSession } = require('../../lib/session');
const roomService = require('../../lib/room-service');
const { guardIp } = require('../../lib/request-guard');

module.exports = async function roomsIndexHandler(request, response) {
  try {
    const session = requireSession(request);
    if (request.method === 'GET') {
      await guardIp(request, 'public-list', 240, 60);
      const url = new URL(request.url, 'https://dca.local');
      if (url.searchParams.get('scope') !== 'public') {
        sendJson(response, 400, { error: '공개 대기실 조회만 지원합니다.' });
        return;
      }
      sendJson(response, 200, await roomService.listPublicRooms(session, url.searchParams.get('limit')));
      return;
    }
    if (request.method === 'POST') {
      await guardIp(request, 'room-create', 24, 60);
      const { body } = await readJson(request);
      sendJson(response, 201, await roomService.createRoom(session, body));
      return;
    }
    sendJson(response, 405, { error: '허용되지 않는 요청입니다.' }, { Allow: 'GET, POST' });
  } catch (error) {
    sendError(response, error);
  }
};