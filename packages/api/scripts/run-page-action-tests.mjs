import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';

const syntheticTests = [
  'f317-browser-binary',
  'f317-cdp-page-action-port',
  'f317-current-page-browser',
  'f317-jev-owner-browser',
  'f317-jev-product-journey',
  'f317-live-page-action-browser',
  'f317-live-page-action-host-browser',
  'f317-local-note-connector-browser',
  'f317-local-note-connector-lifecycle',
  'f317-local-note-trial-browser',
  'f317-owner-page-action-service',
  'f317-page-action-browser',
];

export function pageActionTestFiles(ownerLab = false) {
  return [
    ...syntheticTests,
    ...(ownerLab ? ['f317-owner-local-note-lab', 'f317-owner-local-note-simulation'] : []),
  ].map((name) => `test/${name}.test.mjs`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--list', '--owner-lab'].includes(arg))) {
    throw new Error('Usage: run-page-action-tests.mjs [--list] [--owner-lab]');
  }
  const files = pageActionTestFiles(args.includes('--owner-lab'));
  if (args.includes('--list')) {
    console.log(files.join('\n'));
    return;
  }
  await loadChromium(); // Fail before any fixture opens a server when the prerequisite is missing.
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './test/helpers/setup-cat-registry.js',
      '--test',
      '--test-concurrency=1',
      '--test-timeout=60000',
      ...files,
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
