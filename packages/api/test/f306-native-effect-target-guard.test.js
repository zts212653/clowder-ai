import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const guardModule = import('../../../scripts/native-effect-target-guard.mjs');
const hookPath = fileURLToPath(new URL('../../../scripts/native-effect-target-guard.mjs', import.meta.url));

function candidate(effect, kind, value = '/tmp/ordinary', source = {}) {
  return {
    effect,
    target: { kind, value },
    source: { provider: 'codex', tool: 'shell', cwd: '/tmp/work', ...source },
  };
}

describe('F306 AC-C7 provider-neutral effect/target policy', () => {
  test('denies protected irreversible or uncertain effects without making workspace a jail', async () => {
    const { decideNativeEffect } = await guardModule;

    assert.equal(decideNativeEffect(candidate('write', 'runtime_sanctuary')).decision, 'deny');
    assert.equal(
      decideNativeEffect(candidate('service_mutation', 'redis_sanctuary', 'redis://127.0.0.1:6399')).decision,
      'deny',
    );
    assert.equal(decideNativeEffect(candidate('delete', 'broad_root', '/')).decision, 'deny');
    assert.equal(decideNativeEffect(candidate('repository_rewrite', 'protected_branch', 'main')).decision, 'deny');
    assert.equal(decideNativeEffect(candidate('unknown', 'runtime_sanctuary')).decision, 'deny');

    assert.equal(decideNativeEffect(candidate('read', 'runtime_sanctuary')).decision, 'allow');
    assert.equal(
      decideNativeEffect(candidate('write', 'ordinary', '/outside/workspace/allowed.txt')).decision,
      'allow',
    );
    assert.equal(decideNativeEffect(candidate('delete', 'ordinary', '/tmp/disposable')).decision, 'allow');
    assert.equal(decideNativeEffect(candidate('unknown', 'ordinary', '/tmp/opaque')).decision, 'allow');
  });

  test('adapts Codex Bash and apply_patch at the actual provider boundary', async () => {
    const { decideNativeHookPayload } = await guardModule;
    const repoRoot = '/home/user/cat-cafe';
    const runtimeRoot = '/home/user/cat-cafe-runtime';

    const redis = decideNativeHookPayload({
      turn_id: 'turn-1',
      tool_name: 'Bash',
      cwd: '/tmp/work',
      tool_input: { command: 'redis-cli -p 6399 shutdown && node child-effect.mjs' },
    });
    assert.equal(redis.decision, 'deny');
    assert.equal(redis.reasonCode, 'redis_sanctuary_mutation');

    const patch = decideNativeHookPayload({
      turn_id: 'turn-2',
      tool_name: 'apply_patch',
      cwd: '/tmp/work',
      tool_input: {
        command: `*** Begin Patch\n*** Update File: ${runtimeRoot}/README.md\n@@\n-old\n+new\n*** End Patch`,
      },
    });
    assert.equal(patch.decision, 'deny');
    assert.equal(patch.target.kind, 'runtime_sanctuary');

    const ordinaryPatch = decideNativeHookPayload({
      turn_id: 'turn-patch-ordinary',
      tool_name: 'apply_patch',
      cwd: '/home/user/cat-cafe',
      tool_input: {
        command:
          '*** Begin Patch\n*** Update File: packages/shared/src/provider-semantic-projection.ts\n@@\n-old\n+new\n*** End Patch',
      },
    });
    assert.equal(ordinaryPatch.decision, 'allow');
    assert.equal(ordinaryPatch.target.kind, 'ordinary');
    assert.equal(ordinaryPatch.target.value, 'packages/shared/src/provider-semantic-projection.ts');

    const absoluteOrdinaryPatchFromRuntimeCwd = decideNativeHookPayload({
      turn_id: 'turn-patch-absolute-ordinary-runtime-cwd',
      tool_name: 'apply_patch',
      cwd: runtimeRoot,
      tool_input: {
        command: `*** Begin Patch\n*** Update File: ${repoRoot}/docs/features/F309-collaborative-content-plane.md\n@@\n-old\n+new\n*** End Patch`,
      },
    });
    assert.equal(absoluteOrdinaryPatchFromRuntimeCwd.decision, 'allow');
    assert.equal(absoluteOrdinaryPatchFromRuntimeCwd.target.kind, 'ordinary');
    assert.equal(
      absoluteOrdinaryPatchFromRuntimeCwd.target.value,
      `${repoRoot}/docs/features/F309-collaborative-content-plane.md`,
    );

    const freeformAbsoluteOrdinaryPatchFromRuntimeCwd = decideNativeHookPayload({
      turn_id: 'turn-patch-freeform-absolute-ordinary-runtime-cwd',
      tool_name: 'apply_patch',
      cwd: runtimeRoot,
      tool_input: `*** Begin Patch\n*** Update File: ${repoRoot}/docs/features/F310-growing-real-delegation.md\n@@\n-old\n+new\n*** End Patch`,
    });
    assert.equal(freeformAbsoluteOrdinaryPatchFromRuntimeCwd.decision, 'allow');
    assert.equal(freeformAbsoluteOrdinaryPatchFromRuntimeCwd.target.kind, 'ordinary');
    assert.equal(
      freeformAbsoluteOrdinaryPatchFromRuntimeCwd.target.value,
      `${repoRoot}/docs/features/F310-growing-real-delegation.md`,
    );

    const freeformRuntimePatch = decideNativeHookPayload({
      turn_id: 'turn-patch-freeform-runtime-target',
      tool_name: 'apply_patch',
      cwd: repoRoot,
      tool_input: `*** Begin Patch\n*** Update File: ${runtimeRoot}/README.md\n@@\n-old\n+new\n*** End Patch`,
    });
    assert.equal(freeformRuntimePatch.decision, 'deny');
    assert.equal(freeformRuntimePatch.target.kind, 'runtime_sanctuary');

    for (const command of [
      '*** Begin Patch\n*** Update File: docs/a.md\n@@\n-old\n+new\n*** End Patch',
      '*** Begin Patch\n*** Add File: packages/api/src/new.ts\n+export {};\n*** End Patch',
      '*** Begin Patch\n*** Delete File: packages/api/src/index.ts\n*** End Patch',
      '*** Begin Patch\n*** Update File: docs/a.md\n*** Move to: packages/api/src/moved.ts\n@@\n-old\n+new\n*** End Patch',
      `*** Begin Patch\n*** Update File: ${repoRoot}/docs/absolute.md\n@@\n-old\n+new\n*** Update File: docs/relative.md\n@@\n-old\n+new\n*** End Patch`,
    ]) {
      const relativePatchFromRuntimeCwd = decideNativeHookPayload({
        turn_id: 'turn-patch-relative-runtime-cwd',
        tool_name: 'apply_patch',
        cwd: runtimeRoot,
        tool_input: { command },
      });
      assert.equal(relativePatchFromRuntimeCwd.decision, 'deny', command);
      assert.equal(relativePatchFromRuntimeCwd.target.kind, 'runtime_sanctuary', command);
    }

    const unresolvedPatchFromRuntimeCwd = decideNativeHookPayload({
      turn_id: 'turn-patch-unresolved-runtime-cwd',
      tool_name: 'apply_patch',
      cwd: runtimeRoot,
      tool_input: { command: '*** Begin Patch\n@@\n-old\n+new\n*** End Patch' },
    });
    assert.equal(unresolvedPatchFromRuntimeCwd.decision, 'deny');
    assert.equal(unresolvedPatchFromRuntimeCwd.target.kind, 'runtime_sanctuary');

    const moveIntoRuntime = decideNativeHookPayload({
      turn_id: 'turn-patch-move-runtime',
      tool_name: 'apply_patch',
      cwd: '/home/user/cat-cafe',
      tool_input: {
        command: `*** Begin Patch\n*** Update File: packages/shared/src/example.ts\n*** Move to: ${runtimeRoot}/example.ts\n@@\n-old\n+new\n*** End Patch`,
      },
    });
    assert.equal(moveIntoRuntime.decision, 'deny');
    assert.equal(moveIntoRuntime.target.kind, 'runtime_sanctuary');

    assert.equal(
      decideNativeHookPayload({
        turn_id: 'turn-3',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command: 'printf ok > /tmp/f306-ordinary-sentinel' },
      }).decision,
      'allow',
    );
    assert.equal(
      decideNativeHookPayload({
        turn_id: 'turn-4',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command: 'printf ok > /outside/workspace/authorized.txt' },
      }).decision,
      'allow',
    );
    assert.equal(
      decideNativeHookPayload({
        turn_id: 'turn-read-redis',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command: 'redis-cli -p 6399 ping' },
      }).decision,
      'allow',
    );
    assert.equal(
      decideNativeHookPayload({
        turn_id: 'turn-read-runtime',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command: `cd ${runtimeRoot} && git status` },
      }).decision,
      'allow',
    );

    for (const { command, effect, target } of [
      {
        command: 'find /home/user/projects/relay-station -delete',
        effect: 'delete',
        target: 'broad_root',
      },
      {
        command: 'find /home/user/projects/relay-station -exec rm -rf {} +',
        effect: 'delete',
        target: 'broad_root',
      },
      { command: 'find . -delete', effect: 'delete', target: 'broad_root' },
      { command: 'rm -rf /*', effect: 'delete', target: 'broad_root' },
      { command: 'rm -rf ~/', effect: 'delete', target: 'broad_root' },
      { command: 'rm -rf $HOME/', effect: 'delete', target: 'broad_root' },
      { command: 'rm -rf /.', effect: 'delete', target: 'broad_root' },
      { command: 'rm -rf //', effect: 'delete', target: 'broad_root' },
      {
        command: 'rm -rf /home/user/cat-cafe-runtime/*',
        effect: 'delete',
        target: 'runtime_sanctuary',
      },
      {
        command: 'rm -rf /home/user/cat-cafe-runtime*',
        effect: 'delete',
        target: 'runtime_sanctuary',
      },
      {
        command: 'rm -rf /home/user/cat-cafe-runtim?',
        effect: 'delete',
        target: 'runtime_sanctuary',
      },
      {
        command: 'rm -rf /home/user/cat-cafe-runtim[e]',
        effect: 'delete',
        target: 'runtime_sanctuary',
      },
      {
        command: 'rm -rf /home/user/cat-cafe-runtim{e,x}',
        effect: 'delete',
        target: 'runtime_sanctuary',
      },
      {
        command: 'mv /home/user/cat-cafe-runtime* /tmp/x',
        effect: 'write',
        target: 'runtime_sanctuary',
      },
      { command: 'git branch -D runtime/main-sync*', effect: 'repository_rewrite', target: 'protected_branch' },
      { command: 'git switch runtime/main-sync*', effect: 'repository_rewrite', target: 'protected_branch' },
      { command: 'git switch runtime/main-syn[c]', effect: 'repository_rewrite', target: 'protected_branch' },
      { command: 'git push origin :runtime/main-sync', effect: 'repository_rewrite', target: 'protected_branch' },
      {
        command: 'git update-ref -d refs/heads/runtime/main-sync',
        effect: 'repository_rewrite',
        target: 'protected_branch',
      },
      { command: 'git branch -m runtime/main-sync archived', effect: 'repository_rewrite', target: 'protected_branch' },
      { command: 'git push origin :main', effect: 'repository_rewrite', target: 'protected_branch' },
      { command: 'git push origin --delete master', effect: 'repository_rewrite', target: 'protected_branch' },
      { command: 'git push -d origin main', effect: 'repository_rewrite', target: 'protected_branch' },
      { command: 'git push origin +main:main', effect: 'repository_rewrite', target: 'protected_branch' },
      {
        command: 'git update-ref -d refs/heads/main',
        effect: 'repository_rewrite',
        target: 'protected_branch',
      },
      { command: 'git branch -D master', effect: 'repository_rewrite', target: 'protected_branch' },
      { command: 'git branch -M main archived', effect: 'repository_rewrite', target: 'protected_branch' },
      { command: 'git branch -m archived master', effect: 'repository_rewrite', target: 'protected_branch' },
    ]) {
      const destructiveFind = decideNativeHookPayload({
        turn_id: 'turn-destructive-find',
        tool_name: 'Bash',
        cwd: '/home/user/projects/relay-station',
        tool_input: { command },
      });
      assert.equal(destructiveFind.effect, effect, command);
      assert.equal(destructiveFind.target.kind, target, command);
      assert.equal(destructiveFind.decision, 'deny', command);
    }

    const ordinarySibling = decideNativeHookPayload({
      turn_id: 'turn-runtime-sibling',
      tool_name: 'Bash',
      cwd: '/tmp/work',
      tool_input: {
        command: 'rm -rf /home/user/cat-cafe-runtime-cwd-debug*',
      },
    });
    assert.equal(ordinarySibling.target.kind, 'ordinary');
    assert.equal(ordinarySibling.decision, 'allow');

    for (const { command, effect } of [
      { command: 'git push origin feat/f306-phase-c', effect: 'write' },
      { command: 'git push origin --delete feat/retired', effect: 'repository_rewrite' },
      { command: 'git update-ref -d refs/heads/feat/retired', effect: 'repository_rewrite' },
      { command: 'git branch -M feat/old feat/new', effect: 'repository_rewrite' },
    ]) {
      const ordinaryBranch = decideNativeHookPayload({
        turn_id: 'turn-ordinary-branch',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command },
      });
      assert.equal(ordinaryBranch.effect, effect, command);
      assert.equal(ordinaryBranch.target.kind, 'ordinary', command);
      assert.equal(ordinaryBranch.decision, 'allow', command);
    }
  });

  test('classifies every pipeline segment before read-only policy can short-circuit', async () => {
    const { decideNativeHookPayload } = await guardModule;

    for (const command of ['echo FLUSHALL | redis-cli -p 6399', 'echo FLUSHALL | nc localhost 6399']) {
      const pipedMutation = decideNativeHookPayload({
        turn_id: 'turn-piped-redis-mutation',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command },
      });
      assert.equal(pipedMutation.target.kind, 'redis_sanctuary', command);
      assert.equal(pipedMutation.decision, 'deny', command);
    }

    for (const command of [
      'redis-cli -p 6399 ping | head -n 1',
      'cat /home/user/cat-cafe-runtime/README.md | head -n 1',
    ]) {
      const pipedRead = decideNativeHookPayload({
        turn_id: 'turn-piped-read',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command },
      });
      assert.equal(pipedRead.effect, 'read', command);
      assert.equal(pipedRead.decision, 'allow', command);
    }
  });

  test('classifies every top-level line before read-only policy can short-circuit', async () => {
    const { decideNativeHookPayload } = await guardModule;
    const runtimeRoot = '/home/user/cat-cafe-runtime';

    for (const { command, effect, target } of [
      { command: 'echo "wipe"\nrm -rf /*', effect: 'delete', target: 'broad_root' },
      { command: 'ls /tmp\r\nrm -rf ~/', effect: 'delete', target: 'broad_root' },
      { command: `git status\nrm -rf ${runtimeRoot}`, effect: 'delete', target: 'runtime_sanctuary' },
    ]) {
      const multilineMutation = decideNativeHookPayload({
        turn_id: 'turn-multiline-mutation',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command },
      });
      assert.equal(multilineMutation.effect, effect, command);
      assert.equal(multilineMutation.target.kind, target, command);
      assert.equal(multilineMutation.decision, 'deny', command);
    }

    for (const command of ["printf 'not a command:\nrm -rf /'", 'echo continued \\\nrm -rf /*']) {
      const inertNewline = decideNativeHookPayload({
        turn_id: 'turn-inert-newline',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command },
      });
      assert.equal(inertNewline.effect, 'read', command);
      assert.equal(inertNewline.decision, 'allow', command);
    }
  });

  test('attributes protected targets to the pipeline stage that actually names them', async () => {
    const { decideNativeHookPayload } = await guardModule;
    const relayRoot = '/home/user/projects/relay-station';
    const runtimeRoot = `${relayRoot}/cat-cafe-runtime`;

    for (const command of [
      `tail -500 ${runtimeRoot}/logs/api.log | grep ERROR | sort | uniq -c`,
      `ls ${runtimeRoot} | wc -l`,
      `cat ${runtimeRoot}/package.json | jq .version`,
      'git log runtime/main-sync --oneline | wc -l',
      `ls ${relayRoot}/cat-cafe | wc -l`,
    ]) {
      const diagnosticRead = decideNativeHookPayload({
        turn_id: 'turn-protected-diagnostic-read',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command },
      });
      assert.equal(diagnosticRead.effect, 'read', command);
      assert.equal(diagnosticRead.decision, 'allow', command);
    }

    const runtimeCwdDiagnostic = decideNativeHookPayload({
      turn_id: 'turn-runtime-cwd-diagnostic-read',
      tool_name: 'Bash',
      cwd: runtimeRoot,
      tool_input: { command: 'tail -500 logs/api.log | sort | uniq -c' },
    });
    assert.equal(runtimeCwdDiagnostic.effect, 'read');
    assert.equal(runtimeCwdDiagnostic.target.kind, 'runtime_sanctuary');
    assert.equal(runtimeCwdDiagnostic.decision, 'allow');

    const dataDrivenDelete = decideNativeHookPayload({
      turn_id: 'turn-data-driven-delete',
      tool_name: 'Bash',
      cwd: '/tmp/work',
      tool_input: { command: `printf '%s\\n' '${runtimeRoot}' | xargs rm -rf` },
    });
    assert.equal(dataDrivenDelete.decision, 'deny');
    assert.equal(dataDrivenDelete.target.kind, 'runtime_sanctuary');

    const opaqueProtectedCommand = decideNativeHookPayload({
      turn_id: 'turn-opaque-protected-command',
      tool_name: 'Bash',
      cwd: '/tmp/work',
      tool_input: { command: `node inspect.mjs ${runtimeRoot}` },
    });
    assert.equal(opaqueProtectedCommand.effect, 'unknown');
    assert.equal(opaqueProtectedCommand.target.kind, 'runtime_sanctuary');
    assert.equal(opaqueProtectedCommand.decision, 'deny');
  });

  test('shares the same classifier with Claude Edit/Write payloads', async () => {
    const { decideNativeHookPayload } = await guardModule;
    const runtimeFile = '/home/user/cat-cafe-runtime/packages/api/src/index.ts';

    const blocked = decideNativeHookPayload({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      cwd: '/tmp/work',
      tool_input: { file_path: runtimeFile },
    });
    assert.equal(blocked.decision, 'deny');
    assert.equal(blocked.source.provider, 'claude');

    const allowed = decideNativeHookPayload({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      cwd: '/tmp/work',
      tool_input: { file_path: '/tmp/other-project/file.ts' },
    });
    assert.equal(allowed.decision, 'allow');
  });

  test('hook CLI emits a synchronous Codex/Claude-compatible deny and stays silent on allow', () => {
    const denied = spawnSync(process.execPath, [hookPath], {
      encoding: 'utf8',
      input: JSON.stringify({
        turn_id: 'turn-denied',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command: 'rm -rf /' },
      }),
    });
    assert.equal(denied.status, 0);
    const output = JSON.parse(denied.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /broad_root_delete/);

    const allowed = spawnSync(process.execPath, [hookPath], {
      encoding: 'utf8',
      input: JSON.stringify({
        turn_id: 'turn-allowed',
        tool_name: 'Bash',
        cwd: '/tmp/work',
        tool_input: { command: 'printf ok > /tmp/f306-ordinary-sentinel' },
      }),
    });
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stdout, '');
  });
});
