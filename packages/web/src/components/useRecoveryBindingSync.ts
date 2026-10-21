'use client';

import { useEffect, useMemo } from 'react';
import { useCloudBindingChanges } from './cloud-binding-events';
import { readBoundConversationId } from './cloud-binding-recovery-operations';

interface Observation {
  ticket: number;
  conversationId: string | null;
}

/**
 * One recovery card identity's knowledge of which conversation is bound, kept true while the thread
 * panel writes the same binding (F202 h3c-1).
 *
 * Every observation of the binding takes a ticket when it starts — a full read of the card, a read of
 * the binding alone, or the card's own write — and a later-started observation is never replaced by an
 * earlier one. A change announced elsewhere is read at once, with a read that starts after any already
 * in flight; except while the card's own write is out, since that read could land before the write
 * does. Then the change is kept, the write's answer is not trusted, and the binding is read once the
 * write is over. A write that ends without an answer is read back too: it may have landed anyway.
 *
 * A session belongs to one identity — thread, message, cat and attempt. Tickets order observations of
 * that identity only: when the card is shown for another, the session ends, and nothing it started — a
 * read of the binding, the answer to its write — reaches the card again.
 */
export class RecoveryBindingSession {
  private live = true;
  private ticket = 0;
  private latest: Observation | null = null;
  private ownWrite: { ticket: number; changedElsewhere: boolean } | null = null;

  constructor(
    private readonly threadId: string,
    private readonly targetCatId: string,
    /** Shows `conversationId` as bound — on this identity's card state only. */
    private readonly show: (conversationId: string | null) => void,
  ) {}

  /** The card shows this identity (again, after a remount). */
  open = (): void => {
    this.live = true;
  };

  /** The card no longer shows this identity: what the session still has in flight goes nowhere. */
  end = (): void => {
    this.live = false;
  };

  /** A full read is starting: its ticket. */
  beginRead = (): number => ++this.ticket;

  /** The binding a full read with this ticket should show: its own, unless a later one has been seen. */
  settleRead = (ticket: number, conversationId: string | null): string | null =>
    this.observe(ticket, conversationId) ? conversationId : (this.latest?.conversationId ?? null);

  /** The card's own write is going out. */
  beginWrite = (): void => {
    if (this.live) this.ownWrite = { ticket: ++this.ticket, changedElsewhere: false };
  };

  /** The card's own write answered that `conversationId` is bound: whether to show that answer. */
  writeLanded = (conversationId: string): boolean => {
    const write = this.ownWrite;
    this.ownWrite = null;
    if (!write) return this.live;
    if (!write.changedElsewhere) return this.observe(write.ticket, conversationId);
    void this.readBinding();
    return false;
  };

  /** The card's operation is over; a write of it that never landed is read back. */
  operationEnded = (): void => {
    const write = this.ownWrite;
    this.ownWrite = null;
    if (write) void this.readBinding();
  };

  /** Another surface announced a change to the binding. */
  heardChange = (): void => {
    if (this.ownWrite) this.ownWrite.changedElsewhere = true;
    else void this.readBinding();
  };

  /** Every reading shown passes here: an ended session shows nothing, however late its reading comes. */
  private observe(ticket: number, conversationId: string | null): boolean {
    if (!this.live || (this.latest && this.latest.ticket > ticket)) return false;
    this.latest = { ticket, conversationId };
    return true;
  }

  /** Every read starts here: an ended session starts none. */
  private async readBinding(): Promise<void> {
    if (!this.live) return;
    const ticket = ++this.ticket;
    const conversationId = await readBoundConversationId(this.threadId, this.targetCatId);
    if (conversationId !== undefined && this.observe(ticket, conversationId)) this.show(conversationId);
  }
}

/**
 * The binding session of the card's current identity: a new one for every identity, ended when the card
 * moves on or unmounts. `show(identityKey, conversationId)` must apply to that identity's state only.
 */
export function useRecoveryBindingSession(args: {
  identityKey: string;
  threadId: string;
  targetCatId: string;
  source: string;
  /** A card that already shows its message as sent reads no binding. */
  listening: boolean;
  show: (identityKey: string, conversationId: string | null) => void;
}): RecoveryBindingSession {
  const { identityKey, threadId, targetCatId, source, listening, show } = args;
  const session = useMemo(
    () => new RecoveryBindingSession(threadId, targetCatId, (conversationId) => show(identityKey, conversationId)),
    [identityKey, threadId, targetCatId, show],
  );
  useEffect(() => {
    session.open();
    return session.end;
  }, [session]);
  useCloudBindingChanges(threadId, source, () => {
    if (listening) session.heardChange();
  });
  return session;
}
