import type { CapabilitiesConfig } from '@cat-cafe/shared';
import { readCapabilitiesConfigState } from '../config/capabilities/capability-orchestrator.js';

/** Sync may initialize a project, but must never treat unreadable config as empty. */
export async function readMcpSyncConfig(root: string, scope: 'global' | 'project'): Promise<CapabilitiesConfig> {
  const state = await readCapabilitiesConfigState(root);
  if (state.kind === 'present') return state.config;
  if (state.kind === 'absent' && scope === 'project') return { version: 2, capabilities: [] };
  const reason = state.kind === 'unreadable' ? `${state.cause}${state.errno ? ` (${state.errno})` : ''}` : state.kind;
  throw new Error(`Cannot synchronize ${scope} capabilities at ${state.path}: ${reason}`);
}
