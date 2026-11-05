import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));

/** Keep phase/deadline tests independent of the growing repository's copy cost. */
export async function createProfileSource(root) {
  const source = path.join(root, 'profile-source');
  for (const directory of ['desktop', 'scripts', 'assets', 'guides'])
    await fs.mkdir(path.join(source, directory), { recursive: true });
  for (const relative of [
    'docs/harness-feedback/eval-domains/eval-design-gate.yaml',
    'cat-cafe-skills/refs/shared-rules.md',
    'cat-cafe-skills/custody-recognition/SKILL.md',
    'cat-template.json',
    'pnpm-workspace.yaml',
    'package.json',
  ]) {
    const destination = path.join(source, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(repository, relative), destination);
  }
  // Exercise the real startup, materializer, readers, deadline and process
  // cleanup. Only the static input size is reduced; no production method is mocked.
  await fs.writeFile(
    path.join(source, 'desktop/service-manager.js'),
    `module.exports = require(${JSON.stringify(path.join(repository, 'desktop/service-manager.js'))});\n`,
  );
  return source;
}
