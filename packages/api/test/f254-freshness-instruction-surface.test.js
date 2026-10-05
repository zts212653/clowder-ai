import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(apiRoot, 'src');
const stagingContentPath = resolve(apiRoot, '../../cat-cafe-skills/refs/l0-staging-content.md');

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

  it('every freshness read instruction selects unread independently from the full projection', () => {
    const paths = [
      'domains/cats/services/freshness/FreshnessNoticeService.ts',
      'domains/cats/services/freshness/FreshnessNoticeBroker.ts',
      'domains/cats/services/freshness/createFreshnessReinvokeCheck.ts',
      'domains/concierge/conversation-duty.ts',
    ];
    for (const path of paths) {
      const instructions = readFileSync(resolve(sourceRoot, path), 'utf8')
        .split('\n')
        .filter((line) => line.includes('get_thread_context') && line.includes('responseMode'));
      assert.ok(instructions.length > 0, path);
      for (const instruction of instructions) assert.match(instruction, /readIntent(?:: |=)"unread"/, path);
    }
  });

  it(
    'home staging freshness instructions select unread independently from the full projection',
    {
      skip:
        !existsSync(resolve(apiRoot, '../../sync-manifest.yaml')) &&
        !existsSync(stagingContentPath) &&
        'private L0 staging content is absent from public export',
    },
    () => {
      const staging = readFileSync(stagingContentPath, 'utf8');
      const instruction = staging.split('\n').find((line) => line.includes('**Freshness notice 处理**'));
      assert.match(instruction, /readIntent: "unread"/);
    },
  );
});
