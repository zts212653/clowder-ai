import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(apiRoot, 'src');
const mcpSourceRoot = resolve(apiRoot, '../mcp-server/src');
const stagingContentPath = resolve(apiRoot, '../../cat-cafe-skills/refs/l0-staging-content.md');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('F254 freshness instruction source contract', () => {
  it('retires the notification owner and every runtime unread-notice prompt, including Live', () => {
    for (const relativePath of [
      'domains/cats/services/freshness/FreshnessNoticeBroker.ts',
      'domains/cats/services/freshness/ThreadUnseenChecker.ts',
      'domains/cats/services/freshness/createProviderNativeFreshnessFactory.ts',
      'domains/cats/services/agents/providers/claude-sdk-input.ts',
      'domains/concierge/live/host/live-inbox-host.ts',
      'domains/concierge/live/inbox/LiveInbox.ts',
    ])
      assert.equal(existsSync(resolve(sourceRoot, relativePath)), false, relativePath);
    for (const path of [...sourceFiles(sourceRoot), ...sourceFiles(mcpSourceRoot)]) {
      assert.doesNotMatch(
        readFileSync(path, 'utf8'),
        /📬 freshness notice|freshnessController|activeInvocationFreshness|Freshness reason:|acknowledgeHeld|catchUpCall|收到来信提示/,
        path,
      );
    }
  });

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

  it(
    'private L0 staging does not restore a retired freshness notice handling rule',
    {
      skip:
        !existsSync(resolve(apiRoot, '../../sync-manifest.yaml')) &&
        !existsSync(stagingContentPath) &&
        'private L0 staging content is absent from public export',
    },
    () => {
      const staging = readFileSync(stagingContentPath, 'utf8');
      assert.doesNotMatch(staging, /\*\*Freshness notice 处理\*\*|收到来信提示/);
    },
  );
});
