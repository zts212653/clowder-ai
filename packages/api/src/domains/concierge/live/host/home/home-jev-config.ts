import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createJevPageSelector } from '../../../action/jev/JevPageSelector.js';

/** Owner's existing local credential stays in API memory; no page-specific configuration is needed at home. */
export async function readHomeJevSelector(env: NodeJS.ProcessEnv = process.env) {
  let apiKey = env.TYPESAFE_API_KEY;
  if (!apiKey) {
    const path = env.TYPESAFE_API_KEY_FILE ?? join(homedir(), '.config', 'typesafe', 'api-key');
    if (!isAbsolute(path)) throw new Error('Jev credential requires an absolute file');
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > 4096 || (metadata.mode & 0o077) !== 0)
        throw new Error('Jev credential file is not private');
      apiKey = (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Jev credential unavailable');
    }
  }
  return createJevPageSelector({ apiKey });
}
