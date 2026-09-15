import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessSideEffect } from './self-host-guard.mjs';

/**
 * F300 Task 1.2 -- pure judgment: "would this command stop me?"
 *
 * Every input here is a fixture. Nothing in this file may send a signal, open a
 * port or talk to a real process: the whole point of C0/C5 is that we can prove
 * the refusal without performing the thing we are refusing.
 */

const SELF_WORKTREE = '/home/user/cat-cafe-f300';
const DAEMON_REF = 'daemon-state:/home/user/cat-cafe-f300#runtime';

function fixtureSelfFacet(overrides = {}) {
  const { apiPid = 4242, apiPort = 3002, deploymentId = 'runtime', hostDependencies, ...rest } = overrides;
  return {
    v: 1,
    installation: {
      projectRoot: SELF_WORKTREE,
      deploymentId,
      observedAt: 1,
      sourceRef: DAEMON_REF,
    },
    runtime: { worktree: SELF_WORKTREE, head: 'abc', apiPid, apiPort, observedAt: 1, sourceRef: DAEMON_REF },
    platform: { os: 'darwin', arch: 'arm64', hostNodeId: 'x', observedAt: 1, sourceRef: 'process:1#platform' },
    coordinates: { catId: 'opus-5' },
    hostDependencies: hostDependencies ?? [{ kind: 'api', pid: apiPid, port: apiPort, identityRef: DAEMON_REF }],
    heldLeases: [],
    quota: 'unknown',
    ...rest,
  };
}

const self = fixtureSelfFacet();
const verdictOf = (command, cwd = '/tmp', facet = self) => assessSideEffect(command, cwd, facet).verdict;

describe('assessSideEffect: C0 self-host', () => {
  it('refuses stopping the deployment that is hosting this cat', () => {
    assert.equal(verdictOf('pnpm runtime:stop', SELF_WORKTREE), 'self_host');
  });

  it('refuses stopping our own deployment even from an unrelated cwd', () => {
    assert.equal(verdictOf('pnpm runtime:stop', '/tmp'), 'self_host');
  });

  it('allows stopping a deployment that is not hosting this cat', () => {
    assert.equal(verdictOf('pnpm alpha:stop', '/tmp'), 'allow');
  });

  it('refuses signalling our own api pid', () => {
    assert.equal(verdictOf('kill -TERM 4242'), 'self_host');
  });

  it('allows signalling a pid that is not one of ours', () => {
    assert.equal(verdictOf('kill -TERM 9999'), 'allow');
  });

  it('refuses killing whatever is listening on our own port', () => {
    assert.equal(verdictOf('lsof -ti tcp:3002 | xargs kill'), 'self_host');
  });

  it('allows merely observing our own port', () => {
    assert.equal(verdictOf('lsof -ti tcp:3002'), 'allow');
  });

  it('allows a liveness probe against our own pid (kill -0 stops nothing)', () => {
    assert.equal(verdictOf('kill -0 4242'), 'allow');
  });

  it('refuses deleting the worktree we are running out of', () => {
    assert.equal(verdictOf(`rm -rf ${SELF_WORKTREE}/packages`), 'self_host');
  });

  it('refuses a dependency we host on besides the api', () => {
    const facet = fixtureSelfFacet({
      hostDependencies: [{ kind: 'redis', port: 6398, identityRef: 'redis://127.0.0.1:6398' }],
    });
    assert.equal(verdictOf('redis-cli -p 6398 shutdown nosave', '/tmp', facet), 'self_host');
  });

  it('names the matched target and its source ref, not just a verdict', () => {
    const assessment = assessSideEffect('kill -TERM 4242', '/tmp', self);
    assert.deepEqual(assessment.matchedTargets, [DAEMON_REF]);
    assert.ok(assessment.sourceRefs.includes(DAEMON_REF));
  });

  it('explains the refusal in plain language and offers somewhere else to go', () => {
    const { reason } = assessSideEffect('kill -TERM 4242', '/tmp', self);
    assert.match(reason, /4242/);
    assert.match(reason, /6398|alpha|You/i);
  });
});

describe('assessSideEffect: C5 sanctuary', () => {
  it('refuses mutating the sanctuary redis', () => {
    assert.equal(verdictOf('redis-cli -p 6399 flushall'), 'sanctuary');
  });

  it('allows the alpha redis on 6398', () => {
    assert.equal(verdictOf('redis-cli -p 6398 ping'), 'allow');
  });

  it('reports sanctuary rather than self-host when a command touches both', () => {
    assert.equal(verdictOf('redis-cli -p 6399 shutdown && kill -TERM 4242'), 'sanctuary');
  });
});

describe('assessSideEffect: unresolvable targets fail closed', () => {
  it('refuses a destructive command whose target it cannot resolve', () => {
    assert.equal(verdictOf('kill $(cat some.pid)'), 'unknown');
  });

  it('refuses a pattern kill, because a pattern is not a target', () => {
    assert.equal(verdictOf('pkill -f "node api"'), 'unknown');
  });

  it('tells the cat what could not be read and what to do instead', () => {
    const { reason } = assessSideEffect('kill $(cat some.pid)', '/tmp', self);
    assert.match(reason, /target set cannot be read/i);
    assert.match(reason, /pgrep/i);
    assert.match(reason, /6398|alpha|You/i);
  });

  // Reviewed 2026-09-07 (codex-astra): resolving one target is not resolving all
  // of them, and a neighbouring command's literal pid must not launder a
  // dynamic one.
  it('does not let one readable target vouch for an unreadable one', () => {
    assert.equal(verdictOf('kill -TERM 9999 $(cat host.pid)'), 'unknown');
    assert.equal(verdictOf('kill -0 9999; pkill -f "node api"'), 'unknown');
    assert.equal(verdictOf('pkill -f "node.*9999"'), 'unknown');
  });

  it('reads the canonical stop CLI by its own arguments, not by cwd', () => {
    const command = `node scripts/daemon-state.mjs stop --project-root ${SELF_WORKTREE} --deployment-id runtime`;
    assert.equal(verdictOf(command, '/somewhere/else'), 'self_host');
    // Another deployment's root is somebody else's business.
    assert.equal(verdictOf(command.replace(SELF_WORKTREE, '/other/checkout'), '/tmp'), 'allow');
  });

  it('follows a package manager that is pointed at our checkout', () => {
    assert.equal(verdictOf(`pnpm --dir ${SELF_WORKTREE} dev:stop`, '/tmp'), 'self_host');
  });

  // The daemon state records only the launcher; the API is an unrecorded child.
  it('asks about ancestry for a pid it does not recognise', () => {
    const hosted = fixtureSelfFacet({ hostDependencies: [] });
    hosted.runtime = { worktree: SELF_WORKTREE, head: '', launcherPid: 2622, sourceRef: DAEMON_REF };
    hosted.launcherPids = [2622];

    const isDescendant = (pid, ancestor) => (pid === 4242 && ancestor === 2622 ? true : false);
    assert.equal(
      assessSideEffect('kill -TERM 4242', '/tmp', hosted, { isHostDescendant: isDescendant }).verdict,
      'self_host',
    );

    const unreadable = () => undefined;
    assert.equal(
      assessSideEffect('kill -TERM 4242', '/tmp', hosted, { isHostDescendant: unreadable }).verdict,
      'unknown',
    );

    const unrelated = () => false;
    assert.equal(assessSideEffect('kill -TERM 4242', '/tmp', hosted, { isHostDescendant: unrelated }).verdict, 'allow');
  });
});

describe('assessSideEffect: no false positives on ordinary work', () => {
  for (const command of [
    'git status',
    'pnpm test',
    'rm -rf node_modules',
    'node --test packages/api/test/home-state/self-facet.test.js',
    'gh pr view 4321',
    // Classifies as a service mutation, but the service is someone else's.
    'curl -X POST https://example.com/tasks',
    'sqlite3 db "delete from t"',
  ]) {
    it(`allows ${command}`, () => {
      assert.equal(verdictOf(command), 'allow');
    });
  }
});

describe('assessSideEffect: missing self evidence is not a licence', () => {
  it('fails closed when the facet cannot say what hosts us', () => {
    const blind = fixtureSelfFacet({ hostDependencies: [] });
    blind.runtime = { worktree: SELF_WORKTREE, head: 'abc', observedAt: 1, sourceRef: DAEMON_REF };
    assert.equal(verdictOf('kill -TERM 4242', '/tmp', blind), 'unknown');
  });
});

/**
 * Cloud review P2 (PR #4426): the lifecycle names were matched against the raw
 * command text, so reading *about* a stop was indistinguishable from running
 * one. A guard that refuses `rg "runtime:stop"` blocks the only way to inspect
 * the code it guards -- and teaches the cat to route around it.
 */
describe('assessSideEffect: naming a lifecycle script is not running it', () => {
  for (const command of [
    'rg "runtime:stop" package.json',
    'git grep runtime:stop',
    'echo pnpm runtime:stop',
    'grep -rn "dev:stop" scripts/',
    'cat scripts/runtime-worktree.sh',
    'sed -n "1,40p" scripts/start-dev.sh',
  ]) {
    it(`allows ${command}`, () => {
      assert.equal(verdictOf(command, SELF_WORKTREE), 'allow');
    });
  }

  for (const command of [
    'pnpm runtime:stop',
    'pnpm run runtime:stop',
    'pnpm --filter @cat-cafe/api runtime:restart',
    'sudo pnpm runtime:stop',
    'bash scripts/runtime-worktree.sh stop',
    './scripts/runtime-worktree.sh restart',
    'bash -c "pnpm runtime:stop"',
    'node scripts/daemon-state.mjs stop --deployment-id runtime',
  ]) {
    it(`still refuses ${command}`, () => {
      assert.equal(verdictOf(command, SELF_WORKTREE), 'self_host');
    });
  }

  it('still refuses a cwd-scoped stop of the installation hosting us', () => {
    assert.equal(verdictOf('pnpm stop', SELF_WORKTREE), 'self_host');
  });

  it('still allows the reverify subcommand of the canonical CLI', () => {
    assert.equal(verdictOf('node scripts/daemon-state.mjs stop-reverify --health-ok true', SELF_WORKTREE), 'allow');
  });

  // Same mistake, second home: the killer and service-manager verbs were also
  // matched against raw stage text, so searching for them read as using them.
  for (const command of [
    'grep -rn "pkill -f node" scripts/',
    'rg "redis-cli shutdown" scripts/',
    'echo kill -9 4242',
    'rg "docker stop" docs/',
  ]) {
    it(`allows ${command}`, () => {
      assert.equal(verdictOf(command, SELF_WORKTREE), 'allow');
    });
  }

  it('still refuses a service manager actually asked to stop our port', () => {
    assert.equal(verdictOf('redis-cli -p 3002 shutdown', SELF_WORKTREE), 'self_host');
  });

  it('still fails closed when the killer target cannot be read', () => {
    assert.equal(verdictOf('kill -TERM $(cat api.pid)', SELF_WORKTREE), 'unknown');
  });
});

/**
 * Local final review R6 (C2/C3): a command can carry the thing it runs in a
 * place the first-token reading never looked -- inside a shell execution
 * string, further down a pipeline, inside a compound statement, inside a
 * command substitution, or behind a wrapper option value that was skipped
 * rather than consumed. Every one of these is executed content, so all of them
 * go through one parse rather than one regex each.
 */
describe('assessSideEffect: executed content is executed wherever it sits', () => {
  for (const command of [
    // Shell execution strings.
    "bash -c 'kill -TERM 4242'",
    'sh -c "kill -TERM 4242"',
    "bash -lc 'pnpm runtime:stop'",
    "eval 'kill -TERM 4242'",
    "bash -c 'redis-cli -p 3002 shutdown'",
    // Pipeline stages other than the first.
    'printf ready | pnpm runtime:stop',
    'echo go | xargs -I{} kill -TERM 4242',
    // Compound statements.
    'if true; then pnpm runtime:stop; fi',
    // Command substitution really runs its contents.
    'echo $(pnpm runtime:stop)',
    // Wrapper option values are the option's, not the program.
    'sudo -u root kill -TERM 4242',
    'env -u FOO kill -TERM 4242',
    'nice -n 5 kill -TERM 4242',
    'timeout 5 pnpm runtime:stop',
  ]) {
    it(`refuses ${command}`, () => {
      assert.equal(verdictOf(command, SELF_WORKTREE), 'self_host');
    });
  }

  for (const command of [
    'bash -c \'rg "runtime:stop" package.json\'',
    'rg "kill -9" docs/ | head -20',
    'sh -c "git grep pkill"',
    'printf "pnpm runtime:stop\\n"',
  ]) {
    it(`allows ${command}`, () => {
      assert.equal(verdictOf(command, SELF_WORKTREE), 'allow');
    });
  }

  it('fails closed on a wrapper option it has not modelled', () => {
    assert.equal(verdictOf('sudo --made-up-option kill -TERM 4242', SELF_WORKTREE), 'unknown');
  });

  it('fails closed when the executed string itself cannot be read', () => {
    assert.equal(verdictOf('bash -c "$STOP_COMMAND"', SELF_WORKTREE), 'unknown');
  });
});

/**
 * Local final review R6 (C4): destructive targets were only recognised when
 * spelled absolutely, so the same delete was refused as
 * `/home/user/cat-cafe-f300/packages/api` and allowed as `packages/api` -- from
 * inside that very checkout. A relative path is a path; the cwd is what makes
 * it one, and the cwd is already an input here.
 */
describe('assessSideEffect: a relative target is still a target', () => {
  // `git clean` is deliberately absent: the shared effect classifier still
  // reports it as `unknown`, and that is its call to make, not a second opinion
  // to build here. Recorded as a gap against the classifier, not patched around.
  for (const command of ['rm -rf packages/api', 'rm -rf ./packages/api', 'git reset --hard']) {
    it(`refuses ${command} from inside our own checkout`, () => {
      assert.equal(verdictOf(command, SELF_WORKTREE), 'self_host');
    });

    it(`allows ${command} from somebody else's checkout`, () => {
      assert.equal(verdictOf(command, '/home/user/some-other-repo'), 'allow');
    });
  }

  it('refuses the absolute spelling of the same target', () => {
    assert.equal(verdictOf(`rm -rf ${SELF_WORKTREE}/packages/api`, '/tmp'), 'self_host');
  });

  it('allows deleting a path outside the checkout while standing inside it', () => {
    assert.equal(verdictOf('rm -rf /tmp/scratch', SELF_WORKTREE), 'allow');
  });

  it('refuses the compiled entry the running host is executing', () => {
    // Rebuildable is not "the host survives losing it". An earlier draft
    // exempted any path segment named dist/node_modules, which quietly turned
    // an already-protected absolute target into an allowed one.
    assert.equal(verdictOf(`rm -rf ${SELF_WORKTREE}/packages/api/dist`, '/tmp'), 'self_host');
  });
});

/**
 * Local final review R7. The shared parse was right; what it *reported* was
 * not complete. Three result invariants, one counterexample family each:
 *
 * - INV-P: recursing into a stage's inner execution must not delete that stage
 *   from the outer pipeline. A stage we cannot describe leaves the stream after
 *   it unreadable.
 * - INV-T: every executed target is judged. The first non-host one is not proof
 *   about the rest.
 * - INV-C: a wrapper that moves the execution coordinate carries that fact into
 *   what it runs, and into where that command's targets resolve.
 */
describe('assessSideEffect: what the parse reports has to be all of it', () => {
  it('INV-P keeps the stdin boundary when a stage is expanded', () => {
    // The shell stage does not describe its own output, so the killer's stdin
    // is not the lsof two stages back.
    assert.equal(verdictOf('lsof -ti tcp:39003 | sh -c "printf 4242" | xargs kill', SELF_WORKTREE), 'unknown');
  });

  it('INV-P keeps killer attribution through an absolute executable', () => {
    assert.equal(verdictOf('lsof -ti tcp:3002 | xargs /bin/kill', SELF_WORKTREE), 'self_host');
  });

  it('INV-T judges every deployment, not just the first', () => {
    assert.equal(verdictOf('pnpm alpha:stop | pnpm runtime:stop', SELF_WORKTREE), 'self_host');
  });

  it('INV-C does not mistake an assignment after a wrapper for the program', () => {
    assert.equal(verdictOf('env F300_FIXTURE=1 kill -TERM 4242', SELF_WORKTREE), 'self_host');
  });

  it('INV-C reads env split-string as the executed content it is', () => {
    assert.equal(verdictOf('env -S "kill -TERM 4242"', SELF_WORKTREE), 'self_host');
  });

  it('INV-C carries a wrapper cwd into the nested execution', () => {
    assert.equal(
      verdictOf(`env -C ${SELF_WORKTREE} sh -c "rm -rf packages/api"`, '/tmp/unrelated-checkout'),
      'self_host',
    );
  });

  it('resolves a parent traversal into our checkout before comparing', () => {
    assert.equal(verdictOf('rm -rf ../cat-cafe-f300/packages/api', '/home/user/unrelated-checkout'), 'self_host');
  });

  it('resolves a parent traversal out of our checkout the same way', () => {
    assert.equal(verdictOf('rm -rf ../unrelated-scratch', SELF_WORKTREE), 'allow');
  });

  it('normalises before deciding, so a traversal cannot launder the target', () => {
    assert.equal(verdictOf('rm -rf node_modules/../packages/api', SELF_WORKTREE), 'self_host');
  });
});

/**
 * Local final review R8. Two different mistakes on the paths the last round
 * added: `env -S` is argv splitting, not a shell, and a coordinate has to be
 * resolved where it changes rather than carried as a string and resolved later
 * by whoever happens to look at it.
 */
describe('assessSideEffect: argv splitting is not shell evaluation', () => {
  it('appends the operands that follow a split-string, as env does', () => {
    // Real env splits the string and then appends the rest of its argv.
    assert.equal(verdictOf('env -S "kill -TERM 9999" 4242', SELF_WORKTREE), 'self_host');
  });

  it('treats a semicolon inside a split-string as the word it is', () => {
    // `env -S 'printf <%s> fixed;' tail` prints `<fixed;><tail>`: env runs
    // printf, and the semicolon is an argument. Nothing after it is a command.
    assert.equal(verdictOf('env -S "echo ready; kill -TERM 4242"', SELF_WORKTREE), 'allow');
  });
});

describe('assessSideEffect: a coordinate resolves where it changes', () => {
  it('resolves a relative wrapper cwd against the coordinate it was given', () => {
    assert.equal(
      verdictOf('env -C ../cat-cafe-f300 sh -c "rm -rf packages/api"', '/home/user/unrelated-checkout'),
      'self_host',
    );
  });

  it('composes nested coordinate changes instead of replacing the base', () => {
    assert.equal(
      verdictOf(`env -C ${SELF_WORKTREE} env -C packages sh -c "rm -rf api"`, '/home/user/unrelated-checkout'),
      'self_host',
    );
  });

  it('lets a runner read its own directory option, not the wrapper you passed', () => {
    assert.equal(verdictOf(`env -C /home/user/unrelated pnpm --dir ${SELF_WORKTREE} stop`, '/tmp'), 'self_host');
  });

  it('classifies the unwrapped invocation, not the text it was wrapped in', () => {
    assert.equal(
      verdictOf(`env -C ${SELF_WORKTREE} rm -rf packages/api`, '/home/user/unrelated-checkout'),
      'self_host',
    );
  });
});

/**
 * Local final review R9. The same two lessons, one layer further out: a
 * coordinate has to be resolved by every consumer that builds one, and argv
 * has to still be argv when it reaches the effect classifier.
 */
describe('assessSideEffect: resolution and argv survive to the last consumer', () => {
  it('normalises a runner directory that points into our checkout', () => {
    assert.equal(verdictOf('pnpm --dir ../cat-cafe-f300 stop', '/home/user/unrelated-checkout'), 'self_host');
  });

  it('normalises a runner directory that points out of it', () => {
    assert.equal(verdictOf('pnpm --dir ../unrelated-checkout stop', SELF_WORKTREE), 'allow');
  });

  it('keeps split-string operands as data when the effect is classified', () => {
    // env runs `echo`; `ready;`, `rm`, `-rf` and the path are things it prints.
    assert.equal(verdictOf('env -S "echo ready; rm -rf packages/api"', SELF_WORKTREE), 'allow');
  });

  it('still classifies a real delete that shares that shape', () => {
    assert.equal(verdictOf('env -S "rm -rf packages/api"', SELF_WORKTREE), 'self_host');
  });

  it('still classifies a repository rewrite whose subcommand is a bare word', () => {
    assert.equal(verdictOf('git reset --hard', SELF_WORKTREE), 'self_host');
  });
});

/**
 * Local final review R10. Quoting an operand correctly is not enough, because
 * the canonical classifier scans raw text and does not stop at a quote: a whole
 * message handed to `echo` as one word still had a `rm` read out of it.
 *
 * Everything that would actually be executed has already been split into its
 * own invocation by the time an operand reaches serialisation. So an operand
 * here is data, by construction -- and data must not be able to manufacture the
 * command position that the classifier keys on.
 */
describe('assessSideEffect: an operand cannot manufacture a command', () => {
  for (const command of [
    'echo "ready; rm -rf packages/api"',
    'env -S "echo \'ready; rm -rf packages/api\'"',
    'echo "then run: rm -rf packages/api && git reset --hard"',
    'printf "%s\\n" "; rm -rf packages/api"',
    // Three plain words are echo's arguments exactly as much as one quoted one
    // is. Whether the author needed quotes cannot decide whether it executes.
    'echo git reset --hard',
    'env -S "echo git reset --hard"',
    'echo rm -rf packages/api',
  ]) {
    it(`allows ${command}`, () => {
      assert.equal(verdictOf(command, SELF_WORKTREE), 'allow');
    });
  }

  // The reverse guards: separators that really do start a command still do,
  // and an extra literal operand can never cancel a target already named.
  for (const command of [
    'rm -rf packages/api',
    'echo ready; rm -rf packages/api',
    'git reset --hard',
    'true && rm -rf packages/api',
    "rm -rf packages/api 'note; rm -rf scratch'",
    "rm -rf packages/api 'git reset --hard'",
    'rm -rf packages/api /tmp/unrelated',
  ]) {
    it(`still refuses ${command}`, () => {
      assert.equal(verdictOf(command, SELF_WORKTREE), 'self_host');
    });
  }
});

/**
 * F306 owner review R13. Naming the program is not anchoring the argv: the Git
 * rewrite rule still searched every later operand, so `git grep "git reset
 * --hard"` -- the read you would use to inspect the rule being guarded -- was
 * refused. A Git executable does not make every later occurrence of a
 * destructive subcommand its own subcommand.
 */
describe('assessSideEffect: a program does not make its data its subcommand', () => {
  for (const command of [
    'git grep "git reset --hard"',
    'git log --grep="git reset --hard"',
    "git log --grep 'git reset --hard'",
    'git log --grep ordinary',
    'git show --stat',
    // find executes echo here, not rm.
    'find . -exec echo rm -rf {} +',
    'git -C /home/user/unrelated-checkout reset --hard',
    // A redirection character inside argv is data; nothing here reparses it.
    'echo > /tmp/note',
    // `-delete` here is the value of `-name`, not find's action.
    "find packages/api -name '-delete' -print",
    "find packages/api -exec echo '{}' ';'",
    // A bare `+` mid-argv is echo's argument, not the end of the exec.
    "find packages/api -exec echo '+' '-delete' '{}' ';'",
    // After `--` these are pathspecs, not flags.
    'git reset -- --hard',
    'git reset -- packages/api',
    // checkout's `--` form restores a file; it does not move HEAD.
    'git checkout -- runtime/main-sync',
    // An ordinary refspec is still ordinary wherever it sits.
    'git push origin -- main:main',
  ]) {
    it(`allows ${command}`, () => {
      assert.equal(verdictOf(command, SELF_WORKTREE), 'allow');
    });
  }

  for (const command of [
    'git reset --hard kill',
    'git reset --hard',
    'git reset --hard HEAD',
    'sudo git reset --hard',
    `env -C ${SELF_WORKTREE} git reset --hard`,
    'rm -rf packages/api',
    'rm -- packages/api/kill',
    "rm -- 'git reset --hard'",
    'find . -delete',
    'find . -exec rm -rf {} +',
    'find packages/api -delete',
    "find packages/api -exec rm -rf '{}' '+'",
    // A harmless first -exec must not hide a destructive later one.
    "find packages/api -exec echo '{}' ';' -exec rm -rf '{}' '+'",
    `git -C ${SELF_WORKTREE} reset --hard`,
    'git checkout runtime/main-sync',
    // switch has no pathspec form: `--` only ends its options, so this still
    // moves HEAD onto the branch (verified in an isolated fixture repository).
    'git switch runtime/main-sync',
    'git switch -- runtime/main-sync',
    // `--` ends push's *options*; its refspecs are positional and still mean
    // what they say, so a forced one after it is still a forced push.
    'git push origin -- +main:main',
    'git push origin -- runtime/main-sync',
    'git push --force origin main',
    'git push -- origin +HEAD:refs/heads/topic',
    'git push -- origin :refs/heads/topic',
    // The batch form really does end at `{} +`.
    "find packages/api -exec echo '{}' ';' -exec rm -rf '{}' '+'",
  ]) {
    it(`still refuses ${command}`, () => {
      assert.equal(verdictOf(command, SELF_WORKTREE), 'self_host');
    });
  }
});
