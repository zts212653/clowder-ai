import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSessionCredentialFile } from './session-credential-file.js';

/** Project MCP JSON may refer to a private credential file, never copy a callback token. */
export async function prepareKimiMcpCredentialLease(callbackEnv: Record<string, string>): Promise<{
  path?: string;
  env: Record<string, string>;
  dispose(): Promise<void>;
}> {
  const existing = callbackEnv.CAT_CAFE_CREDENTIAL_FILE;
  if (existing) return { path: existing, env: { CAT_CAFE_CREDENTIAL_FILE: existing }, dispose: async () => {} };
  if (!callbackEnv.CAT_CAFE_CALLBACK_TOKEN && !callbackEnv.CAT_CAFE_INVOCATION_ID)
    return { env: {}, dispose: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), 'cat-cafe-kimi-mcp-auth-'));
  const path = join(directory, 'credentials.json');
  if (!writeSessionCredentialFile(callbackEnv, path)) {
    await rm(directory, { recursive: true, force: true });
    throw new Error('kimi_mcp_callback_credentials_unavailable');
  }
  return {
    path,
    env: { CAT_CAFE_CREDENTIAL_FILE: path },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
