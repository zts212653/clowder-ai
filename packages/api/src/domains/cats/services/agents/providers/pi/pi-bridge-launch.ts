import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCatCafeDataRoot } from '../../../../../../utils/cli-process-ownership.js';
import { piDigest } from './pi-session-store.js';

const ENTRY = fileURLToPath(new URL('./pi-acp-bridge.js', import.meta.url));
/** Shared by the factory and Windows audit: exact entry and argument shape, no arbitrary flags. */
export function isBuiltinPiBridgeArgs(args: string[]): boolean {
  try {
    const [entry, flag, command, ...storage] = args;
    return (
      !!entry &&
      isAbsolute(entry) &&
      realpathSync(entry) === realpathSync(ENTRY) &&
      flag === '--pi-command' &&
      !!command &&
      isAbsolute(command) &&
      (storage.length === 0 ||
        (storage.length === 4 &&
          storage[0] === '--session-root' &&
          !!storage[1] &&
          isAbsolute(storage[1]) &&
          storage[2] === '--session-scope' &&
          /^[a-f0-9]{64}$/.test(storage[3] ?? '')))
    );
  } catch {
    return false;
  }
}

export function piBridgeStorageArgs(
  command: string,
  args: string[],
  identity: string[],
  env: NodeJS.ProcessEnv,
): string[] {
  if (!/^node(?:\.exe)?$/i.test(basename(command)) || !isBuiltinPiBridgeArgs(args)) return args;
  const nativeHome = resolve(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'));
  const scope = piDigest(JSON.stringify([...identity, nativeHome]));
  // Host owns these internal values; disregard any stale scope stored in member startupArgs.
  return [...args.slice(0, 3), '--session-root', resolveCatCafeDataRoot(), '--session-scope', scope];
}
