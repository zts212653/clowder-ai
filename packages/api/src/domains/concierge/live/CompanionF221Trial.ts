import { randomBytes } from 'node:crypto';
import {
  type HostCompanionReply,
  hostF221Preview,
} from '../../plugin/desktop-window-runtime/companion-private-wire.js';
import { CompanionBridgeError, type CompanionOwnerClient } from './companion-owner-client.js';

interface Context {
  readonly generation: number;
  readonly callId?: string;
}
interface Pending {
  readonly nonce: string;
  readonly proposalId: string;
  readonly digest: string;
  readonly expiresAt: number;
  readonly context: Context;
}

// Isolated confirmation trial. A private native dialog may consume this receipt;
// no producer decision endpoint is reachable from this class.
export class CompanionF221Trial {
  private pending?: Pending;

  constructor(
    private readonly client: CompanionOwnerClient,
    private readonly ownerUserId: string,
    private readonly current: () => Context,
    private readonly now: () => number = Date.now,
  ) {}

  reset(): void {
    this.pending = undefined;
  }

  async inspect(proposalId: string): Promise<HostCompanionReply> {
    this.reset();
    const context = this.current();
    const nonce = randomBytes(24).toString('hex');
    const expiresAt = this.now() + 120_000;
    const preview = await this.read(proposalId, nonce, expiresAt);
    if (!this.sameContext(context) || !this.sameOwner(preview, proposalId))
      throw new CompanionBridgeError('unavailable');
    this.pending = { nonce, proposalId, digest: preview.snapshot.digest, expiresAt, context };
    return preview;
  }

  async confirm(nonce: string, action: 'approve' | 'reject'): Promise<HostCompanionReply> {
    const staged = this.pending;
    if (!staged || staged.nonce !== nonce) return { kind: 'decision-trial', status: 'stale' };
    this.reset(); // A failed read also consumes the one-shot intent.
    if (this.now() > staged.expiresAt || !this.sameContext(staged.context))
      return { kind: 'decision-trial', status: 'stale' };
    try {
      const fresh = await this.read(staged.proposalId, staged.nonce, staged.expiresAt);
      if (
        this.now() > staged.expiresAt ||
        !this.sameContext(staged.context) ||
        !this.sameOwner(fresh, staged.proposalId) ||
        fresh.snapshot.digest !== staged.digest
      )
        return { kind: 'decision-trial', status: 'stale' };
    } catch {
      return { kind: 'decision-trial', status: 'stale' };
    }
    return {
      kind: 'f221-trial-receipt',
      origin: 'host-native-dialog',
      nonce: staged.nonce,
      proposalId: staged.proposalId,
      ownerUserId: this.ownerUserId,
      hostGeneration: staged.context.generation,
      ...(staged.context.callId ? { callId: staged.context.callId } : {}),
      digest: staged.digest,
      action,
      confirmedAt: this.now(),
    };
  }

  private async read(proposalId: string, nonce: string, expiresAt: number) {
    return hostF221Preview.parse({
      kind: 'f221-preview',
      snapshot: {
        ...(await this.client.request(`/api/taste-proposals/${encodeURIComponent(proposalId)}/decision-preview`)),
        nonce,
        expiresAt,
      },
    });
  }

  private sameContext(context: Context): boolean {
    const current = this.current();
    return current.generation === context.generation && current.callId === context.callId;
  }

  private sameOwner(preview: Awaited<ReturnType<CompanionF221Trial['read']>>, proposalId: string): boolean {
    const { snapshot } = preview;
    if (
      snapshot.ownerUserId !== this.ownerUserId ||
      snapshot.proposalId !== proposalId ||
      snapshot.fields.id !== proposalId ||
      snapshot.fields.userId !== this.ownerUserId
    )
      return false;
    try {
      return JSON.parse(snapshot.fields.publication).state === 'anchored';
    } catch {
      return false;
    }
  }
}
