import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const api = fileURLToPath(new URL('../../', import.meta.url));
const creation = fileURLToPath(new URL('../../dist/domains/terminal/tmux-agent-pane.js', import.meta.url));
const baseline = fileURLToPath(new URL('../../dist/domains/terminal/tmux-server-environment.js', import.meta.url));
const originals = new Map([creation, baseline].map((path) => [path, readFileSync(path)]));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const childEnv = Object.fromEntries(
  ['HOME', 'PATH', 'SHELL', 'TMPDIR', 'CAT_CAFE_TEST_REAL_HOME']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
Object.assign(childEnv, { NODE_ENV: 'test', CAT_CAFE_TEST_SANDBOX: '1', CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1' });

function exposeFixtureValue(source) {
  return `import {readFileSync} from 'node:fs';\n${source}`.replace(
    'const common = [',
    `const leakedValue = readFileSync(options.command.at(-1), 'utf8').match(/^export F212_CALL_SECRET='([^']*)'/m)?.[1];\nconst common = [`,
  );
}

const cases = [
  {
    name: 'argv-env',
    path: creation,
    pattern: 'real child receives planned',
    expected: /actual tmux invocation must never carry the secret value/,
    mutate: (source) =>
      exposeFixtureValue(source).replace(
        'const common = [',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal mutant source, evaluated by the spawned test
        "const common = ['-e', `F212_CALL_SECRET=${leakedValue}`,",
      ),
  },
  {
    name: 'invocation-in-server',
    path: creation,
    pattern: 'fresh shared server',
    expected: /invocation secret must never reside in server env/,
    mutate: (source) =>
      exposeFixtureValue(source).replaceAll(
        'env: tmuxServerEnvironment()',
        'env: {...tmuxServerEnvironment(), F212_CALL_SECRET: leakedValue}',
      ),
  },
  {
    name: 'wrapper-only',
    path: baseline,
    pattern: 'fresh shared server',
    expected: /CAT_CAFE_HOOK_TOKEN must not reside in server global env/,
    mutate: (source) => source.replace(/return Object\.fromEntries\([^\n]+;/, 'return {...process.env};'),
  },
  {
    name: 'retain-existing-env',
    path: baseline,
    pattern: 'discovered existing server',
    expected: /discovered server environment must be clean/,
    mutate: (source) =>
      source
        .replace('const commands = removalCommands(global.stdout);', 'const commands = [];')
        .replace('commands.push(...removalCommands(local.stdout, target));', ''),
  },
];

try {
  for (const specimen of cases) {
    const source = originals.get(specimen.path).toString('utf8');
    const mutant = specimen.mutate(source);
    assert.notEqual(mutant, source, `${specimen.name}: mutation must alter the implementation`);
    writeFileSync(specimen.path, mutant);
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        './test/helpers/setup-cat-registry.js',
        '--test',
        '--test-timeout=25000',
        `--test-name-pattern=${specimen.pattern}`,
        'test/tmux-invocation-environment.test.js',
      ],
      { cwd: api, env: childEnv, encoding: 'utf8', timeout: 30000 },
    );
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    writeFileSync(`/tmp/f212-astra-mutant-${specimen.name}.log`, output, { mode: 0o600 });
    assert.notEqual(result.status, 0, `${specimen.name}: regression must turn RED`);
    assert.match(output, specimen.expected, `${specimen.name}: RED must be the intended assertion`);
    writeFileSync(specimen.path, originals.get(specimen.path));
    console.log(`${specimen.name}: expected RED`);
  }
} finally {
  for (const [path, data] of originals) {
    writeFileSync(path, data);
    assert.equal(sha(readFileSync(path)), sha(data), 'compiled implementation must be restored byte for byte');
  }
}
