import type { RouteAction, RouteOperation } from './CloudConversationRouteNotice';
import { announceCloudBindingChange } from './cloud-binding-events';
import {
  type BoundConversation,
  bindingIs,
  readThreadCloudRoute,
  type ThreadCloudRouteRead,
  writeThreadCloudRoute,
} from './thread-cloud-route';

type StateUpdate<T> = T | ((current: T) => T);

/** What the controller shows, and whom it tells that a write took effect. */
export interface ThreadRoutePort {
  threadId: string;
  /** This surface, in the change announcements: it does not re-read after its own writes. */
  source: string;
  setRead: (read: ThreadCloudRouteRead) => void;
  setBusy: (busy: 'connect' | 'disconnect' | null) => void;
  setOperation: (operation: StateUpdate<RouteOperation>) => void;
  onLanded: (action: RouteAction) => void;
}

interface PendingWrite {
  action: RouteAction;
  /** The conversation the write asked for; `null` disconnects. */
  conversationId: string | null;
}

const IDLE: RouteOperation = { kind: 'idle' };
const SETTLED_NOTICES: ReadonlySet<RouteOperation['kind']> = new Set(['rejected', 'unconfirmed']);

/**
 * One thread's route and the writes to it, for one surface.
 *
 * One write at a time: a write, or the read that settles it, holds the lock; and a write whose outcome
 * is unknown holds off every other write until a read settles it. Every read and write takes a ticket
 * and only the latest ticket's answer is applied, so a read that began before a write cannot paint over
 * it. A change another surface announces while the lock is held is read once the lock is released; and
 * a write answered after such a change is not taken at its word, since the other write may have landed
 * after it: the route is read back instead.
 */
export class ThreadRouteController {
  private alive = false;
  private ticket = 0;
  private locked = false;
  private pending: PendingWrite | null = null;
  private stale = false;
  private read: ThreadCloudRouteRead = { kind: 'loading' };

  constructor(private readonly port: ThreadRoutePort) {}

  open = (): void => {
    this.alive = true;
    void this.load();
  };

  close = (): void => {
    this.alive = false;
  };

  write = (action: RouteAction, target: BoundConversation | null): void => {
    void this.runWrite(action, target);
  };

  /** Reads the route again; a write whose outcome is unknown is settled by this read. */
  reread = (): void => {
    if (this.locked) return;
    if (this.pending) void this.settle();
    else void this.load({ showLoading: this.read.kind === 'error', afterWrite: true });
  };

  /** Drops the notice of a write that has settled; an unsettled write keeps its notice. */
  dismissOutcome = (): void => {
    this.port.setOperation((current) => (SETTLED_NOTICES.has(current.kind) ? IDLE : current));
  };

  /** Another surface may have changed the binding. */
  heardChange = (): void => {
    if (this.locked) {
      this.stale = true;
      return;
    }
    if (this.pending) {
      void this.settle();
      return;
    }
    // Whatever the last notice said, the route has moved on since: show it as it is now.
    this.dismissOutcome();
    void this.load({ afterWrite: true });
  };

  private show(read: ThreadCloudRouteRead): void {
    this.read = read;
    this.port.setRead(read);
  }

  private release(): void {
    this.locked = false;
    if (!this.stale) return;
    this.stale = false;
    this.heardChange();
  }

  private async load({ showLoading = false, afterWrite = false } = {}): Promise<void> {
    const ticket = ++this.ticket;
    if (showLoading) this.show({ kind: 'loading' });
    const next = await readThreadCloudRoute(this.port.threadId, { afterWrite });
    if (this.alive && ticket === this.ticket) this.show(next);
  }

  private async settle(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.locked = true;
    this.stale = false; // this read starts after every change announced so far
    const ticket = ++this.ticket;
    this.port.setOperation({ kind: 'reconciling', action: pending.action });
    const next = await readThreadCloudRoute(this.port.threadId, { afterWrite: true });
    if (!this.alive || ticket !== this.ticket) return;
    if (next.kind === 'error') {
      this.port.setOperation({ kind: 'unknown', action: pending.action });
    } else {
      this.pending = null;
      this.show(next);
      // The write may have landed without anyone hearing of it: the other surfaces read it again.
      announceCloudBindingChange(this.port.threadId, this.port.source);
      this.conclude(pending, next.kind === 'ready' && bindingIs(next.binding, pending.conversationId));
    }
    this.release();
  }

  private async runWrite(action: RouteAction, target: BoundConversation | null): Promise<void> {
    const current = this.read;
    if (this.locked || this.pending || current.kind !== 'ready') return;
    this.locked = true;
    const ticket = ++this.ticket;
    const pending = { action, conversationId: target?.conversationId ?? null };
    this.pending = pending;
    this.port.setBusy(action === 'disconnect' ? 'disconnect' : 'connect');
    this.port.setOperation(IDLE);
    const outcome = await writeThreadCloudRoute(this.port.threadId, current.catId, target?.chatUrl ?? null);
    if (!this.alive || ticket !== this.ticket) return;
    this.port.setBusy(null);
    // Unknown — or answered while another surface wrote, so the answer may already be stale: read back.
    if (outcome.kind === 'unknown' || (outcome.kind === 'written' && this.stale)) {
      await this.settle();
      return;
    }
    this.pending = null;
    if (outcome.kind === 'refused') {
      this.port.setOperation({ kind: 'rejected', action, reason: outcome.reason });
    } else {
      this.show({ kind: 'ready', catId: current.catId, binding: outcome.binding });
      announceCloudBindingChange(this.port.threadId, this.port.source);
      // The answer is the binding after the write; another write may already have replaced it.
      this.conclude(pending, bindingIs(outcome.binding, pending.conversationId));
    }
    this.release();
  }

  private conclude(pending: PendingWrite, landed: boolean): void {
    this.port.setOperation(landed ? IDLE : { kind: 'unconfirmed', action: pending.action });
    if (landed) this.port.onLanded(pending.action);
  }
}
