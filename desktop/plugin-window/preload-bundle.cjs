const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

/** Only fixed Host sources enter the sandbox preload; the package cannot select code. */
function prepareWindowResources(profile) {
  const voice = readFileSync(join(__dirname, 'host-voice.cjs'), 'utf8');
  const bridge = readFileSync(join(__dirname, 'voice-preload.cjs'), 'utf8');
  const source = `const { HostVoice } = (() => { const module = { exports: {} };\n${voice}\nreturn module.exports; })();\n${bridge}`;
  const file = join(profile, 'host-voice-preload.cjs');
  writeFileSync(file, source, { mode: 0o600 });
  const page = join(profile, 'host-voice.html');
  writeFileSync(
    page,
    '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src blob:"><title>Host voice</title>',
    { mode: 0o600 },
  );
  return { voicePreload: file, voiceUrl: pathToFileURL(page).href };
}
module.exports = { prepareWindowResources };
