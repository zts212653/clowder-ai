import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

describe('F296 source-only Claude hook authentication', () => {
  test('all Claude project hooks use the invocation callback pair and never the legacy global bearer', () => {
    for (const relativePath of [
      '../../../.claude/hooks/f24-pre-compact.sh',
      '../../../.claude/hooks/f24-post-compact-bootstrap.sh',
      '../../../.claude/hooks/sop-stage-bookmark.sh',
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      assert.match(source, /X-Invocation-Id:/, relativePath);
      assert.match(source, /X-Callback-Token:/, relativePath);
      assert.doesNotMatch(source, /CAT_CAFE_HOOK_TOKEN|X-Cat-Cafe-Hook-Token/, relativePath);
    }
  });
});
