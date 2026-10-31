import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readIgnoredItemPreferences } from '../../../api/dist/config/user-preferences-ignored-items.js';
import { configIgnoredItemRoutes } from '../../../api/dist/routes/config-ignored-items.js';

/** Original owner-private preference reader/writer, confined to a disposable filesystem directory. */
export async function createMentionPreferencesFixture(app) {
  const root = await mkdtemp(path.join(tmpdir(), 'f322-old-shell-personal-'));
  await configIgnoredItemRoutes(app, { projectRoot: root });
  return {
    read: (owner) => readIgnoredItemPreferences(root, owner),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
