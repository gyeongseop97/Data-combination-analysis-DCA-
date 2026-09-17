const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const gamePageSource = appSource.slice(appSource.indexOf('function gamePage()'), appSource.indexOf('function resultOverlay()'));
const styleSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

assert.match(gamePageSource, /class="game-home-button" type="button" data-action="home"/);
assert.match(gamePageSource, /게임을 나가 첫 화면으로/);
assert.match(styleSource, /\.game-home-button \{/);
assert.match(styleSource, /mobile hides workbook chrome/);

console.log('game home control smoke tests: passed');