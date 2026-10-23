import { basename } from 'node:path';
import { isBuiltinPiBridgeArgs } from '../domains/cats/services/agents/providers/pi/pi-bridge-launch.js';
import { resolveDshSetupLaunch } from './dsh-setup-launch.js';
import { dshLauncherProfileState } from './native-dsh-profile.js';

export type NativeHarnessId = 'codeagent' | 'claudecode' | 'codex' | 'dsh' | 'pi' | 'kimi';
export type NativeCatalogEdition = 'intranet' | 'public';
/** Ordinary tools retain the existing stable role identity mapping. */
export function nativeTool<T extends { id: string }>(runtime: T, harnessId: NativeHarnessId) {
  return { ...runtime, kind: 'tool' as const, harnessId };
}

/** A classification hint only: callers must retain every binding's exact descriptor and grant. */
export function nativeBindingHarness(
  command: string,
  args: readonly string[],
  cwd: string,
): NativeHarnessId | undefined {
  const name = basename(command)
    .replace(/\.(?:cmd|exe|bat|ps1)$/i, '')
    .toLowerCase();
  if (name === 'codeagent' && args.includes('--acp')) return 'codeagent';
  if (name === 'pi-acp' || name === 'clowder-pi-acp') return 'pi';
  if (name === 'node' && isBuiltinPiBridgeArgs([...args])) return 'pi';
  const dsh = dshLauncherProfileState(command, args, cwd);
  if (dsh && dsh !== 'custom_startup') return 'dsh';
  if (dsh === 'custom_startup') {
    try {
      resolveDshSetupLaunch(command, [...args], cwd);
      return 'dsh'; // Classification only; profile readiness and probe policy stay unchanged.
    } catch {
      // Unknown wrappers or unsafe overlays remain unclassified.
    }
  }
  return undefined;
}
