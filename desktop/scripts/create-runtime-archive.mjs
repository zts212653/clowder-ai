import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNpmCli } from './rebuild-frozen-dependencies.mjs';

export async function createRuntimeArchive(source, file) {
  if (fs.existsSync(file) || fs.existsSync(file + '.json')) throw new Error('Archive output must be new');
  const nativeClaude = fs
    .readdirSync(source, { recursive: true })
    .find((name) => /(?:^|\/)@anthropic-ai\/claude-agent-sdk-(?:win32|darwin|linux)-/.test(name.replaceAll('\\', '/')));
  if (nativeClaude)
    throw new Error('Claude native runtime must be external; rebuild the frozen deployment before packaging');
  const tar = createRequire(resolveNpmCli())('tar');
  const started = Date.now();
  await tar.c(
    {
      file,
      cwd: source,
      portable: true,
      gzip: { level: 1 },
      jobs: 4,
      follow: false,
    },
    ['.'],
  );
  let entries = 0;
  await tar.t({ file, strict: true, onReadEntry: () => entries++ });
  const sha256 = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) sha256.update(chunk);
  const manifest = {
    archive: path.basename(file),
    bytes: fs.statSync(file).size,
    entries,
    sha256: sha256.digest('hex'),
    elapsedMs: Date.now() - started,
  };
  fs.writeFileSync(file + '.json', JSON.stringify(manifest));
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (error) {
    console.error(`Archive priority: ${error.code}`);
  }
  console.log(JSON.stringify(await createRuntimeArchive(process.argv[2], process.argv[3])));
}
