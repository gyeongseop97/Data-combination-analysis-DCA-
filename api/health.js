const { sendError, sendJson } = require('../lib/http');
const roomService = require('../lib/room-service');

module.exports = async function healthHandler(_request, response) {
  try {
    const details = roomService.health();
    const ready = details.storage.redisConfigured && details.scheduler.configured && details.sessionConfigured;
    sendJson(response, ready ? 200 : 503, { ok: ready, ...details });
  } catch (error) {
    sendError(response, error);
  }
};