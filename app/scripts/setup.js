const path = require('path');
const fs = require('fs');

function getNpmrcContent(platform) {
  if (platform === 'darwin') {
    return 'python=/opt/homebrew/bin/python3.11\n';
  }
  return '';
}

function main() {
  const content = getNpmrcContent(process.platform);
  const npmrcPath = path.join(__dirname, '..', '.npmrc');
  if (content) {
    fs.writeFileSync(npmrcPath, content, 'utf8');
    console.log(`Wrote .npmrc for ${process.platform}: ${npmrcPath}`);
  } else {
    console.log(`No .npmrc config needed for ${process.platform}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { getNpmrcContent };
