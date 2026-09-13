import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isDirectExecution(moduleUrl: string, entryPath = process.argv[1]): boolean {
  if (!entryPath) return false;
  try {
    // Node resolves the main module URL through directory symlinks/junctions,
    // while argv[1] can retain the launch alias. Compare canonical files.
    return realpathSync.native(fileURLToPath(moduleUrl)) === realpathSync.native(entryPath);
  } catch {
    // An import, missing path or non-file URL must never start a server.
    return false;
  }
}
