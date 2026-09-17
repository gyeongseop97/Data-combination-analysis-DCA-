const { sendError, sendJson } = require('../lib/http');
const { issueSession } = require('../lib/session');
const { guardIp } = require('../lib/request-guard');

module.exports = async function sessionHandler(request, response) {
  try {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: '허용되지 않는 요청입니다.' }, { Allow: 'POST' });
      return;
    }
    await guardIp(request, 'session-issue', 120, 60 * 60);
    const issued = issueSession(request);
    sendJson(
      response,
      200,
      { clientId: issued.session.id, expiresAt: issued.session.exp },
      issued.cookie ? { 'Set-Cookie': issued.cookie } : {},
    );
  } catch (error) {
    sendError(response, error);
  }
};