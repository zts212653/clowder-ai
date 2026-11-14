import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGY_OAUTH_FILE, agyOAuthFile, assertAgyCredentialHome } from '../../../../../../../config/agy-account.js';

const SHARED_DIRECTORIES = ['brain', 'conversations', 'implicit'];
const SHARED_FILES = [
  'conversation_summaries.db',
  'conversation_summaries.db-wal',
  'conversation_summaries.db-shm',
  'installation_id',
];

function directory(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('agy_account_view_directory_unsafe');
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
function link(target: string, path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isSymbolicLink() || resolve(readlinkSync(path)) !== target)
      throw new Error('agy_account_view_link_changed');
    return;
  }
  symlinkSync(target, path);
}

/**
 * A stable view per member/account: only the official token file belongs to the
 * account. All conversation data keeps the member's original canonical owner.
 * The CLI writes through its token link (1.5.6 uses os.WriteFile); no token copy.
 * Called inside the existing profile preparation lease.
 */
export function prepareAgyAccountDataView(profileHome: string, credentialHome: string): string {
  assertAgyCredentialHome(credentialHome);
  const account = realpathSync(credentialHome);
  const data = join(profileHome, '.gemini', 'antigravity-cli');
  const views = join(profileHome, '.cat-cafe-account-views');
  const view = join(views, createHash('sha256').update(account).digest('hex'));
  directory(views);
  directory(view);
  // Settings, entitlement caches and plugin secrets stay private. The CLI
  // atomically replaces some of them, so linking every app-data entry is wrong.
  for (const name of [...SHARED_DIRECTORIES, ...SHARED_FILES]) {
    const target = join(data, name);
    if (SHARED_DIRECTORIES.includes(name)) directory(target);
    else {
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
        throw new Error('agy_shared_session_file_unsafe');
    }
    link(target, join(view, name));
  }
  link(agyOAuthFile(account), join(view, AGY_OAUTH_FILE));
  return view;
}
