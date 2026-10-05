import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync as removeFixture } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const { decideNativeHookPayload } = await import('../../../scripts/native-effect-target-guard.mjs');
const { hereDocumentView } = await import('../../../scripts/native-effect-heredoc.mjs');

// 2026-09-27 (thread_muj3x2kabkbmx42l, slice 2): after #4817, the remaining real denials
// were dominated by parsing faults, not by dangerous commands:
// - a here-document body was split into "command lines", so a Python or JS body with `>`
//   and `*` became `write` to a glob that "can select" the runtime;
// - `>` inside quotes (`stat -f '%N -> %Y'`, `rg 'a > b'`) counted as a redirection.
// (A quoted `'*'` still counts as a glob: git expands pathspecs and refspecs itself.)
// A body is data when its command does not execute its input. Code (a shell, Python,
// Node) stays judged: shell bodies line by line as before, other languages as unknown
// code that may not name the runtime or Redis 6399.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'f306-heredoc-')));
after(() => removeFixture(fixtureRoot, { recursive: true, force: true }));
const stationRoot = join(fixtureRoot, 'projects', 'relay-station');
const mainRoot = join(stationRoot, 'cat-cafe');
const worktreeRoot = join(stationRoot, 'cat-cafe-feature-x');
const runtimeRoot = join(stationRoot, 'cat-cafe-runtime');
for (const directory of [mainRoot, worktreeRoot, runtimeRoot]) mkdirSync(directory, { recursive: true });

const NO_SELF_HOST = { selfHost: () => ({ confidence: 'none' }) };
function decideBoth(command, cwd = worktreeRoot) {
  const claude = decideNativeHookPayload(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } },
    NO_SELF_HOST,
  );
  const codex = decideNativeHookPayload(
    { turn_id: 'turn-heredoc', tool_name: 'exec_command', cwd, tool_input: { cmd: command } },
    NO_SELF_HOST,
  );
  assert.equal(claude.decision, codex.decision, `providers disagree on: ${command}`);
  return claude;
}
function assertAllowed(command, cwd) {
  const decision = decideBoth(command, cwd);
  assert.equal(
    decision.decision,
    'allow',
    `expected allow: ${command}\n→ ${decision.reasonCode} (${decision.effect} → ${decision.target.kind})`,
  );
}
function assertDenied(command, cwd) {
  const decision = decideBoth(command, cwd);
  assert.equal(
    decision.decision,
    'deny',
    `expected deny: ${command}\n→ ${decision.reasonCode} (${decision.effect} → ${decision.target.kind})`,
  );
  return decision;
}

describe('F306 slice 2: a here-document body is the standard input of its command', () => {
  test('a body handed to a command that does not execute it is data, not a target', () => {
    // Live samples: a note or a helper script written to /tmp that mentions the runtime.
    assertAllowed(`cat > /tmp/note.md <<'EOF'\nsee ${runtimeRoot}/packages/api/data/logs\nEOF`);
    assertAllowed(`cat <<'EOF' > /tmp/helper.mjs\nconst rt = '${runtimeRoot}';\nconsole.log(rt);\nEOF`);
    assertAllowed(`tee /tmp/note.md <<EOF\nruntime lives at ${runtimeRoot}\nEOF`);
    // Commit messages and PR bodies are messages.
    assertAllowed(
      `git -c core.hooksPath=.husky commit -q -F - <<'EOF'\nfix: stop reading ${runtimeRoot} directly\nEOF`,
    );
    assertAllowed(`gh pr comment 12 --body-file - <<'EOF'\nverified against ${runtimeRoot}\nEOF`);
    // Code-shaped data: `>` and `*` in a body are not redirections or globs.
    assertAllowed(`cat > /tmp/x.mjs <<'EOF'\nconst xs = items.map((x) => x * 2);\nif (a > b) console.log('*');\nEOF`);
    // `<<-` strips leading tabs from the terminator.
    assertAllowed(`cat > /tmp/note.md <<-EOF\n\tsee ${runtimeRoot}\n\tEOF`);
  });

  test("a Python or Node body is code, and a path inside it is not the command's target", () => {
    // Live samples (write → runtime_sanctuary with no runtime path at all): Python edit
    // scripts whose `>` and `*` were read as shell.
    assertAllowed(
      `python3 - <<'PY'\np='src/x.ts'\ns=open(p).read()\nif len(s) > 3: print('*')\nopen(p,'w').write(s)\nPY`,
    );
    assertAllowed(
      `node --input-type=module - <<'JS'\nconst n = [1,2].map((x) => x * 2);\nif (n.length > 1) console.log(n);\nJS`,
    );
    // Live sample (thread_mujqvbmfx5nu4rex): read-only log analysis run from the main checkout.
    // argv is `python3 -`, no redirection; the runtime path is only inside the source. The
    // guard does not read Python, so the effect is unknown, and unknown on an ordinary target
    // is ordinary work (codex-astra review, 2026-09-27). Synthetic log path.
    assertAllowed(
      `python3 - <<'PY'\nimport json\np='${runtimeRoot}/packages/api/data/logs/api/api.fixture.log'\nfor line in open(p):\n    print(json.loads(line).get('msg'))\nPY\nsed -n '1,5p' package.json`,
      mainRoot,
    );
    // What the command itself names still counts: its cwd, its redirection, a preceding cd.
    assertDenied(`python3 - <<'PY'\nprint(1)\nPY`, runtimeRoot);
    assertDenied(`python3 - > ${runtimeRoot}/out.txt <<'PY'\nprint(1)\nPY`);
    assertDenied(`cd ${runtimeRoot} && python3 - <<'PY'\nprint(1)\nPY`);
  });

  test('a body that runs as shell, or feeds operands, is still judged', () => {
    assertDenied(`bash <<'EOF'\nrm -rf ${runtimeRoot}\nEOF`);
    assertDenied(`sudo bash <<'EOF'\nrm -rf /\nEOF`);
    assertDenied(`sh -s <<EOF\ncd ${runtimeRoot} && git reset --hard\nEOF`);
    // The body becomes operands: command substitution, a pipe, a read loop.
    assertDenied(`rm -rf $(cat <<'EOF'\n${runtimeRoot}\nEOF\n)`);
    assertDenied(`cat <<'EOF' | xargs rm -rf\n${runtimeRoot}\nEOF`);
    assertDenied(`cat <<'EOF' | while read f; do rm -rf "$f"; done\n${runtimeRoot}\nEOF`);
    assertDenied(`while read f; do rm -rf "$f"; done <<'EOF'\n${runtimeRoot}\nEOF`);
    // An unquoted delimiter expands substitutions in the body: they run.
    assertDenied(`cat > /tmp/x <<EOF\n$(rm -rf ${runtimeRoot})\nEOF`);
    // A script read from standard input by an option is not data.
    assertDenied(`sed -n -f - /tmp/in <<'EOF'\nw ${runtimeRoot}/x\nEOF`);
  });

  // codex-astra review of #4840 at 7121abb924: `-f-` and `-f/dev/stdin` also make stdin the
  // script, and the body was dropped as data. An option names standard input the same way
  // whether its value is attached, separate, or after `=`.
  test('a script on standard input is not data, however the option is spelled', () => {
    for (const option of [
      '-f -',
      '-f-',
      '-nf-',
      '-f/dev/stdin',
      '-f /dev/stdin',
      '--file=-',
      '--file=/dev/stdin',
      '-f/dev/fd/0',
    ]) {
      assertDenied(`sed -n ${option} /tmp/in <<'SCRIPT'\nw ${runtimeRoot}/x\nSCRIPT`);
      // The reviewer's check, independent of target policy: the program stays visible.
      const view = hereDocumentView(`sed -n ${option} /dev/null <<'SCRIPT'\nw /tmp/SENTINEL\nSCRIPT`);
      assert.ok(view.judged.includes('w /tmp/SENTINEL') && view.host.includes('w /tmp/SENTINEL'), option);
    }
    // Any reader, not only sed: the body stays in the judged and host texts.
    for (const command of [`grep -f- /tmp/in <<'P'`, `jq --from-file=/dev/stdin /tmp/in.json <<'P'`]) {
      const view = hereDocumentView(`${command}\n${runtimeRoot}\nP`);
      assert.ok(view.judged.includes(runtimeRoot) && view.host.includes(runtimeRoot), command);
    }
  });

  test('sed can run its input, so what it reads is never plain data', () => {
    // GNU sed's `e` command and `s///e` flag execute the pattern space: the input lines.
    assertDenied(`sed e <<'EOF'\nrm -rf ${runtimeRoot}\nEOF`);
    assertDenied(`sed 's/.*/&/e' <<'EOF'\nrm -rf ${runtimeRoot}\nEOF`);
    assertDenied(`gsed -n e <<'EOF'\nrm -rf /\nEOF`);
  });

  test('a message option reads standard input however it is spelled', () => {
    assertAllowed(`git commit -q -F- <<'EOF'\nfix: stop reading ${runtimeRoot} directly\nEOF`);
    assertAllowed(`gh pr comment 12 -F- <<'EOF'\nverified against ${runtimeRoot}\nEOF`);
  });

  test('the body ends at its terminator: the next line is a command again', () => {
    assertDenied(`cat > /tmp/x <<'EOF'\nEOF2\nEOF\nrm -rf ${runtimeRoot}`);
    assertDenied(`cat > /tmp/x <<-'EOF'\n\tdata\n\tEOF\nrm -rf ${runtimeRoot}`);
    assertDenied(`cat > /tmp/a <<'A'; cat > /tmp/b <<'B'\none\nA\ntwo\nB\nrm -rf ${runtimeRoot}`);
    // An apostrophe in a body does not open a quote that swallows the rest.
    assertDenied(`cat > /tmp/x <<'EOF'\ndon't\nEOF\nrm -rf /`);
    // Writing the heredoc into the runtime is still a write into the runtime.
    assertDenied(`cat > ${runtimeRoot}/x.txt <<'EOF'\nhello\nEOF`);
  });

  test('what only looks like a here-document is not one', () => {
    // A comment, an arithmetic shift, or `<<` inside a quote hides nothing.
    assertDenied(`ls # see <<EOF\nrm -rf ${runtimeRoot}\nEOF`);
    assertDenied(`echo $((1<<2))\nrm -rf ${runtimeRoot}\n2`);
    assertDenied(`echo "a <<EOF"\nrm -rf ${runtimeRoot}\nEOF`);
    // A here-document without its terminator is left to the line parser.
    assertDenied(`cat > /tmp/x <<'EOF'\nrm -rf ${runtimeRoot}`);
  });
});

describe('F306 slice 2: a message passed as "$(cat <<\'EOF\' … EOF)"', () => {
  // 44 of 494 real denials were self_host_unresolved, most of them this idiom: the message
  // mentioned "stop" or "restart", and the substitution made the command "unreadable".
  const SELF_ROOT = join(stationRoot, 'cat-cafe-self');
  const exactFacet = () => ({
    confidence: 'exact',
    facet: {
      v: 1,
      installation: { projectRoot: SELF_ROOT, deploymentId: 'runtime', observedAt: 1, sourceRef: 'self' },
      runtime: { worktree: SELF_ROOT, head: '', apiPid: 2622, apiPort: 18080, observedAt: 1, sourceRef: 'self' },
      platform: { os: 'darwin', arch: 'arm64', hostNodeId: 'x', observedAt: 1, sourceRef: 'platform' },
      coordinates: { catId: 'opus55' },
      hostDependencies: [{ kind: 'api', pid: 2622, port: 18080, identityRef: 'self' }],
      heldLeases: [],
      quota: 'unknown',
    },
  });
  const decideHosted = (command) =>
    decideNativeHookPayload(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: worktreeRoot, tool_input: { command } },
      { selfHost: exactFacet, observeHost: () => ({ isHostDescendant: () => undefined }) },
    );

  test('the message is a literal word: it stops nothing', () => {
    for (const command of [
      `git commit -m "$(cat <<'EOF'\nfix: stop the restart loop from killing hosts\n\nWhy: kill -9 was too eager\nEOF\n)"`,
      `gh pr comment 12 --body "$(cat <<'EOF'\n## Why\nrestart and stop no longer race\nEOF\n)"`,
      // A data body that talks about stopping is not a stop either.
      `cat > /tmp/note.md <<'EOF'\nrun pnpm runtime:stop, then kill -9 the old api\nEOF`,
      // Markdown code spans are literal inside single quotes, and a message may say "case".
      "git commit -m 'fix: stop the `restart` loop'",
      `gh pr comment 12 --body "$(cat <<'EOF'\none test case covers \`restart\` and it's green\nEOF\n)"`,
    ]) {
      const decision = decideHosted(command);
      assert.equal(decision.decision, 'allow', `${command}\n→ ${decision.reasonCode}: ${decision.detail ?? ''}`);
    }
  });

  test('the literal is still an operand, and code still runs', () => {
    assertDenied(`rm -rf "$(cat <<'EOF'\n${runtimeRoot}\nEOF\n)"`);
    assert.equal(decideHosted(`pkill -f "$(cat <<'EOF'\nnode\nEOF\n)"`).decision, 'deny');
    assert.equal(decideHosted(`cat <<'EOF' | sh\npkill node\nEOF`).decision, 'deny');
    assert.equal(decideHosted(`bash <<'EOF'\npkill node\nEOF`).decision, 'deny');
    // An unquoted delimiter expands the body, so it is not a literal.
    assertDenied(`rm -rf "$(cat <<EOF\n$HOME/../${runtimeRoot}\nEOF\n)"`);
    // Under bash 3.2 a stray `)` ends the substitution early and the rest of the body runs.
    assert.equal(decideHosted(`git commit -m "$(cat <<'EOF'\n)\n\`pkill node\`\nEOF\n)"`).decision, 'deny');
    // Inside double quotes a backtick is a real substitution.
    assert.equal(decideHosted('git commit -m "fix: `pkill node`"').decision, 'deny');
    // A real `case` makes grouping unknown: the body is judged line by line again.
    assertDenied(`x=$(case 1 in 1) cat <<'EOF'\n${runtimeRoot}\nEOF\n;; esac)\nrm -rf "$x"`);
  });
});

describe('F306 slice 2: quoted text is not shell syntax', () => {
  test('`>` inside quotes is not a redirection', () => {
    assertAllowed(`stat -f '%N -> %Y %z' ${runtimeRoot}/.cat-cafe`);
    assertAllowed(`rg -n 'a > b' ${runtimeRoot}/packages/api/data/logs/api/api.log`);
    assertAllowed(`grep -E "x=>y" ${runtimeRoot}/cat-cafe-daemon.log`);
    // A real redirection into the runtime is still a write into it.
    assertDenied(`echo hi > ${runtimeRoot}/x.txt`);
    assertDenied(`echo "a > b" > ${runtimeRoot}/x.txt`);
  });
});
