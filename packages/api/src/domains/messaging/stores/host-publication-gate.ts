/**
 * F202 W2-5b-0 — the span between a Host message reaching the message store and its publish event
 * reaching the stream, made visible to the catch-up snapshot.
 *
 * WHY THIS EXISTS. The snapshot projects messages from the store and resets the subscriber's cursor
 * to the event head it observed. A package message carries its own output watermark, so the
 * snapshot can tell whether its event is at or before that head. A Host message has no watermark:
 * it is written to the store first and published right after, at the seam in
 * `publishing-message-store.ts`. A snapshot that read the store inside that span would carry the
 * message, and the event appended a moment later would deliver it a second time.
 *
 * The seam opens the span before the store write and closes it after the publish attempt, so there
 * is no instant at which a Host message is in the store with its event still to come and the
 * thread not marked. A snapshot that finishes while its thread is marked treats that exactly like
 * an event appended during the scan: it retries.
 *
 * Process-local on purpose: the span is an in-flight interval of this process, not durable state.
 * A crash inside it leaves a message that will never be published by this seam, and such a
 * message belongs in the snapshot — which is what an unmarked thread after restart gives.
 */
export class HostPublicationGate {
  private readonly inFlight = new Map<string, number>();

  /** Opens a publication span for the thread; the returned function closes it exactly once. */
  begin(threadId: string): () => void {
    this.inFlight.set(threadId, (this.inFlight.get(threadId) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const remaining = (this.inFlight.get(threadId) ?? 1) - 1;
      if (remaining > 0) this.inFlight.set(threadId, remaining);
      else this.inFlight.delete(threadId);
    };
  }

  isBusy(threadId: string): boolean {
    return (this.inFlight.get(threadId) ?? 0) > 0;
  }
}
