import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';

test('an explicit browser binary is used without the private Playwright package', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'f317-browser-binary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'chromium');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);
  const previous = process.env.F317_BROWSER_EXECUTABLE_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.F317_BROWSER_EXECUTABLE_PATH;
    else process.env.F317_BROWSER_EXECUTABLE_PATH = previous;
  });
  process.env.F317_BROWSER_EXECUTABLE_PATH = binary;
  assert.equal((await loadChromium()).executablePath(), binary);
  process.env.F317_BROWSER_EXECUTABLE_PATH = join(dir, 'absent');
  await assert.rejects(loadChromium(), /F317_BROWSER_EXECUTABLE_PATH/);
  process.env.F317_BROWSER_EXECUTABLE_PATH = dir;
  await assert.rejects(loadChromium(), /F317_BROWSER_EXECUTABLE_PATH/);
});
