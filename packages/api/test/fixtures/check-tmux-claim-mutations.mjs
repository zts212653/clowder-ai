import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../../dist/domains/terminal/tmux-pane-creation-record.js', import.meta.url));
const original = readFileSync(target);
const source = original.toString('utf8');
const cases = [
  {
    name: 'replace-claim',
    pattern: 'creation claim: claimed-successor',
    expected: /successor cannot replace the complete claim/,
    prefix: "require('node:fs').rmSync(process.argv[2],{force:true}); ",
  },
  {
    name: 'reopen-closed-gate',
    pattern: 'creation claim: before-claim',
    expected: /closed gate must prevent the delayed agent from ever starting/,
    prefix: "require('node:fs').mkdirSync(require('node:path').dirname(process.argv[2]),{recursive:true}); ",
  },
];
try {
  for (const specimen of cases) {
    const needle = 'symlinkSync(process.argv[1],process.argv[2]);';
    const mutant = source.replace(needle, `${specimen.prefix}${needle}`);
    assert.notEqual(mutant, source, 'the actual publisher must be mutated');
    writeFileSync(target, mutant);
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        './test/helpers/setup-cat-registry.js',
        '--test',
        `--test-name-pattern=${specimen.pattern}`,
        'test/tmux-creation-claim.test.js',
      ],
      { encoding: 'utf8', timeout: 40000 },
    );
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    writeFileSync(`/tmp/f212-claim-mutant-${specimen.name}.log`, output, { mode: 0o600 });
    assert.notEqual(run.status, 0, `${specimen.name}: must turn RED`);
    assert.match(output, specimen.expected, `${specimen.name}: must fail the intended contract`);
    writeFileSync(target, original);
    console.log(`${specimen.name}: expected RED`);
  }
} finally {
  writeFileSync(target, original);
  assert.deepEqual(readFileSync(target), original, 'compiled publisher must be restored byte for byte');
}
