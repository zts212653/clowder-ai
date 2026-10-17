const path = require('node:path');
const fs = require('node:fs');

function canonicalWithMissingSuffix(value) {
  const suffix = [];
  let existing = path.resolve(value);
  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('Cannot resolve desktop data boundary');
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return path.join(fs.realpathSync.native(existing), ...suffix);
}

function assertDesktopDataBoundary(instanceRoot, installRoot) {
  const candidate = canonicalWithMissingSuffix(instanceRoot);
  for (const directory of ['desktop-dist', 'packages', 'node', 'node_modules', path.join('scripts', 'node_modules')]) {
    const payload = canonicalWithMissingSuffix(path.join(installRoot, directory));
    const relative = path.relative(payload, candidate);
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)))
      throw new Error(`Desktop instance root is inside the installation replacement boundary: ${directory}`);
  }
}

/** Opt-in isolated desktop instance; ordinary launches retain all historical defaults. */
function resolveDesktopRuntime(env = process.env, executable = process.execPath) {
  // Persisted installer identity survives upgrades launched without the original shell.
  const directory = path.dirname(executable);
  const legacy = path.join(directory, 'desktop-instance.json');
  const persistent = path.join(path.dirname(directory), 'desktop-instance.json');
  const marker =
    path.basename(directory).toLowerCase() === 'desktop-dist' && fs.existsSync(persistent) ? persistent : legacy;
  if (env.CAT_CAFE_DESKTOP_INSTANCE_ROOT === undefined && fs.existsSync(marker)) {
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (typeof saved.CAT_CAFE_DESKTOP_INSTANCE_ROOT !== 'string' || !saved.CAT_CAFE_DESKTOP_INSTANCE_ROOT)
      throw new Error('Installed desktop instance marker must identify its root');
    env = { ...env, ...saved };
  }
  const instanceRoot = env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
  if (instanceRoot === undefined) return { frontendPort: 3003, apiPort: 3004, redisPort: 6399, instanceRoot: null };
  if (!instanceRoot || !path.isAbsolute(instanceRoot)) throw new Error('Desktop instance root must be absolute');
  assertDesktopDataBoundary(
    instanceRoot,
    path.basename(directory).toLowerCase() === 'desktop-dist' ? path.dirname(directory) : directory,
  );
  const port = (key) => {
    const raw = env[key];
    const value = /^\d+$/.test(raw || '') ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < 1024 || value > 65535 || [3003, 3004, 6399].includes(value))
      throw new Error(`Invalid isolated desktop port: ${key}`);
    return value;
  };
  const config = {
    instanceRoot: path.resolve(instanceRoot),
    frontendPort: port('FRONTEND_PORT'),
    apiPort: port('API_SERVER_PORT'),
    redisPort: port('REDIS_PORT'),
  };
  if (new Set([config.frontendPort, config.apiPort, config.redisPort]).size !== 3)
    throw new Error('Isolated desktop ports must be distinct');
  return config;
}
function rewriteDesktopLoopbackUrl(raw, config) {
  if (!config.instanceRoot) return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) return undefined;
  const port = Number(url.port);
  if (!desktopRedirectPorts(config).includes(port)) return undefined;
  url.port = String(port === 3003 ? config.frontendPort : config.apiPort);
  return url.href;
}
function desktopRedirectPorts(config) {
  return [...new Set([3003, 3004, config.packagedApiPort])].filter(
    (port) => port !== undefined && port !== config.frontendPort && port !== config.apiPort,
  );
}
function readPackagedApiPort(root) {
  const { rewrites } = JSON.parse(fs.readFileSync(path.join(root, 'packages/web/.next/routes-manifest.json'), 'utf8'));
  const rules = Array.isArray(rewrites) ? rewrites : Object.values(rewrites).flat();
  const url = new URL(rules.find((rule) => rule.source === '/api/:path*')?.destination);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !url.port)
    throw new Error('Packaged API rewrite must be a loopback origin for an isolated desktop');
  return Number(url.port);
}
function prepareDesktopInstance(app, config) {
  if (!config.instanceRoot) return;
  const userData = path.join(config.instanceRoot, 'electron');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
}
function initializeDesktopInstance(session, config, projectRoot) {
  if (!config.instanceRoot) return;
  config.packagedApiPort = readPackagedApiPort(projectRoot);
  session.defaultSession.webRequest.onBeforeRequest(
    {
      urls: desktopRedirectPorts(config).flatMap((port) => [
        `http://localhost:${port}/*`,
        `http://127.0.0.1:${port}/*`,
      ]),
    },
    (details, callback) => callback({ redirectURL: rewriteDesktopLoopbackUrl(details.url, config) }),
  );
}
function createDesktopLogger(userDataRoot) {
  const directory = path.join(userDataRoot, 'data', 'logs');
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {}
  const filename = path.join(directory, 'main.log');
  return (message) => {
    try {
      fs.appendFileSync(filename, `[main ${new Date().toISOString()}] ${message}\n`);
    } catch {}
  };
}
module.exports = {
  canonicalWithMissingSuffix,
  resolveDesktopRuntime,
  rewriteDesktopLoopbackUrl,
  readPackagedApiPort,
  desktopRedirectPorts,
  prepareDesktopInstance,
  initializeDesktopInstance,
  createDesktopLogger,
};
