import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { syncBrandManifest } from '../packages/web/scripts/sync-brand-manifest.mjs';
import { appGlobalCssFiles, syncStylesheets } from '../packages/web/scripts/vendor-stylesheets.mjs';

test('native CRLF checkout keeps build inputs and published stylesheet bytes identical to the committed cut', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f330-stylesheet-checkout-'));
  const seed = path.join(root, 'seed');
  const checkout = path.join(root, 'checkout');
  const web = path.join(seed, 'packages/web');
  const xterm = path.join(root, 'xterm.css');
  const brand = { displayName: 'Fixture', shortName: 'Fixture', tagline: 'Source identity fixture' };
  const git = (directory, ...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(path.join(web, 'src/app'), { recursive: true });
  fs.mkdirSync(path.join(seed, 'packages/ui/src'), { recursive: true });
  fs.mkdirSync(path.join(web, 'public'), { recursive: true });
  try {
    fs.copyFileSync(new URL('../.gitattributes', import.meta.url), path.join(seed, '.gitattributes'));
    fs.writeFileSync(path.join(seed, '.gitignore'), 'packages/web/public/vendor/\n');
    for (const file of appGlobalCssFiles)
      fs.writeFileSync(
        path.join(web, 'src/app', file),
        file === 'shell-v2.css' ? '@import "@cat-cafe/ui/styles.css";\n.shell { display: flex; }\n' : `/* ${file} */\n`,
      );
    fs.writeFileSync(path.join(seed, 'packages/ui/src/styles.css'), '.shared { display: flex; }\n');
    fs.writeFileSync(xterm, '.xterm { position: relative; }\n');
    fs.writeFileSync(path.join(web, 'public/manifest.json'), '{}');
    syncBrandManifest(web, brand);
    const expected = syncStylesheets(web, xterm);
    git(seed, 'init', '--initial-branch=main');
    git(seed, 'config', 'core.autocrlf', 'false');
    git(seed, 'add', '.');
    git(
      seed,
      '-c',
      'user.name=codex61-sol',
      '-c',
      'user.email=codex61-sol@cat-cafe.local',
      'commit',
      '-m',
      'fixture: exact LF build inputs',
      '-m',
      'Why: exercise actual Git checkout conversion and production prebuild functions.',
    );
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--config', 'core.autocrlf=true', seed, checkout], {
      stdio: 'pipe',
    });
    assert.equal(git(checkout, 'status', '--porcelain'), '');
    const checkedWeb = path.join(checkout, 'packages/web');
    assert.equal(fs.readFileSync(path.join(checkedWeb, 'src/app/theme-tokens.css'), 'utf8').includes('\r'), false);
    assert.equal(syncBrandManifest(checkedWeb, brand), false);
    assert.deepEqual(syncStylesheets(checkedWeb, xterm), expected);
    assert.equal(
      git(checkout, 'status', '--porcelain', '--untracked-files=all', '--', 'packages'),
      '',
      'real source guard must still observe a clean checkout after prebuild',
    );
    for (const url of expected)
      assert.equal(
        fs.readFileSync(path.join(checkedWeb, 'public', url), 'utf8'),
        fs.readFileSync(path.join(web, 'public', url), 'utf8'),
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
