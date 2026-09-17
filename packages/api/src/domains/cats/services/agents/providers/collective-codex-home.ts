import { mkdir, stat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Project an existing CLI login without projecting its instructions, skills, history or config.
 * A file link keeps OAuth refresh on the canonical credential file; credentials are never copied.
 */
export async function prepareCollectiveCodexHome(
  directory: string,
  authMode: 'oauth' | 'api_key' | 'auto',
  credentialHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
) {
  const publicHome = join(directory, 'home');
  const publicCodexHome = join(publicHome, '.codex');
  await mkdir(publicCodexHome, { recursive: true, mode: 0o700 });
  if (authMode !== 'api_key') {
    const authFile = join(credentialHome, 'auth.json');
    const info = await stat(authFile).catch(() => undefined);
    if (!info?.isFile())
      throw Object.assign(new Error('Public participation requires an existing canonical Codex file login'), {
        code: 'PARTICIPATION_AUTH_UNAVAILABLE',
      });
    await symlink(authFile, join(publicCodexHome, 'auth.json'));
  }
  return {
    HOME: publicHome,
    CODEX_HOME: publicCodexHome,
    ...(process.platform === 'win32' ? { USERPROFILE: publicHome } : {}),
  };
}
