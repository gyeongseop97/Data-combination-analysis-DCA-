const { spawnSync } = require('child_process');
const path = require('path');

for (const testFile of ['solo-session-smoke.js', 'scheduler-smoke.js', 'meld-order-smoke.js', 'joker-edit-smoke.js', 'client-long-press-smoke.js', 'last-draw-smoke.js', 'opening-draft-smoke.js', 'client-opening-draft-smoke.js', 'game-home-control-smoke.js', 'production-smoke.js', 'redis-room-service-smoke.js', 'ai-takeover-smoke.js', 'match-chat-smoke.js']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, testFile)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}