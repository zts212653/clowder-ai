import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gateBackgroundDecision } from '../../../scripts/gate-background-decision.mjs';
import { createHostProcessObserver } from '../../../scripts/lib/self-host-facet.mjs';
import { hereDocumentView } from '../../../scripts/native-effect-heredoc.mjs';
import { decideShellHookPayload } from '../../../scripts/native-effect-shell-decision.mjs';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { nativeHookTestEnv } from './helpers/native-hook-programs.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const main = join(homedir(), 'projects/relay-station/cat-cafe');
const runtime = `${main}-runtime`;
const noHost = { selfHost: () => ({ confidence: 'none' }) };

function parity(command, expected, cwd = main, options = noHost) {
  let result;
  for (const tool_name of ['Bash', 'exec_command']) {
    result = decideNativeHookPayload(
      {
        tool_name,
        cwd,
        tool_input: { command, cmd: command },
        ...(tool_name === 'exec_command' ? { turn_id: 'slimming' } : {}),
      },
      options,
    );
    assert.equal(result.decision, expected, `${tool_name}: ${command} -> ${result.reasonCode}`);
  }
  return result;
}

function claude(command, cwd = main) {
  const env = nativeHookTestEnv();
  delete env.CAT_CAFE_DEPLOYMENT_ID;
  const result = spawnSync('bash', [join(root, '.claude/hooks/runtime-sanctuary-guard.sh')], {
    input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }),
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
}

test('shared protection recognises a destructive home-relative relay child wildcard', () => {
  for (const program of ['rm -rf', 'trash']) {
    const result = parity(`${program} ~/projects/relay-station/cat-cafe-*`, 'deny');
    assert.equal(result.target.value, runtime);
  }
  parity('rm -rf /tmp/cat-cafe-*', 'allow');
});

test('healthy Claude shared allow is final for shell heredoc data mentioning a kill pipeline', () => {
  const command = "cat > /tmp/f306-report.mjs <<'EOF'\nconst note = 'lsof -ti :3001 | xargs kill';\nEOF";
  parity(command, 'allow');
  assert.equal(claude(command), 'allow');
  assert.equal(claude(`rm -rf ${runtime}`), 'deny');
});

test('healthy admission replaces regex nudges with ordinary positives and real-target negatives', () => {
  for (const command of [
    'echo a && echo b && trash "$F306_UNSET_SCRATCH"',
    'echo a || echo b || trash $F306_UNSET_SCRATCH',
    'lsof -ti tcp:65093 | xargs kill',
    'git branch -D runtime/ordinary-feature',
  ]) {
    parity(command, 'allow');
    assert.equal(claude(command), 'allow', command);
  }
  for (const command of [
    `D=${runtime}; echo a && echo b && trash "$D"`,
    'lsof -ti tcp:6399 | xargs kill',
    'git branch -D runtime/main-sync',
  ]) {
    parity(command, 'deny');
    assert.equal(claude(command), 'deny', command);
  }
});

test('A: an unknown runtime or Redis effect defers without claiming a proved read', () => {
  for (const command of [
    `cmp ${runtime}/package.json ${main}/package.json`,
    'redis-cli -p 6399 SCARD cat-cafe:threads',
  ]) {
    const result = parity(command, 'allow');
    assert.equal(result.effect, 'unknown');
    assert.equal(claude(command), 'allow', command);
  }
  for (const command of [
    `sed -i '' 's/old/new/' ${runtime}/.env`,
    'redis-cli -p 6399 FLUSHALL',
    'git reset --hard HEAD~1',
  ]) {
    parity(command, 'deny');
    assert.equal(claude(command), 'deny', command);
  }
});

const host = {
  installation: { projectRoot: main, deploymentId: 'slimming-fixture' },
  runtime: { worktree: runtime, apiPid: 4242, apiPort: 18080 },
  hostDependencies: [{ kind: 'redis', port: 6399, identityRef: 'redis://127.0.0.1:6399' }],
};

function hostOptions(facet = host) {
  return {
    selfHost: () => (facet ? { confidence: 'exact', facet } : { confidence: 'none' }),
    observeHost: (self) =>
      createHostProcessObserver(self, {
        observerPid: 4242,
        run(program, args, options) {
          assert.ok(options.timeout <= 1000);
          if (program === 'pgrep') {
            const pattern = args.at(-1);
            if (pattern === 'node') return '4242\n';
            if (pattern === 'redis-server') return '63990\n';
            return '9000\n';
          }
          if (program === 'lsof') return args.includes('-iTCP:18080') ? '4242\n63990\n' : '63990\n';
          assert.equal(program, 'ps');
          if (args.includes('pid=,ucomm=')) return '4242 node\n63990 redis-server\n9000 vitest\n';
          return '1 0\n3000 1\n4242 3000\n63990 1\n9000 1\n';
        },
      }),
  };
}

test('incomplete source mentioning stop words is not an executed stop', () => {
  for (const command of [
    "node - <<'JS'\nconst note = ['kill', 'restart'];\nconsole.log(note.join(','));\nJS",
    "printf 'this report mentions kill and restart",
  ])
    parity(command, 'allow', main, hostOptions());
  assert.equal(parity('kill 4242', 'deny', main, hostOptions()).reasonCode, 'self_host_stop');
});

test('pattern kills use observed matches, including host ancestors and global Redis', () => {
  for (const options of [hostOptions(), hostOptions(null)]) {
    parity('pkill -f "vitest run"', 'allow', main, options);
    parity('killall vitest', 'allow', main, options);
    assert.equal(parity('pkill -f node', 'deny', main, options).reasonCode, 'self_host_stop');
    assert.equal(parity('killall redis-server', 'deny', main, options).reasonCode, 'self_host_stop');
  }
  parity('kill 3000', 'deny', main, hostOptions());
});

test('gate words in incomplete data are not a full gate, while an executed gate remains blocked', () => {
  const gate = (command) => gateBackgroundDecision({ tool_name: 'Bash', tool_input: { command } });
  assert.equal(gate("printf 'the report mentions gate"), false);
  assert.equal(gate('pnpm gate && printf "$UNRESOLVED"'), true);
});

test('pattern observation failures remain unknown and signal options are not pattern data', () => {
  const queried = [];
  const observer = createHostProcessObserver(host, {
    run(program, args) {
      queried.push({ program, args });
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    },
  });
  assert.equal(observer.patternTargets('pkill', ['-f', 'node']).complete, false);
  observer.patternTargets('pkill', ['-TERM', '-f', 'node']);
  observer.patternTargets('killall', ['KILL']);
  assert.deepEqual(
    queried.map((q) => q.args),
    [['-f', 'node'], ['-f', 'node'], ['KILL']],
  );
  const options = { ...hostOptions(), observeHost: () => observer };
  assert.equal(parity('pkill -f node', 'deny', main, options).reasonCode, 'self_host_unresolved');
});

test('unrecognised ordinary preview operations defer while real protected coordinates remain blocked', () => {
  for (const command of [
    'pnpm preview:process --help',
    'pnpm preview:process status && tail -n 20 /tmp/preview.log',
    'env pnpm preview:process stop --port 5188 --cwd /tmp/feature --json',
    'pnpm preview:process start --port 5188 --cwd /tmp/feature -- node custom-preview.mjs',
  ]) {
    parity(command, 'allow');
    assert.equal(claude(command), 'allow', command);
  }
  for (const port of [3001, 3002, 6399]) {
    parity(`pnpm preview:process stop --port ${port} --cwd ${main} --json`, 'deny');
  }
  parity(`pnpm preview:process --help`, 'deny', runtime);
  parity(`pnpm preview:process stop --port 5188 --cwd ${runtime} --json`, 'deny');
  parity(`pnpm preview:process status && touch ${runtime}/blocked`, 'deny');
});

test('executable location and PATH configuration are not file mutation operands', () => {
  for (const command of [
    `${runtime}/bin/custom-program ordinary-input`,
    `PATH=${runtime}/bin:/usr/bin /usr/bin/touch /tmp/f306-slimming-output`,
  ]) {
    const result = parity(command, 'allow');
    assert.equal(result.target.kind, 'ordinary', command);
  }
  parity(`PATH=${runtime}/bin:/usr/bin /usr/bin/touch ${runtime}/blocked`, 'deny');
  // The independent secret layer currently rejects inherited environment expansion.
  // Exercise physical attribution alone without claiming that layer is repaired.
  const command = 'env PATH="$PATH" /usr/bin/touch /tmp/f306-slimming-output';
  assert.equal(
    decideShellHookPayload(hereDocumentView(command), main, { provider: 'claude', tool: 'shell' }).target.kind,
    'ordinary',
  );
});

test('role projection preserves recognised main reset with a literal commit operand', () => {
  parity(`git reset --hard ${'a'.repeat(40)}`, 'deny');
});

test('killall observes executable identity when a process title has an address suffix', () => {
  const observer = createHostProcessObserver(host, {
    run(program, args) {
      if (program === 'pgrep') {
        if (args.includes('-x'))
          throw Object.assign(new Error('no exact title'), { status: 1, stdout: '', stderr: '' });
        return '63990\n';
      }
      assert.equal(program, 'ps');
      return '63990 redis-server\n';
    },
  });
  assert.deepEqual(observer.patternTargets('killall', ['redis-server']), { pids: [63990], complete: true });
});

test('ordinary preview deferral retains a non-default actual host port', () => {
  const command = 'pnpm preview:process stop --port 18080 --cwd /tmp/feature --json';
  assert.equal(parity(command, 'deny', main, hostOptions()).reasonCode, 'self_host_stop');
  parity('pnpm preview:process stop --port 5188 --cwd /tmp/feature --json', 'allow', main, hostOptions());
});
