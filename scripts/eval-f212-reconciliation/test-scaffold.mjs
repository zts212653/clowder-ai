/**
 * Shared test fixture scaffolding for F212 Phase H AC-H10 reconciliation-eval tests.
 * Extracted from the parent test file per cloud R4 P1 (AGENTS.md 350-line hard cap).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create a temporary archive dir + message store from an in-memory spec.
 * `archives`: { invocationId: [ndjson-record-object, ...] }
 * `messages`: [message-store-record-object, ...]
 * Returns { archiveDir, messageStorePath } absolute paths.
 */
export function scaffold({ archives, messages }) {
  const root = mkdtempSync(join(tmpdir(), 'f212-eval-'));
  const archiveDir = join(root, 'cli-raw-archive');
  const dayDir = join(archiveDir, '2026-07-09');
  mkdirSync(dayDir, { recursive: true });
  for (const [id, lines] of Object.entries(archives)) {
    writeFileSync(join(dayDir, `${id}.ndjson`), lines.map((o) => JSON.stringify(o)).join('\n'));
  }
  const messageStorePath = join(root, 'messages');
  mkdirSync(messageStorePath, { recursive: true });
  writeFileSync(join(messageStorePath, 'msgs.jsonl'), messages.map((o) => JSON.stringify(o)).join('\n'));
  return { archiveDir, messageStorePath };
}
