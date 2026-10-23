const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const { copyProfileResource } = require('./profile-resource-copy.cjs');

const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const instance = path.join(options.profileRoot, 'instance');
const app = path.join(options.profileRoot, 'app');
const project = path.join(instance, 'project');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(path.join(app, 'packages'), { recursive: true });
for (const name of ['scripts', '.claude']) fs.mkdirSync(path.join(app, name));
fs.writeFileSync(path.join(project, 'pnpm-workspace.yaml'), 'packages: []\n');
fs.cpSync(path.join(options.frozenRoot, 'api'), path.join(app, 'packages/api'), { recursive: true });
// Match the installed API depth and ordinary critical-resource roots. The
// production reader rejects source reparse points; this fixture flattens them.
for (const name of ['web', 'mcp-server']) {
  const from = path.join(options.frozenRoot, name);
  if (fs.existsSync(from)) fs.symlinkSync(from, path.join(app, 'packages', name), 'junction');
}
fs.symlinkSync(path.join(options.frozenRoot, 'dependencies'), path.join(app, 'node_modules'), 'junction');
for (const name of ['assets', 'docs', 'guides', 'cat-cafe-skills'])
  copyProfileResource(options.sourceRoot, name, path.join(app, name));
for (const name of fs.readdirSync(path.join(options.sourceRoot, 'scripts'))) {
  if (name === 'node_modules') continue;
  const from = path.join(options.sourceRoot, 'scripts', name);
  const to = path.join(app, 'scripts', name);
  if (fs.statSync(from).isDirectory()) fs.symlinkSync(from, to, 'junction');
  else fs.copyFileSync(from, to);
}
for (const name of ['cat-template.json', 'pnpm-workspace.yaml', 'package.json'])
  fs.copyFileSync(path.join(options.sourceRoot, name), path.join(app, name));
Object.assign(process.env, {
  CAT_CAFE_DESKTOP_INSTANCE_ROOT: instance,
  FRONTEND_PORT: String(options.frontendPort),
  API_SERVER_PORT: String(options.apiPort),
  REDIS_PORT: String(options.redisPort),
  HOME: path.join(instance, 'home'),
  USERPROFILE: path.join(instance, 'home'),
  APPDATA: path.join(instance, 'home/AppData/Roaming'),
  LOCALAPPDATA: path.join(instance, 'home/AppData/Local'),
});
const ServiceManager = require(path.join(options.sourceRoot, 'desktop/service-manager.js'));
const manager = new ServiceManager(app, options);
manager.memoryMode = true;
const start = manager._startProcess.bind(manager);
manager._startProcess = (name, command, args, settings) => {
  const capture = pathToFileURL(path.join(__dirname, 'profile-desktop-startup-capture.mjs'));
  capture.searchParams.set('options', pathToFileURL(process.argv[2]).href);
  return start(name, command, [...args.slice(0, 2), '--import', capture.href, ...args.slice(2)], {
    ...settings,
    envOverrides: { ...settings.envOverrides, CAT_CAFE_INVOCATION_REGISTRY: 'memory', PROMETHEUS_PORT: '0' },
  });
};
const abort = new AbortController();
manager.startupAbort = abort;
process.on('SIGTERM', () => abort.abort());
const timeout = setTimeout(() => abort.abort(), options.timeoutMs);
(async () => {
  try {
    manager._ensureUserDataDir(instance);
    await manager._waitForProjectMirrors(instance, 5_000, process.execPath);
    await manager._startApi(process.execPath, instance, abort.signal);
    // The normal startup seam proves an open port, not that the provider's
    // post-listen milestone and trace write have run. Consume the explicit
    // completion evidence under the same bounded deadline before stopping it.
    while (!fs.existsSync(path.join(options.profileRoot, 'files.json'))) {
      abort.signal.throwIfAborted();
      const api = manager.procs.api;
      if (!api || api.exitCode !== null || api.signalCode !== null)
        throw new Error('Profile API exited before its completed startup trace');
      await delay(25, undefined, { signal: abort.signal });
    }
  } finally {
    clearTimeout(timeout);
    await manager.stopAll();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
