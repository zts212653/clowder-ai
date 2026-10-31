import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function credentialName(path, cwd) {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const name = basename(normalized);
  if (/^\.env(?:\..+)?$/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name)) return true;
  if (['.mcp.json', '.netrc', '.npmrc', 'id_rsa', 'id_ed25519', 'id_ecdsa'].includes(name)) return true;
  if (/(?:^|\/)\.kimi-code\/(?:config\.toml|mcp\.json|credentials(?:\/.*)?)$/.test(normalized)) return true;
  if (/(?:^|\/)\.dsh\/\.credentials\.ya?ml$/.test(normalized)) return true;
  if (/(?:^|\/)\.cat-cafe\/oc-config-[^/]+\/opencode\.json$/.test(normalized)) return true;
  if (normalized === resolve(cwd, homedir(), '.claude/settings.json').toLowerCase()) return true;
  if (/(?:^|\/)(?:\.cat-cafe\/mcp-creds|cat-cafe-credentials)\//.test(normalized)) return true;
  if (/\.gemini\/(?:oauth_creds\.json|config\/mcp_config\.json)$/.test(normalized)) return true;
  return /(?:^|\/)(?:\.aws\/credentials|\.config\/gh\/hosts\.ya?ml|\.codex\/auth\.json|\.claude\/\.credentials\.json|\.gemini\/[^\n]*\/(?:[^/]*token[^/]*|oauth_creds\.json))$/.test(
    normalized,
  );
}

export function credentialSourcesFromEnvironment(environment = process.env, cwd = process.cwd()) {
  const files = [
    'CAT_CAFE_CREDENTIAL_FILE',
    'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
    'CODEX_CREDENTIALS_PATH',
    'CLAUDE_CREDENTIALS_PATH',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]
    .map((key) => environment[key])
    .filter(Boolean);
  const directories = [];
  for (const [key, filenames] of [
    ['CODEX_HOME', ['auth.json']],
    ['CLAUDE_CONFIG_DIR', ['.credentials.json', 'settings.json']],
    ['GEMINI_HOME', ['oauth_creds.json', 'config/mcp_config.json']],
    ['GH_CONFIG_DIR', ['hosts.yml']],
    ['XDG_CONFIG_HOME', ['gh/hosts.yml']],
  ]) {
    if (environment[key]) files.push(...filenames.map((name) => resolve(cwd, environment[key], name)));
  }
  for (const key of ['HOME', 'USERPROFILE'])
    if (environment[key]) files.push(resolve(cwd, environment[key], '.claude/settings.json'));
  const mcp = environment.CAT_CAFE_MCP_CREDS_DIR?.trim();
  const kimi = environment.KIMI_CODE_HOME && resolve(cwd, environment.KIMI_CODE_HOME);
  const dsh = environment.DSH_HOME && resolve(cwd, environment.DSH_HOME);
  if (mcp) directories.push(mcp);
  if (kimi) {
    files.push(resolve(kimi, 'config.toml'), resolve(kimi, 'mcp.json'));
    directories.push(resolve(kimi, 'credentials'));
  }
  if (dsh) files.push(resolve(dsh, '.credentials.yaml'));
  return { files: files.map((file) => resolve(cwd, file)), directories: directories.map((dir) => resolve(cwd, dir)) };
}

/** Only use credentials already configured by this host; never discover or open a key store. */
export function configuredCredentialValues(environment = process.env) {
  return [
    ...new Set(
      Object.entries(environment)
        .filter(
          ([name, value]) =>
            /(?:^|_)(?:API_?KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CALLBACK_TOKEN|CLIENT_SECRET|SECRET_ACCESS_KEY|PRIVATE_KEY|PASSWORD|PASSWD|TOKEN|SECRET)$/i.test(
              name,
            ) &&
            typeof value === 'string' &&
            value.length >= 24,
        )
        .map(([, value]) => value),
    ),
  ];
}

function pathIdentities(path, cwd = process.cwd()) {
  const absolute = resolve(cwd, path);
  try {
    return [absolute, realpathSync(absolute)];
  } catch {
    // A not-yet-created configured source still has its lexical identity.
    return [absolute];
  }
}

function configuredCredentialMatch(requested, cwd, { files, directories }) {
  if (files.some((file) => pathIdentities(file, cwd).some((identity) => requested.includes(identity)))) return true;
  return directories.some((directory) =>
    pathIdentities(directory, cwd).some((identity) =>
      requested.some((path) => path === identity || path.startsWith(`${identity}${sep}`)),
    ),
  );
}

// Follow symlinks for an explicit file operand; never open its contents to decide.
export function isCredentialSource(path, cwd = process.cwd(), credentialSources) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return false;
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path);
    } catch {
      return true;
    }
  }
  const requested = pathIdentities(path, cwd);
  return (
    requested.some((path) => credentialName(path, cwd)) ||
    configuredCredentialMatch(requested, cwd, credentialSourcesFromEnvironment(process.env, cwd)) ||
    (credentialSources ? configuredCredentialMatch(requested, cwd, credentialSources) : false)
  );
}
