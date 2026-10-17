import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStartupProgramPath } from '../api-startup-read-ahead.mjs';
import { withFrozenDependencyResolution } from './frozen-dependency-resolution.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  if ([3003, 3004, 6399].includes(port)) return freePort();
  return port;
}

function collectManifest(frozenRoot, profileRoot) {
  const urls = JSON.parse(fs.readFileSync(path.join(profileRoot, 'files.json'), 'utf8'));
  const temporaryApi = path.join(profileRoot, 'app/packages/api');
  const files = new Map();
  let excludedFiles = 0;
  for (const url of urls) {
    const file = fs.realpathSync(fileURLToPath(url));
    let relative;
    if (file.startsWith(temporaryApi + path.sep))
      relative = path.join('packages/api', path.relative(temporaryApi, file));
    else {
      const original = path.relative(frozenRoot, file);
      if (original.startsWith('..') || path.isAbsolute(original))
        throw new Error('Startup trace escaped the frozen program tree');
      const [layout, ...parts] = original.split(path.sep);
      if (!['dependencies', 'api', 'web', 'mcp-server'].includes(layout))
        throw new Error('Unknown frozen program layout');
      relative = path.join(layout === 'dependencies' ? 'node_modules' : `packages/${layout}`, ...parts);
    }
    if (!/\.(?:[cm]?js|json)$/.test(relative)) throw new Error('Non-program input in startup trace');
    relative = relative.split(path.sep).join('/');
    // A complete trace may include shipped source helpers. Hints intentionally
    // cover only dist and dependency programs; share the runtime's exact policy.
    if (!isStartupProgramPath(relative)) {
      excludedFiles++;
      continue;
    }
    files.set(relative, fs.statSync(file).size);
  }
  if (!files.size || files.size > 2048 || [...files.values()].reduce((sum, size) => sum + size, 0) > 64 * 1024 * 1024)
    throw new Error('Startup trace exceeds its read budget');
  return {
    version: 1,
    excludedFiles,
    entrySha256: createHash('sha256')
      .update(fs.readFileSync(path.join(frozenRoot, 'api/dist/index.desktop.js')))
      .digest('hex'),
    files: [...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([relative, bytes]) => ({ relative, bytes })),
  };
}

/** Build-time only: no client credentials, model calls, Redis or UI are started. */
export async function profileDesktopStartup(sourceRoot, frozenRoot, { profileRoot, timeoutMs = 90000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 90000)
    throw new Error('Invalid profile deadline');
  sourceRoot = fs.realpathSync(sourceRoot);
  frozenRoot = fs.realpathSync(frozenRoot);
  profileRoot ??= path.join(path.dirname(frozenRoot), `.startup-profile-${randomUUID()}`);
  profileRoot = path.resolve(profileRoot);
  if (fs.existsSync(profileRoot)) throw new Error('Preserve previous startup profile evidence');
  fs.mkdirSync(profileRoot);
  const ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [frontendPort, apiPort, redisPort] = ports;
  const options = path.join(profileRoot, 'options.json');
  fs.writeFileSync(
    options,
    JSON.stringify({ sourceRoot, frozenRoot, profileRoot, frontendPort, apiPort, redisPort, timeoutMs }),
  );
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key];
  const logPath = path.join(profileRoot, 'build.log');
  const log = fs.openSync(logPath, 'wx');
  try {
    await withFrozenDependencyResolution(
      frozenRoot,
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [fileURLToPath(new URL('./profile-desktop-startup-runner.cjs', import.meta.url)), options],
            {
              env,
              stdio: ['ignore', log, log],
              windowsHide: true,
            },
          );
          child.once('error', reject);
          child.once('exit', (code, signal) => {
            if (code === 0) return resolve();
            // This isolated build child has no client credentials. Keep the
            // bounded failure in CI output as well as its retained source log.
            const detail = fs.readFileSync(logPath, 'utf8').slice(-8000);
            reject(new Error(`Frozen startup profile failed (${code}, ${signal}); log=${logPath}\n${detail}`));
          });
        }),
    );
  } finally {
    fs.closeSync(log);
  }
  const manifest = path.join(frozenRoot, 'api/dist/.startup-read-ahead.json');
  const contents = collectManifest(frozenRoot, profileRoot);
  fs.writeFileSync(manifest, JSON.stringify(contents));
  // Profile data/logs remain outside the shipped output; retain evidence rather
  // than deleting a directory that may contain generated persistent databases.
  return {
    manifest,
    profileRoot,
    apiPort,
    files: contents.files.length,
    bytes: contents.files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  console.log(JSON.stringify(await profileDesktopStartup(process.argv[2], process.argv[3])));
