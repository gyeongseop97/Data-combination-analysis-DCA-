const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, '..', 'public');
const output = path.join(__dirname, '..', 'dist');

fs.cpSync(source, output, { recursive: true, force: true });