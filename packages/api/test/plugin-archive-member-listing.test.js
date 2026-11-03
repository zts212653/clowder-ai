import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveMembers } from '../dist/domains/plugin/external-runtime/package-staging.js';

test('Windows tar CRLF listings select the same canonical members as LF listings', () => {
  const members = ['package/manifest.json', 'package/agent-provider.json'];
  assert.deepEqual(archiveMembers(`${members.join('\r\n')}\r\n`), members);
  assert.deepEqual(archiveMembers(`${members.join('\n')}\n`), members);
});

test('line-ending handling still rejects non-portable archive paths', () => {
  for (const member of ['package\\manifest.json', '../manifest.json', '/package/manifest.json']) {
    assert.throws(() => archiveMembers(`${member}\r\n`), /non-portable|canonical package/);
  }
});
