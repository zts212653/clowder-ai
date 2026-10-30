import { buildDshPatch } from './dsh-setup-config.js';
import { resolveDshSetupLaunch } from './dsh-setup-launch.js';
import { readDshSetup } from './dsh-setup-service.js';

type Target = { installed: boolean; acp?: { command: string; startupArgs: readonly string[]; transport?: string } };
export type DshRecommendation =
  | { status: 'configured'; sourceProfile: string; revision: string; provider: string; model: string }
  | { status: 'unavailable'; error: string };
const cache = new Map<string, { at: number; value: DshRecommendation }>();
const pending = new Map<string, Promise<DshRecommendation>>();

/** A read-only setup plan, never a model call, credential dump or persistent patch.
 * The user confirms by creating the recommended teammate; prepare rechecks its revision. */
export async function inspectDshRecommendation(
  target: Target,
  cwd: string,
  refresh = false,
): Promise<DshRecommendation> {
  if (!target.installed || !target.acp) return { status: 'unavailable', error: 'dsh_setup_custom_startup' };
  const acp = target.acp;
  if (acp.transport === 'httpstream') return { status: 'unavailable', error: 'dsh_setup_custom_startup' };
  const key = JSON.stringify([acp, cwd, process.env.DSH_HOME, process.env.HOME, process.env.USERPROFILE]);
  const previous = cache.get(key);
  if (!refresh && previous && Date.now() - previous.at < 15_000) return previous.value;
  const running = pending.get(key);
  if (running) return running;
  if (pending.size >= 3) return { status: 'unavailable', error: 'dsh_setup_busy' };
  const probe = (async (): Promise<DshRecommendation> => {
    try {
      const launch = resolveDshSetupLaunch(acp.command, [...acp.startupArgs], cwd);
      const { view, active, source } = await readDshSetup(launch, 'auto');
      if (!view.suggestedSelection) return { status: 'unavailable', error: 'dsh_setup_credential_required' };
      buildDshPatch(active, source, view.suggestedSelection.provider, view.suggestedSelection.model);
      return {
        status: 'configured',
        sourceProfile: view.sourceProfile,
        revision: view.revision,
        ...view.suggestedSelection,
      };
    } catch (error) {
      return {
        status: 'unavailable',
        error: error instanceof Error && /^dsh_[a-z_]+$/.test(error.message) ? error.message : 'dsh_setup_unavailable',
      };
    }
  })()
    .then((value) => {
      const oldest = cache.keys().next().value;
      if (cache.size >= 64 && oldest !== undefined) cache.delete(oldest);
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => pending.delete(key));
  pending.set(key, probe);
  return probe;
}
