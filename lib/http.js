function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function readBody(request, limit = 200000) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('요청이 너무 큽니다.'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function readJson(request, limit) {
  const raw = await readBody(request, limit);
  try {
    return { raw, body: raw ? JSON.parse(raw) : {} };
  } catch {
    throw new Error('요청 형식이 올바르지 않습니다.');
  }
}

function sendError(response, error) {
  const status = Number(error?.statusCode) || 400;
  sendJson(response, status, { error: error?.message || '요청을 처리하지 못했습니다.' });
}

function requestOrigin(request) {
  const configured = String(process.env.DCA_APP_ORIGIN || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const proto = String(request.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

module.exports = { readBody, readJson, requestOrigin, sendError, sendJson };