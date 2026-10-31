import type { CatId } from '@cat-cafe/shared';
import type { AgentService } from '../../types.js';
import type { AgentSessionProvider } from './types.js';

/** Host-owned ports, separate from the portable session protocol. */
export interface HostSessionImplementation extends AgentSessionProvider {
  prepareHostService?(): Promise<AgentService>;
  hostService?(): AgentService | undefined;
  bindHostService?(service: AgentService): AgentSessionProvider | undefined;
  disposeHostService?(): Promise<void>;
}

export type SessionImplementationRef = { builtin: string } | { pluginId: string; contributionId: string };
export function sessionImplementationKey(ref: SessionImplementationRef): string {
  return 'builtin' in ref ? `builtin:${ref.builtin}` : `plugin:${ref.pluginId}/${ref.contributionId}`;
}
type Factory = (ctx: { catId: CatId }) => HostSessionImplementation;
export class SessionImplementationRegistry {
  private readonly factories = new Map<string, { factory: Factory; token: symbol }>();
  register(ref: SessionImplementationRef, factory: Factory): () => void {
    const key = sessionImplementationKey(ref);
    if (this.factories.has(key)) throw new Error(`Duplicate session implementation: ${key}`);
    const entry = { factory, token: Symbol(key) };
    this.factories.set(key, entry);
    return () => {
      if (this.factories.get(key) === entry) this.factories.delete(key);
    };
  }
  resolve(ref: SessionImplementationRef, ctx: { catId: CatId }): HostSessionImplementation | undefined {
    return this.factories.get(sessionImplementationKey(ref))?.factory(ctx);
  }
  has(ref: SessionImplementationRef): boolean {
    return this.factories.has(sessionImplementationKey(ref));
  }
  registrationToken(ref: SessionImplementationRef): symbol | undefined {
    return this.factories.get(sessionImplementationKey(ref))?.token;
  }
}
