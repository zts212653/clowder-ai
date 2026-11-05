import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readAheadApi } from './api-startup-read-ahead.mjs';

test('the default read budget permits cold I/O beyond the former warm-only 1500ms limit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-cold-budget-'));
  const entry = path.join(root, 'packages/api/dist/index.desktop.js');
  const dependency = path.join(root, 'node_modules/witness/index.js');
  try {
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.mkdir(path.dirname(dependency), { recursive: true });
    await fs.writeFile(entry, 'export const value=1;');
    await fs.writeFile(dependency, '1');
    await fs.writeFile(
      path.join(path.dirname(entry), '.startup-read-ahead.json'),
      JSON.stringify({
        version: 1,
        entrySha256: createHash('sha256')
          .update(await fs.readFile(entry))
          .digest('hex'),
        files: [{ relative: 'node_modules/witness/index.js', bytes: 1 }],
      }),
    );
    const result = await readAheadApi(entry, {
      io: {
        ...fs,
        readFile: async (file, options) => {
          if (path.basename(String(file)) === 'index.js') await new Promise((resolve) => setTimeout(resolve, 1800));
          return fs.readFile(file, options);
        },
      },
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.files, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
