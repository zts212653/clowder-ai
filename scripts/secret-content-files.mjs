import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeGitLocation } from './lib/secret-git-objects.mjs';
import { SECRET_PAYLOAD_MAX_BYTES, scanSecretPayload } from './lib/secret-payload-files.mjs';

/** Scan the frozen export tree, including tests, Markdown fences and binary attachments. */
export async function scanSecretTree(root, report = () => {}) {
  let blocked = false;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      let finding;
      try {
        const content = entry.isSymbolicLink() ? Buffer.from(await readlink(file)) : await boundedFile(file);
        finding = scanSecretPayload(content)[0];
      } catch {
        finding = { ruleId: 'secret_content_uninspectable' };
      }
      if (finding) {
        report({ location: safeGitLocation(relative(root, file)), ...finding });
        blocked = true;
      }
    }
  }
  await walk(root);
  return !blocked;
}

async function boundedFile(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size > SECRET_PAYLOAD_MAX_BYTES) throw new Error('secret_payload_uninspectable');
  return readFile(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = process.argv[2];
    if (!root) throw new Error();
    const clean = await scanSecretTree(root, ({ location, line }) =>
      process.stdout.write(`  Blocked content: ${location}:${line ?? 'uninspectable'}\n`),
    );
    if (!clean) process.exitCode = 1;
  } catch {
    process.stderr.write('secret_scan_unavailable\n');
    process.exitCode = 1;
  }
}
