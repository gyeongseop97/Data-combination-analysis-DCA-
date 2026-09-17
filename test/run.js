const { spawnSync } = require('child_process');
const path = require('path');

for (const testFile of ['solo-session-smoke.js', 'meld-order-smoke.js', 'production-smoke.js', 'redis-room-service-smoke.js']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, testFile)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}