const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

let windowsUserSid;
const validatedInstallRoots = new Set();

function resolveInstallDataRoot(installRoot) {
  const base = path.join(fs.realpathSync.native(installRoot), 'user-state');
  if (fs.realpathSync.native(base).toLowerCase() !== base.toLowerCase() || !fs.statSync(base).isDirectory()) {
    throw new Error('The installation data directory is missing or redirected');
  }
  windowsUserSid ??= execFileSync(
    path.join(process.env.SystemRoot, 'System32', 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true },
  ).match(/,"(S-1-\d+(?:-\d+)+)"/)?.[1];
  if (!windowsUserSid) throw new Error('Cannot identify the Windows user for desktop storage');
  const dataRoot = path.join(base, windowsUserSid);
  if (validatedInstallRoots.has(dataRoot)) return dataRoot;
  // A sibling account can create a directory named after this SID before the
  // first launch. Verify the physical leaf and its ACL before resolving its
  // path through a restrictive DACL or writing any Electron/API data there.
  assertPrivateInstallProfile(dataRoot, windowsUserSid);
  assertDesktopDataBoundary(dataRoot, installRoot);
  validatedInstallRoots.add(dataRoot);
  return dataRoot;
}

function assertPrivateInstallProfile(dataRoot, sid) {
  const created = !fs.existsSync(dataRoot);
  if (created) fs.mkdirSync(dataRoot);
  if (!fs.lstatSync(dataRoot).isDirectory()) {
    throw new Error('Install data directory must be a directory without reparse points');
  }
  const acl = readInstallProfileAcl(dataRoot);
  const trusted = [sid, 'S-1-5-18', 'S-1-5-32-544'];
  if (!trusted.includes(acl.owner)) throw new Error('Install data directory is owned by another account');
  if (!created && isPrivateInstallProfileAcl(acl, sid, trusted)) return;
  setPrivateProfileAcl(dataRoot, sid);
  if (!isPrivateInstallProfileAcl(readInstallProfileAcl(dataRoot), sid, trusted)) {
    throw new Error('Install data directory ACL verification failed');
  }
}

function isPrivateInstallProfileAcl(acl, sid, trusted) {
  return (
    acl.protected &&
    trusted.includes(acl.owner) &&
    acl.rules.every((rule) => rule.allow === true && trusted.includes(rule.sid)) &&
    acl.rules.some((rule) => rule.sid === sid && rule.fullProfileAccess === true)
  );
}

function windowsPowerShell(script, extraEnv = {}) {
  return execFileSync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        PSModulePath: path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'Modules',
        ),
      },
      windowsHide: true,
    },
  );
}

function readInstallProfileAcl(dataRoot) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$item = Get-Item -LiteralPath $env:SG_ACL_PATH -Force',
    'if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Install data directory is a reparse point" }',
    '$acl = Get-Acl -LiteralPath $item.FullName',
    '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    '$full = [System.Security.AccessControl.FileSystemRights]::FullControl',
    '$children = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit"',
    '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {',
    '  $allow = $_.AccessControlType -eq "Allow"',
    '  $fullProfileAccess = $allow -and ($_.FileSystemRights -band $full) -eq $full -and $_.InheritanceFlags -eq $children -and $_.PropagationFlags -eq "None"',
    '  [pscustomobject]@{sid=$_.IdentityReference.Value; allow=$allow; fullProfileAccess=$fullProfileAccess}',
    '})',
    '[pscustomobject]@{owner=$owner; protected=$acl.AreAccessRulesProtected; rules=$rules} | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');
  try {
    const parsed = JSON.parse(windowsPowerShell(script, { SG_ACL_PATH: dataRoot }));
    if (!Array.isArray(parsed.rules)) throw new Error('Missing ACL rules');
    return parsed;
  } catch {
    throw new Error('Install data directory owner cannot be verified');
  }
}

function setPrivateProfileAcl(dataRoot, sid) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$path = $env:SG_ACL_PATH',
    '$owner = New-Object System.Security.Principal.SecurityIdentifier($env:SG_ACL_SID)',
    '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
    '$acl.SetOwner($owner)',
    '$acl.SetAccessRuleProtection($true, $false)',
    'foreach ($trusted in @($env:SG_ACL_SID, "S-1-5-18", "S-1-5-32-544")) {',
    '  $identity = New-Object System.Security.Principal.SecurityIdentifier($trusted)',
    '  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")',
    '  $acl.AddAccessRule($rule)',
    '}',
    'Set-Acl -LiteralPath $path -AclObject $acl',
  ].join('\n');
  windowsPowerShell(script, { SG_ACL_PATH: dataRoot, SG_ACL_SID: sid });
}

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
  // Windows junctions can be reported by lstat/readlink while
  // realpathSync.native fails with ENOENT (notably for the install-time
  // scripts\node_modules junction). Resolve the link target explicitly so
  // the installation/data boundary check remains fail-closed before the
  // Electron logger and services are initialized.
  const stat = fs.lstatSync(existing);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(existing);
    const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(path.dirname(existing), target);
    return path.join(canonicalWithMissingSuffix(resolvedTarget), ...suffix);
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

/** Resolve the install-owned profile, explicit data root, or isolated desktop identity. */
function resolveDesktopRuntime(env = process.env, executable = process.execPath) {
  // Persisted installer identity survives upgrades launched without the original shell.
  const directory = path.dirname(executable);
  const packaged = path.basename(directory).toLowerCase() === 'desktop-dist';
  const installRoot = packaged ? path.dirname(directory) : directory;
  const legacy = path.join(directory, 'desktop-instance.json');
  const persistent = path.join(installRoot, 'desktop-instance.json');
  const marker = packaged && fs.existsSync(persistent) ? persistent : legacy;
  const hasInstanceMarker = fs.existsSync(marker);
  const dataMarker = path.join(installRoot, 'desktop-data-root.json');
  const hasDataMarker = packaged && fs.existsSync(dataMarker);
  if (hasDataMarker && (hasInstanceMarker || env.CAT_CAFE_DESKTOP_INSTANCE_ROOT !== undefined))
    throw new Error('Choose either isolated instance or persistent data root');
  if (env.CAT_CAFE_DESKTOP_INSTANCE_ROOT === undefined && hasInstanceMarker) {
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (typeof saved.CAT_CAFE_DESKTOP_INSTANCE_ROOT !== 'string' || !saved.CAT_CAFE_DESKTOP_INSTANCE_ROOT)
      throw new Error('Installed desktop instance marker must identify its root');
    env = { ...env, ...saved };
  }
  const instanceRoot = env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
  if (instanceRoot === undefined) {
    const config = { frontendPort: 3003, apiPort: 3004, redisPort: 6399, instanceRoot: null };
    if (!hasDataMarker) return config;
    const { dataRoot, mode } = JSON.parse(fs.readFileSync(dataMarker, 'utf8'));
    if (mode === 'install') {
      return { ...config, dataRoot: resolveInstallDataRoot(installRoot), useInstallDataRoot: true };
    }
    if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot))
      throw new Error('Desktop data root must be absolute');
    if (!fs.existsSync(dataRoot) || !fs.statSync(dataRoot).isDirectory())
      throw new Error('Desktop data root must be an existing directory');
    const canonicalRoot = fs.realpathSync.native(dataRoot);
    const relative = path.relative(fs.realpathSync.native(installRoot), canonicalRoot);
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)))
      throw new Error('Desktop data root must be outside the installation');
    return { ...config, dataRoot: canonicalRoot };
  }
  if (!instanceRoot || !path.isAbsolute(instanceRoot)) throw new Error('Desktop instance root must be absolute');
  assertDesktopDataBoundary(instanceRoot, installRoot);
  const port = (key) => {
    const raw = env[key];
    const value = /^\d+$/.test(raw || '') ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < 1024 || value > 65535 || [3001, 3002, 3003, 3004, 6399].includes(value))
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
  const root = config.instanceRoot ?? config.dataRoot;
  if (!root) return;
  const userData = path.join(root, 'electron');
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
