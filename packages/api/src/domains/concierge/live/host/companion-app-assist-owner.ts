import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { IConciergeConfigStore } from '../../ConciergeConfigStore.js';
import { type AppAssistPolicyListener, appAssistAllowed } from '../../concierge-app-assist-store.js';

export const appAssistOwnerCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read') }).strict(),
  z.object({ kind: z.literal('claim'), appKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export interface DesktopAppAssistOwner {
  request(command: unknown): Promise<unknown>;
  watch(listener: AppAssistPolicyListener): Promise<() => Promise<void>>;
  revoke?(): Promise<void>;
}

/** Private desktop capability bound to the original authenticated Concierge owner and execution lease. */
export class CompanionAppAssistOwner implements DesktopAppAssistOwner {
  private watching = false;
  private revoked = false;
  private notify: AppAssistPolicyListener | undefined;
  constructor(
    private readonly options: {
      store: IConciergeConfigStore | undefined;
      ownerUserId: string;
      timeZone: () => string | undefined;
      assertCurrent: () => Promise<void>;
      now?: () => number;
    },
  ) {}

  private day(): string | undefined {
    const zone = this.options.timeZone();
    if (!zone) return undefined;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(this.options.now?.() ?? Date.now());
      const part = (name: string) => parts.find((p) => p.type === name)?.value;
      return `${part('year')}-${part('month')}-${part('day')}`;
    } catch {
      return undefined;
    }
  }

  async request(input: unknown): Promise<unknown> {
    const command = appAssistOwnerCommand.parse(input);
    await this.options.assertCurrent();
    if (!this.watching || this.revoked)
      return command.kind === 'read' ? { status: 'source_unavailable' } : 'unavailable';
    const { store, ownerUserId } = this.options;
    if (!store?.claimAppAssistDay || !store.watchAppAssistPolicy)
      return command.kind === 'read' ? { status: 'source_unavailable' } : 'unavailable';
    if (command.kind === 'claim') {
      const day = this.day();
      if (!day) return 'unavailable';
      const result = await store.claimAppAssistDay(ownerUserId, command.appKey, day);
      await this.options.assertCurrent();
      return this.watching ? result : 'unavailable';
    }
    const config = await (store.getSaved?.(ownerUserId) ?? store.get(ownerUserId));
    await this.options.assertCurrent();
    if (!this.watching) return { status: 'source_unavailable' };
    if (!appAssistAllowed(config)) return { status: 'off' };
    if (!this.day()) return { status: 'timezone_required' };
    return appAssistAllowed(config)
      ? {
          status: 'ready',
          keyScope: createHash('sha256')
            .update(JSON.stringify(['cat-cafe.app-assist.owner.v1', ownerUserId]))
            .digest('hex'),
        }
      : { status: 'off' };
  }

  async watch(listener: AppAssistPolicyListener): Promise<() => Promise<void>> {
    await this.options.assertCurrent();
    this.notify = listener;
    const watch = this.options.store?.watchAppAssistPolicy;
    if (!watch) {
      await listener(null);
      return async () => {};
    }
    let lost = false;
    const dispose = await watch
      .call(this.options.store, this.options.ownerUserId, async (value) => {
        if (value === null) {
          lost = true;
          this.watching = false;
        }
        // Revoking an already-bound owner needs no new affirmative authority.
        // In particular a stalled lease store must never delay a saved opt-out.
        if (value !== true || this.revoked) {
          await listener(this.revoked ? null : value);
          return;
        }
        try {
          await this.options.assertCurrent();
        } catch {
          await listener(null);
          return;
        }
        await listener(value);
      })
      .catch(async () => {
        lost = true;
        this.watching = false;
        await listener(null);
        return async () => {};
      });
    this.watching = !lost && !this.revoked;
    return async () => {
      this.watching = false;
      if (this.notify === listener) this.notify = undefined;
      await dispose();
    };
  }
  async revoke(): Promise<void> {
    this.revoked = true;
    this.watching = false;
    await this.notify?.(null);
  }
}
