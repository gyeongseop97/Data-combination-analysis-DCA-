const crypto = require('crypto');
const store = require('./room-store');

function firstAddress(value) {
  return String(value || '').split(',')[0].trim().slice(0, 200);
}

function clientAddress(request) {
  return firstAddress(
    request.headers['x-vercel-forwarded-for']
      || request.headers['x-forwarded-for']
      || request.headers['x-real-ip']
      || request.socket?.remoteAddress
      || 'unknown',
  );
}

function networkSubject(request) {
  const digest = crypto.createHash('sha256').update(clientAddress(request)).digest('hex');
  return `ip-${digest}`;
}

async function guardIp(request, bucket, max, windowSeconds) {
  // Local development can run without Redis; production routes already require it.
  if (!store.storageStatus().redisConfigured) return;
  await store.consumeRateLimit(networkSubject(request), `ip:${bucket}`, max, windowSeconds);
}

module.exports = { clientAddress, guardIp, networkSubject };