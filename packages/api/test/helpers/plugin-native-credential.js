import { readFile } from 'node:fs/promises';

export async function readPluginNativeToken(environment) {
  const path = environment.CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE;
  if (!path) throw new Error('plugin native credential file is unavailable');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (parsed?.v !== 1 || typeof parsed.token !== 'string' || parsed.token.length === 0) {
    throw new Error('plugin native credential file is invalid');
  }
  return parsed.token;
}
