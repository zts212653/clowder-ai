import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
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
        CAT_CAFE_INVOCATION_ID: 'fixture-invocation',
        CAT_CAFE_CALLBACK_TOKEN: 'fixture-callback-token',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const hookOutput = JSON.parse(result.stdout);
    const additionalContext = hookOutput.hookSpecificOutput.additionalContext;
    assert.match(additionalContext, /F296 Trusted Cold Packet/);
    assert.match(additionalContext, /TRUSTED-UNREAD-TAIL/);
    assert.doesNotMatch(additionalContext, /RAW-DIGEST-MUST-NOT-ENTER-PROMPT/);
    assert.doesNotMatch(additionalContext, /Latest Sealed Session Digest/);
    // Recovery must not reintroduce an obsolete parallel authority after compaction.
    assert.doesNotMatch(additionalContext, /布偶猫|All work in this session is YOUR work/);
    assert.doesNotMatch(additionalContext, /explicit user instruction in THIS conversation turn/);
    assert.doesNotMatch(additionalContext, /subagent_type|SUBAGENT COST|Magic Word = 持久偏好信号/);
    assert.match(additionalContext, /current native L0/);
    // F231's recovery-boundary activation survives; the current semantic router owns destinations.
    assert.match(additionalContext, /Post-Compact Signal Check/);
    assert.match(additionalContext, /pre-compact user signals/);
    assert.match(additionalContext, /personal\/relationship facts/);
    assert.match(additionalContext, /reusable taste/);
    assert.match(additionalContext, /repeated tool\/workflow friction/);
    assert.match(additionalContext, /proactive-memory-judgment/);
    assert.match(additionalContext, /profile, taste, harness, or no action/);
    assert.doesNotMatch(additionalContext, /cat_cafe_propose_profile_update/);
    assert.match(additionalContext, /Pre-Compact State Snapshot/);
    assert.match(additionalContext, /F073 SOP STAGE RECOVERY/);
    await assert.rejects(readFile(statePath), { code: 'ENOENT' });
  } finally {
    await unlink(statePath).catch(() => {});
    await rm(fakeBin, { recursive: true, force: true });
  }
});

for (const condition of ['missing', 'expired']) {
  test(`F324 recovery remains silent for ${condition} snapshots`, async () => {
    const sessionId = `f324-${condition}-${process.pid}-${Date.now()}`;
    const statePath = `/tmp/cat-cafe-opus-compact-state-${sessionId}.json`;
    if (condition === 'expired') {
      await writeFile(
        statePath,
        JSON.stringify({
          sessionId,
          compactedAt: new Date(Date.now() - 31 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        }),
      );
    }
    try {
      const result = spawnSync('bash', [join(REPO_ROOT, '.claude/hooks/f24-post-compact-bootstrap.sh')], {
        cwd: REPO_ROOT,
        input: JSON.stringify({ session_id: sessionId }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      await assert.rejects(readFile(statePath), { code: 'ENOENT' });
    } finally {
      await unlink(statePath).catch(() => {});
    }
  });
}
