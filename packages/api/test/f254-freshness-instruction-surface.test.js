import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(apiRoot, 'src');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('F254 freshness instruction source contract', () => {
  it('never directs current-thread unread handling to the project-memory list_recent surface', () => {
    const violations = [];
    const promptMarkers = /未读消息|新消息|查看并回应|freshness notice/i;

    for (const path of sourceFiles(sourceRoot)) {
      const source = readFileSync(path, 'utf8');
      let cursor = source.indexOf('list_recent');
      while (cursor !== -1) {
        const nearby = source.slice(Math.max(0, cursor - 180), cursor + 220);
        if (promptMarkers.test(nearby)) {
          const line = source.slice(0, cursor).split('\n').length;
          violations.push(`${relative(apiRoot, path)}:${line}`);
        }
        cursor = source.indexOf('list_recent', cursor + 1);
      }
    }

    assert.deepEqual(violations, [], 'freshness prompts must use a full, contiguous cat_cafe_get_thread_context read');
  });
});
