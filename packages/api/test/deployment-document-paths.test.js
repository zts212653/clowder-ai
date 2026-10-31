import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedSource = resolve(apiRoot, '../shared/src');
const require = createRequire(import.meta.url);

// Each child loads actual compiled readers against a separate packaged configuration.
// No mutation of the checkout configuration, global HOME, origin/main or live API.
for (const activeProfile of ['home', 'opensource']) {
  test(`compiled document consumers honor nested ${activeProfile} configuration`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'f330-document-paths-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const packaged = JSON.parse(readFileSync(join(sharedSource, 'deployment-profiles.json'), 'utf8'));
    const defaults = packaged.profiles[packaged.activeProfile];
    const config = {
      schemaVersion: 1,
      activeProfile,
      profiles: {
        home: { ...defaults, roadmapPath: 'docs/team/HOME-ACTIVE.md' },
        opensource: { ...defaults, roadmapPath: 'docs/team/TEAM-ACTIVE.md' },
      },
    };
    const roadmapPath = config.profiles[activeProfile].roadmapPath;
    for (const directory of ['api', 'shared', 'node_modules/@cat-cafe/shared', 'docs/features', 'docs/team']) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    cpSync(join(sharedSource, 'deployment-defaults.ts'), join(root, 'shared/deployment-defaults.ts'));
    writeFileSync(join(root, 'shared/deployment-profiles.json'), JSON.stringify(config));
    writeFileSync(
      join(root, 'node_modules/@cat-cafe/shared/package.json'),
      JSON.stringify({ type: 'module', exports: './index.mjs' }),
    );
    writeFileSync(
      join(root, 'node_modules/@cat-cafe/shared/index.mjs'),
      "export * from '../../../shared/deployment-defaults.ts';\n",
    );
    symlinkSync(dirname(require.resolve('yaml/package.json')), join(root, 'node_modules/yaml'), 'dir');
    for (const file of ['git-doc-reader.js', 'backlog-doc-import.js', 'feat-index-doc-import.js']) {
      cpSync(join(apiRoot, 'dist/routes', file), join(root, 'api', file));
    }
    const table = [
      '| ID | 名称 | Status | Owner | Link |',
      '|----|------|--------|-------|------|',
      '| F123 | Synthetic configured feature | spec | Fixture | |',
    ].join('\n');
    writeFileSync(join(root, roadmapPath), table);
    writeFileSync(join(root, 'docs/OVERRIDE.md'), `${table}\nexplicit override`);
    writeFileSync(
      join(root, 'probe.mjs'),
      `
      import assert from 'node:assert/strict';
      import { readBacklogContent } from './api/git-doc-reader.js';
      import { readFeatIndexEntries } from './api/feat-index-doc-import.js';
      import { buildBacklogInputFromFeature, parseActiveFeaturesFromBacklog } from './api/backlog-doc-import.js';
      const expected = ${JSON.stringify(roadmapPath)};
      assert.match(await readBacklogContent(), /Synthetic configured feature/);
      assert.match(await readBacklogContent('docs/OVERRIDE.md'), /explicit override/);
      const entries = await readFeatIndexEntries();
      assert.equal(entries.find(entry => entry.featId === 'F123')?.name, 'Synthetic configured feature');
      const input = buildBacklogInputFromFeature({id:'F123',name:'Fixture',status:'spec',owner:'Fixture'}, 'fixture-user');
      assert.ok(input.summary.startsWith('来源 ' + expected + ' | '), input.summary);
      assert.throws(() => parseActiveFeaturesFromBacklog('malformed'), error =>
        error.message.startsWith(expected.split('/').at(-1) + ' missing required columns:'));
      assert.throws(() => parseActiveFeaturesFromBacklog('malformed', 'docs/OVERRIDE.md'),
        /OVERRIDE.md missing required columns:/);
      console.log(JSON.stringify({roadmapPath:expected,read:true,explicitOverride:true,featureIndex:true,summary:true}));
    `,
    );
    const output = execFileSync(process.execPath, ['probe.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: root },
    });
    assert.equal(JSON.parse(output).roadmapPath, roadmapPath);
  });
}
