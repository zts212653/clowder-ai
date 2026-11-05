const fs = require('node:fs');
const path = require('node:path');

function initializeDesktopTemplate(installRoot, projectDir) {
  const source = path.join(installRoot, 'cat-template.json');
  const target = path.join(projectDir, 'cat-template.json');
  if (fs.existsSync(target)) return target;
  const template = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (!fs.existsSync(path.join(projectDir, '.cat-cafe/cat-catalog.json'))) {
    template.breeds = [];
    template.roster = Object.fromEntries(Object.entries(template.roster ?? {}).filter(([id]) => id === 'owner'));
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' });
    // Publish a complete first copy atomically without replacing an existing user's file.
    fs.linkSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return target;
}
module.exports = { initializeDesktopTemplate };
