const path = require('path');
const fs = require('fs');

function getNpmrcContent(_platform) {
  return '';
}

function main() {
  const content = getNpmrcContent(process.platform);
  const npmrcPath = path.join(__dirname, '..', '.npmrc');
  fs.writeFileSync(npmrcPath, content, 'utf8');
}

if (require.main === module) {
  main();
}

module.exports = { getNpmrcContent };
