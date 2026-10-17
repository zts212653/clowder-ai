const fs = require('node:fs');
const path = require('node:path');

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
module.exports = { readClientHomes };
