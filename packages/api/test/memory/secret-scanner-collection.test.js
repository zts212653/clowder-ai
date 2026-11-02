import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { CollectionIndexBuilder } from '../../dist/domains/memory/CollectionIndexBuilder.js';
import { FlatScanner } from '../../dist/domains/memory/FlatScanner.js';
import { SecretScanner } from '../../dist/domains/memory/SecretScanner.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

it('indexes the unedited F236 prose, then blocks and purges real credentials before embedding', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'issue1450-secret-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  const manifest = {
    id: 'probe',
    root,
    reviewPolicy: { authorityCeiling: 'validated' },
  };
  const builder = new CollectionIndexBuilder(store, manifest, new FlatScanner('probe'));
  writeFileSync(
    join(root, 'doc.md'),
    '# Original\n\n（correlation key = messageId/taskId/sourceTool/previewEventId）；',
  );
  writeFileSync(join(root, 'authors.md'), '# Authors\n\nauthor: AdaLovelace/GraceHopper/BarbaraLiskov');
  const clean = await builder.rebuild();
  assert.equal(clean.blocked, false);
  assert.equal(clean.indexed, 2);
  assert.ok(await store.getByAnchor('probe:doc/doc'));
  writeFileSync(join(root, 'leaked.md'), 'password = "CorrectHorse/BatteryStaple/PurpleCloud/Sunshine"');
  const blocked = await builder.rebuild();
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.secretFindings[0].file, 'leaked.md');
  assert.equal(blocked.indexed, 0);
  assert.equal(await store.getByAnchor('probe:doc/doc'), null);
});

it('preserves vendor patterns, placeholder/fence policy and one finding per line', () => {
  const strong = [
    ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
    ...['p', 'o', 'u', 's', 'r'].map((kind) => ['github-token', `gh${kind}_${'A'.repeat(36)}`]),
    ['github-token', `github_pat_${'A'.repeat(82)}`],
    ['openai-key', `sk-${'A'.repeat(32)}`],
    ['anthropic-key', `sk-ant-${'A'.repeat(90)}`],
    ['slack-token', `xoxb-${'A'.repeat(10)}`],
    ['private-key', '-----BEGIN PRIVATE KEY-----'],
  ];
  strong.forEach(([type, token]) => {
    const findings = SecretScanner.scan(`Some prose ${token}`, 'x.md');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, type);
    assert.deepEqual(SecretScanner.scan(`~~~\n${token}\n~~~`, 'x.md'), []);
  });
  assert.deepEqual(SecretScanner.scan('token = YOUR_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890', 'x.md'), []);
  assert.equal(SecretScanner.scan(strong.map(([, token]) => token).join(' '), 'x.md').length, 1);
});
