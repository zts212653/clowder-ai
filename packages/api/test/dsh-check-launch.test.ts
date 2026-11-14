import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { createDshCheckLaunch, readDshCheckBinding } from '../src/routes/dsh-check-launch.js';
import { DSH_DESKTOP_RUNTIME } from '../src/routes/dsh-desktop-runtime.js';

test('checks isolate HOME/cwd and require the tool guard before ACP becomes ready', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-check-launch-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, 'credentials.mjs');
  writeFileSync(runtime, DSH_DESKTOP_RUNTIME);
  const patch = join(root, 'member.patch.yml');
  const contents = stringify([
    { id: 'credentials', disabled: true },
    {
      insert: [
        {
          id: 'clowder-desktop-credentials',
          name: pathToFileURL(runtime).href,
          config: { nativeHome: root, nativeCwd: root },
        },
      ],
    },
    { id: 'acp', inject: ['acpAppStartup', 'credentials'], config: { provider: 'custom', model: 'chosen' } },
  ]);
  writeFileSync(patch, contents);
  const launch = {
    command: '/desktop/dsh.cmd',
    args: ['--profile', 'acp', '--patch', patch],
    cwd: root,
    env: { DSH_HOME: root },
  };
  const check = createDshCheckLaunch(readDshCheckBinding(launch));
  t.after(() => check.close());
  assert.notEqual(check.launch.env.DSH_HOME, root);
  assert.notEqual(check.launch.cwd, root);
  assert.equal(readFileSync(patch, 'utf8'), contents);
  const copied = parse(readFileSync(check.launch.args.at(-1)!, 'utf8'));
  assert.deepEqual(copied.find((row: { id?: string }) => row.id === 'acp').config, {
    provider: 'custom',
    model: 'chosen',
  });
  assert.ok(copied.find((row: { id?: string }) => row.id === 'acp').inject.includes('clowderConnectionCheckReady'));
  check.close();
  assert.equal(existsSync(check.launch.cwd), false);
  assert.equal(readFileSync(patch, 'utf8'), contents);
  writeFileSync(patch, stringify([...parse(contents), { id: 'unexpected-side-effect-plugin' }]));
  assert.throws(() => readDshCheckBinding(launch), /dsh_setup_custom_startup/);
});

test('checks refuse unprepared launches and additional plugins before starting a process', () => {
  assert.throws(
    () => readDshCheckBinding({ command: 'dsh', args: ['--profile', 'acp'], cwd: tmpdir() }),
    /dsh_setup_profile_required/,
  );
});
