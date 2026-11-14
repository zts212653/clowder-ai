import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRecoveryLoops } from './lib/recovery-loop-contract.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
function readSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readSources(path);
    return entry.name.endsWith('.ts') ? [[relative(root, path), readFileSync(path, 'utf8')]] : [];
  });
}
const registry = JSON.parse(readFileSync(join(root, 'packages/api/src/infrastructure/recovery/registry.json'), 'utf8'));
const result = inspectRecoveryLoops(new Map(readSources(join(root, 'packages/api/src'))), registry.loops);
if (result.pending.length) result.findings.push({ code: 'unfinished-migration', ids: result.pending });
for (const finding of result.findings) console.error(JSON.stringify(finding));
console.log(
  JSON.stringify({
    sites: result.sites.length,
    registered: registry.loops.length,
    pending: result.pending,
    findings: result.findings.length,
  }),
);
process.exitCode = result.findings.length ? 1 : 0;
