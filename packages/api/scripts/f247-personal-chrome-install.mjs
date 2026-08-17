#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  inspectNativeHostInstallation,
  installNativeHost,
  uninstallNativeHost,
} from '../src/plugins/cloud-cat-personal-host/native-host/install-host.mjs';
import { extensionIdFromManifestKey } from './f247-personal-chrome-live-contract.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const monorepoRoot = resolve(apiRoot, '../..');
const extensionRoot = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension');

export async function runPersonalChromeInstall({ action = 'install', projectRoot, env = process.env } = {}) {
  const resolvedProjectRoot = projectRoot ?? env.CAT_CAFE_CONFIG_ROOT?.trim() ?? monorepoRoot;
  const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
  const extensionId = extensionIdFromManifestKey(manifest.key);
  const options = { projectRoot: resolvedProjectRoot };
  let result;
  if (action === 'install') result = await installNativeHost({ ...options, extensionId });
  else if (action === 'inspect') result = await inspectNativeHostInstallation(options);
  else if (action === 'uninstall') result = await uninstallNativeHost(options);
  else throw new Error('action must be install, inspect, or uninstall');
  return { ...result, extensionRoot };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runPersonalChromeInstall({ action: process.argv[2] ?? 'install' })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(
        `F247 personal Chrome install failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
      );
      process.exitCode = 1;
    });
}
