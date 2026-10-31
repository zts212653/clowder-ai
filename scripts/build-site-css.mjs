#!/usr/bin/env node
/**
 * Build site/tailwind.css from site/input.css + tailwind.site.config.js.
 *
 * Uses a temp install of tailwindcss + @tailwindcss/typography so the
 * main project lockfile is not polluted. The generated CSS is committed
 * as a reproducible artifact — re-run this script after changing HTML
 * classes or the Tailwind config, then commit the updated tailwind.css.
 *
 * Usage:
 *   node scripts/build-site-css.mjs          # build
 *   node scripts/build-site-css.mjs --check  # verify committed CSS is up-to-date
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const OUT = resolve(ROOT, 'site/tailwind.css');
const CHECK = process.argv.includes('--check');

// Versions pinned for reproducibility
const TW_VERSION = '3.4.17';
const TYPO_VERSION = '0.5.16';

const tmp = mkdtempSync(join(tmpdir(), 'tw-site-'));
try {
  // Install tailwind + typography in isolation
  execSync(
    `npm init -y && npm install --no-audit --no-fund tailwindcss@${TW_VERSION} @tailwindcss/typography@${TYPO_VERSION}`,
    { cwd: tmp, stdio: 'pipe' },
  );

  // Copy config so require() resolves from the temp node_modules
  const configSrc = readFileSync(resolve(ROOT, 'tailwind.site.config.js'), 'utf8');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(tmp, 'tailwind.config.js'), configSrc);

  // Build
  const twBin = join(tmp, 'node_modules/.bin/tailwindcss');
  const inputCss = resolve(ROOT, 'site/input.css');
  const tmpOut = join(tmp, 'tailwind.css');
  execSync(`"${twBin}" -i "${inputCss}" -o "${tmpOut}" --minify --config "${join(tmp, 'tailwind.config.js')}"`, {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, NODE_PATH: join(tmp, 'node_modules'), SITE_ROOT: ROOT },
  });

  const built = readFileSync(tmpOut);

  if (CHECK) {
    let current;
    try {
      current = readFileSync(OUT);
    } catch {
      console.error('site/tailwind.css does not exist. Run: pnpm build:site-css');
      process.exit(1);
    }
    if (!built.equals(current)) {
      console.error(
        'site/tailwind.css is out of date. Run: pnpm build:site-css\n' +
          `  committed: ${current.length} bytes\n` +
          `  expected:  ${built.length} bytes`,
      );
      process.exit(1);
    }
    console.log('site/tailwind.css is up to date.');
  } else {
    writeFileSync(OUT, built);
    console.log(`Built site/tailwind.css (${built.length} bytes)`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
