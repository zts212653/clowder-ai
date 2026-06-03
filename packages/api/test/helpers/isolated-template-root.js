/**
 * Create a process-unique, collision-free template root for tests.
 *
 * Returns { templatePath, root, cleanup }. Point CAT_TEMPLATE_PATH at templatePath;
 * call cleanup() (or register it on 'exit') to remove the root.
 *
 * WHY mkdtempSync instead of `cat-cafe-test-template-${process.pid}` (the bug this fixes,
 * F211 #2013 follow-up):
 *   The API boot path (src/index.ts → bootstrapDefaultCatCatalog) writes an EMPTY
 *   (breeds:[]) .cat-cafe/cat-catalog.json into dirname(CAT_TEMPLATE_PATH) for every
 *   app-booting test. A pid-named temp dir is NOT unique across time — the OS recycles
 *   pids, and setup-cat-registry never cleaned the dir — so a later test process that
 *   inherited a reused pid found the PRIOR process's stale breeds:[] catalog. Its first
 *   getRoster() then collapsed the roster to owner-only, so guardian-matcher and the
 *   community-issues guardian routes flaked candidates=0 under the concurrent suite
 *   (passing in isolation because a fresh pid had no leftover). mkdtempSync appends a
 *   random suffix → a genuinely unique root per invocation, immune to pid reuse; the
 *   cleanup keeps /tmp from accumulating hundreds of stale roots.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export function createIsolatedTemplateRoot(tmpBase, templateSrc) {
  mkdirSync(tmpBase, { recursive: true });
  const root = mkdtempSync(resolve(tmpBase, 'cat-cafe-test-template-'));
  const templatePath = resolve(root, 'cat-template.json');
  cpSync(templateSrc, templatePath);
  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a missing dir (already removed) is fine.
    }
  };
  return { templatePath, root, cleanup };
}
