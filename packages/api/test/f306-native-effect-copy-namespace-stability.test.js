import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-copy-namespace-')));
const projectRoot = join(root, 'projects/relay-station');
const main = join(projectRoot, 'cat-cafe');
const runtime = join(projectRoot, 'cat-cafe-runtime');
const output = join(root, 'ordinary');
for (const path of [main, output, join(runtime, 'packages/api/dist/nested')]) mkdirSync(path, { recursive: true });
writeFileSync(join(runtime, 'file.txt'), 'fixture');
writeFileSync(join(runtime, 'copy-source.txt'), 'replacement');
writeFileSync(join(runtime, 'packages/api/dist/nested/asset.js'), 'replacement');
after(() => rmSync(root, { recursive: true, force: true }));

const noHost = { selfHost: () => ({ confidence: 'none' }) };
function parity(command, expected) {
  for (const tool of ['exec_command', 'Bash']) {
    const payload = { tool_name: tool, cwd: main, tool_input: { cmd: command, command } };
    const got = decideNativeHookPayload(payload, noHost);
    assert.equal(got.decision, expected, `${tool}: ${command}: ${JSON.stringify(got)}`);
  }
}

test('ordinary topology-preserving predecessors do not invalidate an exact copy target', () => {
  const source = join(runtime, 'copy-source.txt');
  const rows = [
    [`mkdir -p ${join(output, 'made-directory')}`, '&&', join(output, 'made-directory/copied.txt')],
    [`cd ${output}`, '&&', join(output, 'after-cd.txt')],
    [`cp -- ${source} ${join(output, 'first-copy.txt')}`, '&&', join(output, 'second-copy.txt')],
    [`printf hi > ${join(output, 'message.log')}`, ';', join(output, 'after-redirect.txt')],
    [`echo hi > ${join(output, 'echo.log')}`, ';', join(output, 'after-echo.txt')],
    [`touch ${join(output, 'touched.txt')}`, ';', join(output, 'after-touch.txt')],
    [`rm -f ${join(output, 'absent.txt')}`, ';', join(output, 'after-rm.txt')],
    [`trash ${join(output, 'absent.txt')}`, ';', join(output, 'after-trash.txt')],
  ];
  for (const [predecessor, separator, destination] of rows)
    parity(`${predecessor} ${separator} cp -- ${source} ${destination}`, 'allow');
});

test('alias-creating predecessors and substitutions invalidate later copy observations', () => {
  const alias = join(output, 'substitution-alias');
  const source = join(runtime, 'copy-source.txt');
  const prepare = `node -e 'require("node:fs").symlinkSync("${runtime}","${alias}")'`;
  const copy = `cp -- ${source} ${join(alias, 'copied.txt')}`;
  for (const command of [
    `${prepare}; echo "$(${copy})"`,
    `${prepare}; echo \`${copy}\``,
    `echo "$(${prepare})"; ${copy}`,
    `echo \`${prepare}\`; ${copy}`,
    `echo "$(${prepare})" "$(${copy})"`,
    `ln -s ${runtime} ${alias}; ${copy}`,
  ])
    parity(command, 'deny');

  const ordinaryCopy = `cp -- ${source} ${join(output, 'nested-copy.txt')}`;
  parity(`echo "$(${ordinaryCopy})"`, 'allow');
  parity(`echo "$(mkdir -p ${join(output, 'nested-dir')})" "$(${ordinaryCopy})"`, 'allow');
});

test('concurrent execution invalidates copy observations independent of text order', () => {
  const alias = join(output, 'background-alias');
  const source = join(runtime, 'copy-source.txt');
  const prepare = `node -e 'require("node:fs").symlinkSync("${runtime}","${alias}")'`;
  const delayedCopy = `sleep 1 && cp -- ${source} ${join(alias, 'copied.txt')}`;
  for (const command of [
    `${delayedCopy} & ${prepare}; wait`,
    `{ ${delayedCopy}; } & ${prepare}; wait`,
    `( ${delayedCopy} ) & ${prepare}; wait`,
    `${delayedCopy} | cat & ${prepare}; wait`,
    `{ ${delayedCopy}; } | ${prepare}`,
    `${prepare} < <(${delayedCopy})`,
  ])
    parity(command, 'deny');
});

test('recursive copy inspects aliases below its existing merge root', () => {
  const source = join(runtime, 'packages/api/dist');
  const ordinary = join(output, 'ordinary-merge');
  const aliased = join(output, 'aliased-merge');
  const symlinked = join(output, 'symlinked-merge');
  for (const target of [ordinary, aliased, symlinked]) mkdirSync(join(target, 'dist/nested'), { recursive: true });
  writeFileSync(join(ordinary, 'dist/nested/asset.js'), 'ordinary');
  linkSync(join(runtime, 'file.txt'), join(ordinary, 'unrelated-sibling-hardlink'));
  linkSync(join(runtime, 'file.txt'), join(aliased, 'dist/nested/asset.js'));
  symlinkSync(join(runtime, 'file.txt'), join(symlinked, 'dist/nested/asset.js'));
  parity(`cp -R ${source} ${ordinary}`, 'allow');
  parity(`cp -R ${source} ${aliased}`, 'deny');
  parity(`cp -R ${source} ${symlinked}`, 'deny');
});
