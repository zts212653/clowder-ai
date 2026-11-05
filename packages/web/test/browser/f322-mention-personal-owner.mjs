import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Actual authorized preference writer, isolated per browser journey and persisted on disk. */
export async function installMentionPreferences(app) {
  const require = createRequire(new URL('../../../api/package.json', import.meta.url));
  const unregister = require('tsx/esm/api').register();
  const [{ configIgnoredItemRoutes }, { readIgnoredItemPreferences }] = await Promise.all([
    import('../../../api/src/routes/config-ignored-items.ts'),
    import('../../../api/src/config/user-preferences-ignored-items.ts'),
  ]).finally(unregister);
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'f322-mention-preferences-'));
  await app.register(configIgnoredItemRoutes, { projectRoot });
  return {
    read: (ownerUserId) => readIgnoredItemPreferences(projectRoot, ownerUserId),
    close: () => rm(projectRoot, { recursive: true, force: true }),
  };
}
