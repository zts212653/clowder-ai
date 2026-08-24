import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('F296 B3b-3 hook injects only the API-selected cold packet, never the raw digest', async () => {
  const sessionId = `f296-b3b3-${process.pid}-${Date.now()}`;
  const statePath = `/tmp/cat-cafe-opus-compact-state-${sessionId}.json`;
  const fakeBin = await mkdtemp(join(tmpdir(), 'f296-b3b3-bin-'));
  const fakeCurl = join(fakeBin, 'curl');
  await writeFile(
    fakeCurl,
    '#!/bin/sh\ncase "$*" in\n  *latest-digest*) printf "%s" "$F296_FAKE_DIGEST" ;;\n  *) exit 1 ;;\nesac\n',
  );
  await chmod(fakeCurl, 0o755);
  await writeFile(
    statePath,
    JSON.stringify({
      sessionId,
      trigger: 'auto',
      compactedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      sealStatus: 'ok',
    }),
  );

  try {
    const fakeDigest = JSON.stringify({
      digest: { secretHistory: 'RAW-DIGEST-MUST-NOT-ENTER-PROMPT' },
      postCompact: {
        status: 'projected',
        contextPacket: '[Context Continuity]\n{"contextMode":"cold"}\nTRUSTED-UNREAD-TAIL',
      },
    });
    const result = spawnSync('bash', [join(REPO_ROOT, '.claude/hooks/f24-post-compact-bootstrap.sh')], {
      cwd: REPO_ROOT,
      input: JSON.stringify({ session_id: sessionId }),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        F296_FAKE_DIGEST: fakeDigest,
        CAT_CAFE_HOOK_TOKEN: 'fixture-token',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const hookOutput = JSON.parse(result.stdout);
    const additionalContext = hookOutput.hookSpecificOutput.additionalContext;
    assert.match(additionalContext, /F296 Trusted Cold Packet/);
    assert.match(additionalContext, /TRUSTED-UNREAD-TAIL/);
    assert.doesNotMatch(additionalContext, /RAW-DIGEST-MUST-NOT-ENTER-PROMPT/);
    assert.doesNotMatch(additionalContext, /Latest Sealed Session Digest/);
  } finally {
    await unlink(statePath).catch(() => {});
    await rm(fakeBin, { recursive: true, force: true });
  }
});
