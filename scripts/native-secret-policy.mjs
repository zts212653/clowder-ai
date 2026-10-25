import { isCredentialSource } from './lib/secret-credential-paths.mjs';
import { inspectSecretValue } from './lib/secret-value-inspection.mjs';
import { secretShellDenial } from './native-secret-shell.mjs';

const PATH_FIELD = /^(?:paths?|files?|filenames?|filepaths?|absolutepaths?|targetfiles?|searchpaths?|uris?|urls?)$/i;

/** Only secret policy lives here. Existing effect/target decisions retain their owner. */
export function nativeSecretDenial(payload, credentialSources) {
  const input = payload?.tool_input;
  const tool = typeof payload?.tool_name === 'string' ? payload.tool_name : '';
  if (!input || (typeof input !== 'object' && typeof input !== 'string')) return null;
  try {
    if (inspectSecretValue(input).rules.length) return 'secret_content_blocked_before_send';
  } catch {
    return 'secret_payload_uninspectable';
  }
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  if (/read|grep|search|view_file/i.test(tool) && protectedReadField(input, cwd, credentialSources))
    return 'credential_source_blocked_before_read';
  const command = typeof input === 'string' ? input : (input.command ?? input.cmd);
  return typeof command === 'string' ? secretShellDenial(command, cwd, credentialSources) : null;
}

function protectedReadField(value, cwd, credentialSources, key = 'path') {
  if (typeof value === 'string')
    return PATH_FIELD.test(key.replace(/[_-]/g, '')) && isCredentialSource(value, cwd, credentialSources);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((child) => protectedReadField(child, cwd, credentialSources, key));
  return Object.entries(value).some(([name, child]) => protectedReadField(child, cwd, credentialSources, name));
}
