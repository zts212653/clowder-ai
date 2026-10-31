import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { executedInvocations } from '../../../scripts/lib/shell-invocation.mjs';

const quote = (source) => `'${source.replaceAll("'", "'\\''")}'`;
const wrappers = [
  (source) => source,
  (source) => `( ${source}\n)`,
  (source) => `bash -c ${quote(source)}`,
  (source) => `eval ${quote(source)}`,
  (source) => `printf '%s\\n' "$( ${source}\n)"`,
  (source) => `printf '%s\\n' \` ${source.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\n\``,
];

// Every executed command is printf, bash, or eval of this fixed printf-only grammar.
// There are no fixture-to-threat substitutions and no filesystem/network/process effects.
for (const shell of ['/bin/bash', '/bin/zsh'])
  test(`comment/quote/substitution boundary matrix agrees with ${shell}`, { skip: !existsSync(shell) }, () => {
    let executions = 0;
    for (const wrap of wrappers) {
      for (const comment of ["it's", "don't", '"quoted"', "$(printf IGNORED) ' `", '# \\', "' \\"]) {
        for (const substitution of ['$(printf INNER)', '`printf INNER`', '"$(printf INNER)"']) {
          const marker = `LEXICAL_MARK_${executions++}`;
          const body = `printf '%s' ${substitution} # ${comment}\nprintf '%s\\n' ${marker}`;
          const source = wrap(body);
          const actual = spawnSync(shell, shell.endsWith('/zsh') ? ['-f', '-c', source] : ['-c', source], {
            encoding: 'utf8',
            timeout: 2000,
            env: { PATH: '/usr/bin:/bin' },
          });
          const parsed = executedInvocations(source);
          if (actual.status !== 0) {
            assert.equal(parsed.complete, false, `${source}\n${actual.stderr}`);
            continue;
          }
          if (!actual.stdout.includes(marker)) {
            // Legacy Bash can fold the commented backslash while bracket-scanning
            // a quoted substitution. This dialect ambiguity is not a complete parse.
            assert.equal(parsed.complete, false, source);
            continue;
          }
          assert.ok(
            parsed.pipelines.flat().some(({ name, operands }) => name === 'printf' && operands.includes(marker)),
            source,
          );
        }
      }
    }
    assert.equal(executions, 108);
  });

test('Bash executes earlier complete lines before a later EOF quote failure', () => {
  for (const tail of ["'", '"', 'printf "']) {
    const source = `printf '%s' "$(printf INNER)" # don't \\\nprintf '%s\\n' PREFIX_MARK\n${tail}`;
    const actual = spawnSync('/bin/bash', ['-c', source], {
      encoding: 'utf8',
      timeout: 2000,
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.notEqual(actual.status, 0);
    assert.match(actual.stdout, /PREFIX_MARK/);
    const parsed = executedInvocations(source);
    assert.equal(parsed.complete, false);
    assert.ok(
      parsed.pipelines.flat().some(({ name, operands }) => name === 'printf' && operands.includes('PREFIX_MARK')),
    );
  }
});

for (const shell of ['/bin/bash', '/bin/zsh'])
  test(`generated execution oracle with ${shell}`, { skip: !existsSync(shell) }, () => {
    const sources = [
      'V=$(printf "%s" \'printf "%s" ORACLE_MARK\'); eval "$V"',
      'V=$(printf "%s" \'printf "%s" ORACLE_MARK\'); W=$V; eval "$W"',
      'for V in "$(printf "%s" \'printf "%s" ORACLE_MARK\')"; do eval "$V"; done',
      'V=$(printf "%s" \'printf "%s" ORACLE_MARK\'); for V in; do printf ignored; done; eval "$V"',
      '$(printf printf) "%s" ORACLE_MARK',
      'printf "%s" ORACLE_MARK \\',
      'printf "%s" ORACLE_MARK \\\n',
      "x=$(cat <<'EOF'\nit's ) here\nEOF\n)\nprintf '%s' ORACLE_MARK",
      "echo $(cat <<'EOF'\nit's\nEOF\n; printf '%s' ORACLE_MARK)",
      `echo "$(x=$(cat <<'EOF'\na )\nb\nEOF\n)\nprintf '%s' ORACLE_MARK)"`,
    ];
    let observed = 0;
    for (const source of sources) {
      const actual = spawnSync(shell, shell.endsWith('/zsh') ? ['-f', '-c', source] : ['-c', source], {
        encoding: 'utf8',
        timeout: 2_000,
        env: { PATH: '/usr/bin:/bin' },
      });
      if (!actual.stdout.includes('ORACLE_MARK')) continue;
      observed++;
      const parsed = executedInvocations(source);
      const visible = parsed.pipelines
        .flat()
        .some(({ name, operands }) => name === 'printf' && operands.includes('ORACLE_MARK'));
      assert.ok(
        visible || !parsed.complete,
        `${shell}: an executed marker disappeared from a complete reading: ${source}`,
      );
    }
    assert.ok(observed >= 5, `${shell}: oracle did not exercise the fixed execution grammar`);
  });
