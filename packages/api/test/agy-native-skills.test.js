import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { materializeAgyNativeSkills } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-skills.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-skills-'));
  const profileHome = join(root, 'profile'),
    workspace = join(root, 'workspace'),
    userHome = join(root, 'user');
  for (const dir of [profileHome, workspace, userHome]) mkdirSync(dir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = (home, name, text) => {
    const path = join(home, '.gemini/skills', name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'SKILL.md'), text);
    return path;
  };
  return {
    root,
    profileHome,
    workspace,
    userHome,
    skill,
    materialize: () => materializeAgyNativeSkills({ profileHome, workspace, userHome, runtimeRoot: process.cwd() }),
    mounted: (name) => join(profileHome, '.gemini/antigravity-cli/skills', name),
  };
}

test('Native sees canonical project and opted-in user skills; project wins and later disable removes its view', async (t) => {
  const f = fixture(t);
  f.skill(f.userHome, 'shared', 'user');
  const project = f.skill(f.workspace, 'shared', 'project');
  f.skill(f.userHome, 'global-only', 'global');
  await f.materialize();
  assert.equal(realpathSync(f.mounted('shared')), realpathSync(project));
  assert.equal(readFileSync(join(f.mounted('global-only'), 'SKILL.md'), 'utf8'), 'global');
  mkdirSync(join(f.workspace, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(f.workspace, '.cat-cafe/capabilities.json'),
    JSON.stringify({
      version: 2,
      capabilities: [],
      mountRules: [{ name: 'gemini', path: '.gemini/skills', enabled: false }],
    }),
  );
  await f.materialize();
  assert.equal(existsSync(f.mounted('shared')), false);
  assert.equal(existsSync(f.mounted('global-only')), false);
  assert.equal(readFileSync(join(project, 'SKILL.md'), 'utf8'), 'project', 'source is never changed');
});

test('Native refuses modified profile skill links and preserves unrelated user files', async (t) => {
  const f = fixture(t);
  f.skill(f.workspace, 'example', 'canonical');
  await f.materialize();
  rmSync(f.mounted('example'));
  symlinkSync(f.root, f.mounted('example'));
  await assert.rejects(f.materialize(), /changed outside|conflict|unexpected/i);
  assert.equal(realpathSync(f.mounted('example')), realpathSync(f.root));
});

test('an API crash while publishing skills can be recovered without operator file repair', async (t) => {
  const f = fixture(t);
  f.skill(f.workspace, 'example', 'canonical after restart');
  const moduleUrl = new URL(
    '../dist/domains/cats/services/agents/providers/agy-native/agy-native-skills.js',
    import.meta.url,
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const createLink = fs.symlinkSync;
    fs.symlinkSync = (...args) => { createLink(...args); process.exit(73); };
    syncBuiltinESMExports();
    const { materializeAgyNativeSkills } = await import(process.argv[1]);
    await materializeAgyNativeSkills(JSON.parse(process.argv[2]));
  `,
      moduleUrl,
      JSON.stringify({
        profileHome: f.profileHome,
        workspace: f.workspace,
        userHome: f.userHome,
        runtimeRoot: process.cwd(),
      }),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 73, child.stderr);
  await f.materialize();
  assert.equal(readFileSync(join(f.mounted('example'), 'SKILL.md'), 'utf8'), 'canonical after restart');
});
