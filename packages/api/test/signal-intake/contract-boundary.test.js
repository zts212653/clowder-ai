import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = fileURLToPath(new URL('../../src/domains/signal-intake/', import.meta.url));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('F292 public contract boundary', () => {
  it('consumes beta.9 validators without copying the Feishu C-2 schema into Clowder AI', async () => {
    const files = await sourceFiles(SOURCE_DIR);
    const content = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
    assert.match(content, /validateDeclaredEventsPublishInput/);
    assert.doesNotMatch(content, /feishu\.meeting_artifact\.generated\.v1/);
    assert.doesNotMatch(content, /interface\s+EventsPublishInput/);
    assert.doesNotMatch(content, /artifactId.*artifactKind.*revision/s);
  });
});
