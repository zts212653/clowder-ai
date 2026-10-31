import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../packages/api/package.json', import.meta.url));

export async function loadChromium() {
  // puppeteer-core is already part of the public API package; it does not download a browser.
  const puppeteer = require('puppeteer-core');
  const explicit = process.env.F317_BROWSER_EXECUTABLE_PATH;
  let executablePath;
  try {
    executablePath = explicit ?? puppeteer.executablePath('chrome');
    if (!(await stat(executablePath)).isFile()) throw new Error('not a file');
    await access(executablePath, constants.X_OK);
  } catch (cause) {
    throw new Error('Install Chrome or set F317_BROWSER_EXECUTABLE_PATH to an executable Chrome/Chromium binary', {
      cause,
    });
  }
  return { executablePath: () => executablePath };
}
