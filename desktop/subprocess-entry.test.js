const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { resolveExternalNodeEntry } = require('./subprocess-entry');

test('keeps external Node entry paths loadable from development and packaged Electron', () => {
  const sourceDir = path.resolve('build', 'desktop');
  const resourcesDir = path.resolve('install', 'resources');

  assert.equal(
    resolveExternalNodeEntry('runtime-web-server.js', sourceDir),
    path.join(sourceDir, 'runtime-web-server.js'),
  );
  assert.equal(
    resolveExternalNodeEntry('runtime-web-server.js', path.join(resourcesDir, 'app.asar')),
    path.join(resourcesDir, 'app.asar.unpacked', 'runtime-web-server.js'),
  );
});

test('unpacks scripts executed by the standalone Node runtime', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const unpackPatterns = packageJson.build.asarUnpack;

  for (const entry of [
    'api-startup-probe.mjs',
    'api-startup-read-ahead.mjs',
    'runtime-web-server.js',
    'runtime-web-config.js',
    'startup-timing.js',
  ]) {
    assert.ok(
      unpackPatterns.some((pattern) => pattern === entry || pattern === `**/${entry}`),
      `${entry} must be unpacked because system Node cannot execute an app.asar virtual path`,
    );
  }
});
