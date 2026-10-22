import { createHash } from 'node:crypto';
export const BOOTSTRAP_KEY = 'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE';
export const AUDIT_KEY = 'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE';
const MODES = { [BOOTSTRAP_KEY]: ['strict', 'trusted-host'], [AUDIT_KEY]: ['required', 'warn-bootstrap-root'] };
const MANAGED_KEYS = [
  ...Object.keys(MODES),
  'AUDIT_LOG_DIR',
  'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY',
  'CAT_CAFE_DATA_DIR',
];
export const fingerprint = (value) => createHash('sha256').update(value).digest('hex');

export function parseDeploymentEnv(text) {
  const env = {};
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const exported = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
    if (exported && MANAGED_KEYS.includes(exported[1]))
      throw Error(
        `Unsupported deployment assignment: export ${exported[1]}; use a literal KEY=value entry before preparation`,
      );
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    if (Object.hasOwn(env, match[1]) && MANAGED_KEYS.includes(match[1]))
      throw Error(`Duplicate deployment key: ${match[1]}`);
    const raw = match[2];
    env[match[1]] = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return env;
}
export function validateDeploymentTemplate(text) {
  if (text.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith('#') && !/^\s*[A-Z_]+=/.test(line)))
    throw Error('Intranet template must contain only comments and two literal assignments');
  const env = parseDeploymentEnv(text);
  if (Object.keys(env).length !== 2 || Object.keys(env).some((key) => !MODES[key]))
    throw Error('Intranet template may contain only the two ACP mode keys');
  validateModes(env);
  return env;
}
export function validateModes(env) {
  for (const [key, choices] of Object.entries(MODES))
    if (Object.hasOwn(env, key) && !choices.includes(env[key]))
      throw Error(`${key} must be ${choices.join(' or ')}; existing values were preserved`);
}
export function missingDeploymentModes(existing, template) {
  validateModes(existing);
  const result = {};
  const legacy = Object.hasOwn(existing, 'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY');
  for (const key of Object.keys(MODES)) {
    if (Object.hasOwn(existing, key)) continue;
    result[key] = legacy
      ? existing.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY === '1'
        ? MODES[key][1]
        : MODES[key][0]
      : template[key];
  }
  return result;
}
export function appendDeploymentKeys(text, additions, preparationId) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let next = text;
  if (next && !next.endsWith('\n')) next += newline;
  next += `${newline}# Clowder intranet preparation: ${preparationId}${newline}`;
  for (const [key, value] of Object.entries(additions))
    next += `${key}="${String(value).replaceAll('\\', '/')}"${newline}`;
  return next;
}
