import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const invocationDir = path.resolve(testDir, '../src/domains/cats/services/agents/invocation');
const receiptDock = path.resolve(testDir, '../../web/src/components/MessageReceiptDock.tsx');

async function lineCount(file) {
  return (await readFile(file, 'utf8')).split('\n').length;
}

describe('F298 Phase B restart reconciler structure', () => {
  it('keeps every startup custody implementation module within the 350-line hard limit', async () => {
    const files = (await readdir(invocationDir)).filter(
      (name) =>
        name.endsWith('.ts') &&
        (name.startsWith('QueuedMessageCustodyStartup') ||
          name.startsWith('QueuedMessageCustodyRestart') ||
          name === 'QueuedMessageCustodyCarrierProjection.ts' ||
          name === 'QueuedMessageCustodyRuntimeRestartAttempts.ts' ||
          name === 'QueuedMessageCustodyA2ARestartPreflight.ts'),
    );
    assert.ok(files.length > 1, 'restart custody responsibilities must be split across focused modules');
    for (const file of files) {
      const lines = await lineCount(path.join(invocationDir, file));
      assert.ok(lines <= 350, `${file} has ${lines} lines; expected <= 350`);
    }
  });

  it('keeps the touched receipt implementation within the 350-line hard limit', async () => {
    const lines = await lineCount(receiptDock);
    assert.ok(lines <= 350, `MessageReceiptDock.tsx has ${lines} lines; expected <= 350`);
  });
});
