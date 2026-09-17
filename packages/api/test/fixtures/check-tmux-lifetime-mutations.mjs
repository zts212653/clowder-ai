import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../../dist/domains/terminal/tmux-pane-lease.js', import.meta.url));
const original = readFileSync(target);
const source = original.toString('utf8');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const cases = [
  {
    name: 'no-identity',
    pattern: 'old invocation cleanup',
    expected: /A cleanup must leave the live successor untouched/,
    mutate: (value) => value.replace(/const condition = [^\n]+;/, 'const condition = "1";'),
  },
  {
    name: 'no-target',
    pattern: 'display rename',
    expected: /changing a display name must not revoke the creation identity/,
    mutate: (value) => value.replace(/(['"]if['"]\s*,\s*['"]-F['"]\s*,)\s*['"]-t['"]\s*,\s*lease\.paneId\s*,/, '$1'),
  },
  {
    name: 'separate-check-action',
    pattern: 'intervening client boundary',
    expected: /successor must not inherit old interrupt authority/,
    mutate: (value) =>
      value.replace(
        /const result = execFileSync\([\s\S]+?return result\.trim\(\) === 'applied';/,
        `const current = execFileSync(bin, ['-L', socket, 'display-message', '-p', '-t', lease.paneId, condition], {encoding:'utf8', env:tmuxServerEnvironment()});
      if (current.trim() !== '1') return false;
      execFileSync(bin, ['-L', socket, ...actions[action].split(' ')], {env:tmuxServerEnvironment()});
      return true;`,
      ),
  },
];

try {
  for (const specimen of cases) {
    const mutant = specimen.mutate(source);
    assert.notEqual(mutant, source, `${specimen.name}: mutation must change the implementation`);
    writeFileSync(target, mutant);
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        './test/helpers/setup-cat-registry.js',
        '--test',
        '--test-timeout=25000',
        `--test-name-pattern=${specimen.pattern}`,
        'test/tmux-pane-lifetime.test.js',
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    writeFileSync(`/tmp/f212-astra-mutant-${specimen.name}.log`, output, { mode: 0o600 });
    assert.notEqual(result.status, 0, `${specimen.name}: the regression must turn RED`);
    assert.match(output, specimen.expected, `${specimen.name}: RED must be the intended assertion`);
    writeFileSync(target, original);
    console.log(`${specimen.name}: expected RED`);
  }
} finally {
  writeFileSync(target, original);
  assert.equal(sha(readFileSync(target)), sha(original), 'compiled implementation must be restored byte for byte');
}
