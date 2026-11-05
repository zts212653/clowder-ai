const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const clientKeys = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  dsh: 'DSH_HOME',
  kimi: 'KIMI_CODE_HOME',
  pi: 'PI_CODING_AGENT_DIR',
  npmCache: 'npm_config_cache',
};

/** Explicit, local-only client reuse. Clowder HOME and persistence stay isolated.
 * No credentials are copied; clients retain ownership of their login refresh.
 */
function readClientHomes(instanceRoot) {
  if (!instanceRoot) return {};
  const file = path.join(instanceRoot, 'client-homes.json');
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return Object.fromEntries(
      Object.entries(value).map(([key, directory]) => {
        if (!Object.hasOwn(clientKeys, key) || typeof directory !== 'string' || !path.isAbsolute(directory))
          throw new Error();
        const canonical = fs.realpathSync.native(directory);
        if (!fs.statSync(canonical).isDirectory()) throw new Error();
        return [clientKeys[key], canonical];
      }),
    );
  } catch {
    // Do not log configuration contents or silently fall back to another login.
    throw new Error('Invalid desktop client-homes configuration');
  }
}

/** Resolve host-owned client directories for an ordinary (non-isolated) launch.
 * This only returns directory bindings; credentials and sessions stay in place.
 */
function envOrPath(env, key, fallback) {
  return env[key]?.trim() || fallback;
}

function resolveExistingDirectory(directory) {
  if (!directory || !path.isAbsolute(directory)) return null;
  try {
    return fs.statSync(directory).isDirectory() ? fs.realpathSync.native(directory) : null;
  } catch {
    return null;
  }
}

function resolveDefaultClientHomes(env = process.env, homeDir = os.homedir()) {
  const profile = envOrPath(env, 'USERPROFILE', homeDir);
  const candidates = {
    claude: envOrPath(env, 'CLAUDE_CONFIG_DIR', path.join(profile, '.claude')),
    codex: envOrPath(env, 'CODEX_HOME', path.join(profile, '.codex')),
    dsh: envOrPath(env, 'DSH_HOME', path.join(profile, '.dsh')),
    kimi: envOrPath(env, 'KIMI_CODE_HOME', path.join(profile, '.kimi-code')),
    pi: envOrPath(env, 'PI_CODING_AGENT_DIR', path.join(profile, '.pi', 'agent')),
    npmCache: envOrPath(env, 'npm_config_cache', path.join(env.LOCALAPPDATA || '', 'npm-cache')),
  };
  const resolved = {};
  for (const [key, directory] of Object.entries(candidates)) {
    const canonical = resolveExistingDirectory(directory);
    if (canonical) resolved[key] = canonical;
  }
  return Object.fromEntries(Object.entries(resolved).map(([key, directory]) => [clientKeys[key], directory]));
}

module.exports = { readClientHomes, resolveDefaultClientHomes };
