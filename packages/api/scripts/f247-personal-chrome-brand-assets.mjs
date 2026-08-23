#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import sharp from 'sharp';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const monorepoRoot = resolve(apiRoot, '../..');
const sourcePath = join(monorepoRoot, 'packages/web/public/avatars/gpt-pro.png');
const outputDirectory = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension/icons');

export const PERSONAL_CHROME_BRAND_ICON_SIZES = Object.freeze([16, 32, 48, 128]);

export async function renderPersonalChromeBrandIcons(source) {
  const icons = new Map();
  for (const size of PERSONAL_CHROME_BRAND_ICON_SIZES) {
    const bytes = await sharp(source)
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
    icons.set(size, bytes);
  }
  return icons;
}

export async function generatePersonalChromeBrandIcons() {
  const icons = await renderPersonalChromeBrandIcons(await readFile(sourcePath));
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([...icons].map(([size, bytes]) => writeFile(join(outputDirectory, `gpt-pro-${size}.png`), bytes)));
  return { sourcePath, outputDirectory, sizes: [...icons.keys()] };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  generatePersonalChromeBrandIcons()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(
        `F247 Personal ChatGPT Pro brand asset generation failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
      );
      process.exitCode = 1;
    });
}
