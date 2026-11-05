import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? process.cwd());
const archiveDir = path.join(root, 'bundled', 'archives');
const required = [
  { name: 'node.tar.gz', manifest: false },
  { name: 'deploy-dependencies.tar.gz', manifest: true },
  { name: 'deploy-api.tar.gz', manifest: true },
  { name: 'deploy-web.tar.gz', manifest: true },
  { name: 'deploy-mcp-server.tar.gz', manifest: true },
  { name: 'electron.tar.gz', manifest: true },
];

const failures = [];
const records = [];
for (const item of required) {
  const archivePath = path.join(archiveDir, item.name);
  let archive;
  try {
    archive = fs.statSync(archivePath);
  } catch {
    failures.push(`${item.name}: missing`);
    continue;
  }
  if (!archive.isFile() || archive.size <= 0) failures.push(`${item.name}: empty or not a file`);
  const record = { name: item.name, sizeBytes: archive.size };
  if (item.manifest) {
    const manifestPath = `${archivePath}.json`;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!manifest || manifest.archive !== item.name || manifest.bytes !== archive.size) {
        failures.push(`${item.name}: sidecar does not match archive`);
      }
      record.manifest = manifestPath;
    } catch {
      failures.push(`${item.name}: missing or invalid sidecar`);
    }
  }
  records.push(record);
}

const result = { archiveDir, ok: failures.length === 0, archives: records, failures };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
