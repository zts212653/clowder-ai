const { execFile } = require('node:child_process');
const path = require('node:path');

function readWindowsPath(signal) {
  // .NET expands REG_EXPAND_SZ using the host environment. Base64 keeps
  // non-ASCII directories independent of the installer's console code page.
  const command =
    "$paths = @{ machinePath = [string][Environment]::GetEnvironmentVariable('Path', 'Machine'); " +
    "userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User') } | ConvertTo-Json -Compress; " +
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($paths))';
  return new Promise((resolve) => {
    execFile(
      path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, signal },
      (error, stdout) => {
        if (error || !stdout.trim()) return resolve(null);
        // Validate the subprocess response once at this boundary.
        try {
          const paths = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
          resolve(
            typeof paths?.machinePath === 'string' && paths.machinePath.trim() && typeof paths?.userPath === 'string'
              ? paths
              : null,
          );
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function mergeWindowsPath(env, paths) {
  if (!paths) return env;
  const pathKeys = Object.keys(env)
    .filter((key) => key.toUpperCase() === 'PATH')
    .sort();
  const pathKey = pathKeys[0] ?? 'Path';
  const inheritedPath = env[pathKey] ?? '';
  const normalize = (entry) =>
    entry
      .replace(/^"(.*)"$/, '$1')
      .replaceAll('/', '\\')
      .replace(/\\+$/, '')
      .toLowerCase();
  const [machine, user, inherited] = [paths.machinePath, paths.userPath, inheritedPath].map((value) =>
    value
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const present = new Set(inherited.map(normalize));
  if (user.some((entry) => !present.has(normalize(entry)))) {
    // Repair incomplete installer snapshots with the normal machine -> user
    // order, retaining parent-only directories after the registered entries.
    const seen = new Set();
    env[pathKey] = [...machine, ...user, ...inherited]
      .filter((entry) => {
        const key = normalize(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join(';');
  }
  // Node forwards the first case-insensitive key in lexical order on Windows.
  pathKeys.slice(1).forEach((key) => {
    delete env[key];
  });
  return env;
}

module.exports = { readWindowsPath, mergeWindowsPath };
