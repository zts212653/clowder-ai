import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';

import { checkSyncPublicPreflight } from './check-sync-public-preflight.mjs';

const roots = [];
const file = 'docs/features/F999-projection.md';

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function fixture(exemption = 'tips_exempt: internal maintenance\n') {
  const root = mkdtempSync(join(tmpdir(), 'sync-projection-'));
  roots.push(root);
  write(root, 'package.json', '{"scripts":{}}');
  write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
  const content = `---\nfeature_ids: [F999]\n${exemption}---\n# Existing capability\nReference: [old note](./private.md).\n`;
  write(root, file, content);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline'], {
    cwd: root,
  });
  return { root, content };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('legacy public dead-link cleanup alone needs neither a new tip nor renewal of an existing exemption', () => {
  for (const exemption of ['', 'tips_exempt: internal maintenance\n']) {
    const { root, content } = fixture(exemption);
    write(root, file, content.replace('[old note](./private.md)', 'old note'));
    const result = checkSyncPublicPreflight(root, { baseRef: 'HEAD', changedFiles: [file] });
    assert.equal(result.ok, true, result.errors.join('\n'));
  }
});

test('canonical redaction plus dead-link cleanup is still only a mechanical public projection', () => {
  const { root, content } = fixture();
  const baseline = content + 'Source: 0001700000000000-000042-deadbeef\n';
  write(root, file, baseline);
  execFileSync('git', ['add', file], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'source anchor'],
    { cwd: root },
  );
  write(
    root,
    file,
    baseline
      .replace('[old note](./private.md)', 'old note')
      .replace('0001700000000000-000042-deadbeef', 'private-source-id'),
  );
  const result = checkSyncPublicPreflight(root, { baseRef: 'HEAD', changedFiles: [file] });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('new prose or whitespace beside cleanup, live-link stripping, and missing baselines remain covered', () => {
  const { root, content } = fixture();
  const projected = content.replace('[old note](./private.md)', 'old note');
  for (const candidate of [projected + 'New user action.\n', projected + '\n']) {
    write(root, file, candidate);
    assert.equal(checkSyncPublicPreflight(root, { baseRef: 'HEAD', changedFiles: [file] }).ok, false);
  }
  write(root, 'docs/features/private.md', '# This link actually resolves\n');
  write(root, file, projected);
  assert.equal(checkSyncPublicPreflight(root, { baseRef: 'HEAD', changedFiles: [file] }).ok, false);
  assert.equal(checkSyncPublicPreflight(root, { baseRef: 'missing-ref', changedFiles: [file] }).ok, false);
});
