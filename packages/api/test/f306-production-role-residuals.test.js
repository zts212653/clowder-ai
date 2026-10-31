import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-production-roles-')));
const projectRoot = join(root, 'projects/relay-station');
const main = join(projectRoot, 'cat-cafe');
const runtime = join(projectRoot, 'cat-cafe-runtime');
const output = join(root, 'ordinary');
for (const path of [main, runtime, output, join(runtime, 'packages/api/dist')]) mkdirSync(path, { recursive: true });
writeFileSync(join(runtime, 'loader.js'), '');
writeFileSync(join(runtime, 'file.txt'), 'fixture');
writeFileSync(join(runtime, 'copy-source.txt'), 'replacement');
symlinkSync(runtime, join(output, 'alias'));
symlinkSync(runtime, join(output, 'staged-alias'));
symlinkSync(join(runtime, 'file.txt'), join(output, 'leaf-link'));
symlinkSync(join(runtime, 'future'), join(output, 'dangling-link'));
linkSync(join(runtime, 'file.txt'), join(output, 'hard-link'));
mkdirSync(join(output, 'directory'));
symlinkSync(join(runtime, 'file.txt'), join(output, 'directory/copy-source.txt'));
symlinkSync(join(output, 'directory'), join(output, 'directory-link'));
mkdirSync(join(output, 'hard-directory'));
linkSync(join(runtime, 'file.txt'), join(output, 'hard-directory/copy-source.txt'));
after(() => rmSync(root, { recursive: true, force: true }));
const noHost = { selfHost: () => ({ confidence: 'none' }) };
const runtimeApiPort = 3002;
function verdict(command, tool = 'exec_command', cwd = main) {
  return decideNativeHookPayload({ tool_name: tool, cwd, tool_input: { cmd: command, command } }, noHost);
}
function parity(command, expected, cwd = main) {
  for (const tool of ['exec_command', 'Bash']) {
    const got = verdict(command, tool, cwd);
    assert.equal(got.decision, expected, tool + ': ' + command + ': ' + JSON.stringify(got));
  }
}

function unproved(command, targetKind = 'runtime_sanctuary', cwd = main) {
  for (const tool of ['exec_command', 'Bash']) {
    const got = verdict(command, tool, cwd);
    const message = `${tool}: ${command}: ${JSON.stringify(got)}`;
    assert.equal(got.effect, 'unknown', message);
    assert.equal(got.target.kind, targetKind, message);
    assert.notEqual(got.reasonCode, 'read_only', message);
  }
}

// Boot20 default-tool refusal; source113 agrees this is opaque application data.
test('literal Node/Python inline-code arguments remain data through target classification', () => {
  const data = JSON.stringify({ note: 'rm -rf ' + runtime });
  for (const prefix of [
    "node -e 'console.log(process.argv[1])'",
    "env node -e 'console.log(process.argv[1])'",
    "node --input-type=module -e 'console.log(process.argv[1])'",
    "node -p 'process.argv[1]' --",
    "python3 -c 'import sys; print(sys.argv[1])'",
  ])
    parity(prefix + " '" + data + "'", 'allow');
  parity("python3 -c 'print(1)' -c " + runtime + '/data-argument', 'allow');
  parity("node -e 'console.log(process.argv[1])' " + runtime + '/data-argument', 'allow');
  const policyWords = JSON.stringify({
    note: 'git push --force origin main; redis-cli -p 6399 SET x y; pnpm runtime:restart',
    path: runtime,
  });
  parity("node -e 'console.log(process.argv[1])' '" + policyWords + "'", 'allow');
});

test('Node options after inline source remain loader controls until positional data starts', () => {
  for (const option of ['-r', '--require', '--import', '--loader', '--experimental-loader']) {
    unproved("node -e 'console.log(1)' " + option + ' ' + runtime + '/loader.js');
    unproved('node ' + option + '=' + runtime + "/loader.js -e 'console.log(1)'");
  }
  parity("node -e 'console.log(process.argv)' -- --require " + runtime + '/data-argument', 'allow');
  unproved("node -e '' -r " + runtime + '/loader.js');
  parity("node -e 'console.log(process.argv)' '' --require " + runtime + '/data-argument', 'allow');
});

test('script, loader and configuration targets stay unproved while real output writes stay protected', () => {
  for (const command of [
    'node ' + runtime + '/script.js',
    'node -- ' + runtime + '/script.js',
    'python3 ' + runtime + '/script.py',
    "node --unknown-option -e 'console.log(1)' " + runtime + '/data',
    "node -e 'console.log(1)' --unknown-option " + runtime + '/data',
    'node -e "$CODE" ' + runtime + '/data',
    'node "$OPT" -e \'console.log(1)\' ' + runtime + '/data',
    "NODE_OPTIONS='--require " + runtime + "/loader.js' node -e 'console.log(1)'",
    'env CAT_CAFE_CONFIG_ROOT=' + runtime + " node -e 'console.log(1)'",
  ])
    unproved(command);
  unproved('PATH=' + runtime + "/bin node -e 'console.log(1)'", 'ordinary');
  unproved("node -e 'console.log(process.argv[1])' '/tmp/data'", 'runtime_sanctuary', runtime);
  parity("node -e 'console.log(1)' /tmp/data > " + runtime + '/out', 'deny');
  // Perl's inline source is not Node/Python argv and cannot certify the path as a read.
  unproved("perl -pi -e 's/x/y/' " + runtime + '/file.txt');
});

// Real source055/073: a cp -R read source was misclassified as the write target.
test('exact recursive copy grammar attributes the write to the destination', () => {
  const source = join(runtime, 'packages/api/dist');
  for (const flag of ['-R', '-R --']) {
    const command = 'cp ' + flag + ' ' + source + ' ' + join(output, 'exported');
    parity(command, 'allow');
    assert.equal(verdict(command).effect, 'write');
    assert.equal(verdict(command).target.kind, 'ordinary');
  }
});

test('copy destinations and their physical parent/leaf aliases remain protected', () => {
  const source = join(runtime, 'copy-source.txt');
  for (const destination of [
    join(runtime, 'copy'),
    join(output, 'alias/copy'),
    join(output, 'leaf-link'),
    join(output, 'dangling-link/future-copy'),
  ]) {
    parity('cp -R ' + join(runtime, 'packages/api/dist') + ' ' + destination, 'deny');
    parity('cp -- ' + source + ' ' + destination, 'deny');
  }
  for (const destination of [
    join(output, 'directory'),
    join(output, 'directory-link'),
    join(output, 'hard-directory'),
  ]) {
    parity('cp -- ' + source + ' ' + destination, 'deny');
  }
  parity('cp -- ' + source + ' ' + join(output, 'hard-link'), 'deny');
});

test('unknown copy controls, generated paths, traversal and multiple sources remain fail-closed', () => {
  const source = join(runtime, 'packages/api/dist');
  for (const command of [
    'cp -L -R ' + source + ' ' + join(output, 'copy'),
    'cp -R ' + source + ' ' + join(output, 'a') + ' ' + join(output, 'b'),
    'cp -R ' + source + ' "$DEST"',
    'cp -R ' + source + ' /tmp/$DEST',
    'cp -R ' + source + ' ' + output + '/../ordinary/copy',
    'cp -R ' + source + '/* ' + join(output, 'copy'),
    'cp --target-directory=' + output + ' -R ' + source,
  ])
    parity(command, 'deny');
  parity('cp -- ' + join(runtime, 'copy-source.txt') + ' /tmp/$DEST', 'deny');
});

test('copy namespace observations cannot exclude a target after an unknown mutating predecessor', () => {
  const alias = join(output, 'future-alias');
  const prepare = 'node -e \'require("node:fs").symlinkSync("' + runtime + '","' + alias + '")\'';
  parity(prepare + '; cp -- ' + join(runtime, 'file.txt') + ' ' + join(alias, 'copied.txt'), 'deny');

  const staged = join(output, 'staged-alias');
  const hiddenMove = 'printf %s "$(mv ' + staged + ' ' + alias + ')"';
  parity(hiddenMove + '; cp -- ' + join(runtime, 'file.txt') + ' ' + join(alias, 'copied.txt'), 'deny');
});

test('unregistered named status is read-only observation and does not prove Alpha ownership', (t) => {
  const records = join(root, 'empty-records');
  mkdirSync(records);
  const previous = process.env.CAT_CAFE_PREVIEW_PROCESS_DIR;
  process.env.CAT_CAFE_PREVIEW_PROCESS_DIR = records;
  t.after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_PREVIEW_PROCESS_DIR;
    else process.env.CAT_CAFE_PREVIEW_PROCESS_DIR = previous;
  });
  const prefix = 'pnpm --dir ' + main + ' preview:process ';
  const coordinates = ' --cwd ' + main + ' --port 5311';
  for (const suffix of ['', ' --json']) {
    const command = prefix + 'status' + coordinates + suffix;
    parity(command, 'allow', '/tmp');
    const got = verdict(command, 'exec_command', '/tmp');
    assert.equal(got.effect, 'read');
    assert.ok(!got.target.value.startsWith('preview://alpha'));
  }
  for (const command of [
    prefix + 'stop' + coordinates,
    prefix + 'start' + coordinates + ' -- node /tmp/unknown-child.js',
    prefix + 'status' + coordinates + ' --lifetime-seconds 30',
    prefix + 'status' + coordinates + ' -- node /tmp/unknown-child.js',
    prefix + 'status' + coordinates + ' --unknown',
  ]) {
    parity(command, 'allow');
    unproved(command, 'ordinary');
    assert.ok(!verdict(command).target.value.startsWith('preview://alpha'));
  }
  parity(prefix + 'stop' + coordinates + '; rm -rf ' + runtime, 'deny');
  parity(prefix + 'status --cwd ' + runtime + ' --port 5311', 'deny');
  parity(prefix + 'status --cwd ' + main + ' --port ' + runtimeApiPort, 'deny');
});
