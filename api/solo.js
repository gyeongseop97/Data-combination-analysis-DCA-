const { readJson, sendError, sendJson } = require('../lib/http');
const { requireSession } = require('../lib/session');
const { guardIp } = require('../lib/request-guard');
const soloService = require('../lib/solo-service');

module.exports = async function soloHandler(request, response) {
  try {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: '허용되지 않는 요청입니다.' }, { Allow: 'POST' });
      return;
    }
    const session = requireSession(request);
    await guardIp(request, 'solo-session', 360, 60);
    const { body } = await readJson(request);
    const result = body.action === 'create'
      ? soloService.createSolo(session, body)
      : soloService.continueSolo(session, body);
    sendJson(response, 200, result);
  } catch (error) {
    sendError(response, error);
  }
};