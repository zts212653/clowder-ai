import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoverCliExecutionStop } from '../utils/cli-execution-stop-recovery.js';
import {
  parseCliExecutionOwnerRef,
  parseCliProcessOwnerManifest,
  resolveCatCafeDataRoot,
} from '../utils/cli-process-ownership.js';

function readInput(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Recovery input could not be read as JSON');
  }
}

// Operator recovery, preview by default. The original manifest and exact scope must
// come from retained evidence; this command cannot recreate missing historical identity.
function main(args: string[]): void {
  const allowed = new Set(['--manifest', '--expected-scope', '--data-dir', '--apply']);
  const flags = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag) || flags.has(flag) || (flag === '--apply' && apply)) throw new Error('Invalid arguments');
    if (flag === '--apply') {
      apply = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    flags.set(flag, value);
  }
  const manifestPath = flags.get('--manifest');
  const scopePath = flags.get('--expected-scope');
  const dataDir = flags.get('--data-dir');
  if (!manifestPath || !scopePath || !dataDir)
    throw new Error(
      'Usage: recover-cli-execution-stop --manifest FILE --expected-scope FILE --data-dir ROOT [--apply]',
    );
  const manifest = parseCliProcessOwnerManifest(readInput(manifestPath));
  const expected = parseCliExecutionOwnerRef(readInput(scopePath));
  if (!manifest || !expected) throw new Error('Invalid original manifest or exact expected scope');
  const dataRoot = resolveCatCafeDataRoot(dataDir);
  const result = recoverCliExecutionStop({
    record: { path: join(dataRoot, 'cli-process-owners', `${manifest.ownerId}.json`), manifest },
    expected,
    dataDir: dataRoot,
    apply,
  });
  console.log(JSON.stringify({ ...result, execution: expected }));
  if (!result.verified) process.exitCode = 2;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Stop evidence recovery failed');
  process.exitCode = 1;
}
