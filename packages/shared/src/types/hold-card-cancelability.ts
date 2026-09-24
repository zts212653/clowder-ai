/**
 * The one rule for whether a hold-ball card may still offer "取消持球".
 *
 * Cancelability had copies. The server owns the canonical answer
 * (`isCancelableHoldBallTask`) and returns it from the hold status endpoint,
 * but a rendered card can only ask that endpoint over the network — so when the
 * probe was unavailable the card fell back to re-deriving the answer from
 * `source.meta.phase`, and that copy was wrong. It treated `wake` and
 * `terminal` as the only terminal phases, while four real producers announce a
 * terminal under `phase:'status'` — launch cancellation, spawn/runner loss,
 * missed wake window, and wake-admission failure — and a fifth marks its
 * terminal with `terminalReceipt` and no phase at all. A finished hold
 * therefore kept live cancel controls on every one of those paths whenever the
 * probe failed.
 *
 * `phase` is a presentation label. It was never a cancelability signal, and
 * widening the set of "terminal phases" would only move the same guess to a
 * new copy. Each producer already knows, at the moment it writes the card,
 * whether the hold it describes can still be canceled — so it states that here
 * and the consumer stops deriving it.
 *
 * A card stating `false` is a durable *local* terminal fact: it remains true
 * with no network, which is why it outranks the probe. The probe stays
 * authoritative only where no card has stated a terminal.
 */

/** What one hold-ball card says about cancelability. */
export type HoldCardCancelability =
  /** The producer stated this hold could still be canceled when it wrote the card. */
  | 'cancelable'
  /** The producer stated this hold had reached terminal. A durable local fact. */
  | 'terminal'
  /** Written before this contract existed. Carries no fact; the probe decides. */
  | 'unstated';

/** Reads the producer-stated fact off one card's `source.meta`. */
export function readHoldCardCancelability(meta: unknown): HoldCardCancelability {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'unstated';
  const stated = (meta as Record<string, unknown>).cancelable;
  if (stated === true) return 'cancelable';
  if (stated === false) return 'terminal';
  return 'unstated';
}

/** One card of a hold, as the timeline sees it. */
export interface HoldCardRef {
  readonly id: string;
  readonly timestamp: number;
  readonly cancelability: HoldCardCancelability;
}

/**
 * Whether one card may render the cancel entry for its hold.
 *
 * `owner` is permission to *ask*: the probe may still revoke it. `revoked` and
 * `not_owner` are both final for that card, but they are different facts and
 * are kept apart so a test can tell "the hold ended" from "another card of the
 * same hold owns the single entry".
 */
export type HoldCancelEntry = 'revoked' | 'owner' | 'not_owner';

/**
 * Every card of one hold, in any order, decides one cancel entry between them.
 *
 * Ownership is the newest card by (timestamp, id). Ties break on the sortable
 * id, so the set always elects exactly one owner: a hold that is still active
 * can never render zero cancel entries, and a hold with several cards can never
 * render two.
 */
export function decideHoldCancelEntry(cardId: string, holdCards: readonly HoldCardRef[]): HoldCancelEntry {
  if (holdCards.some((card) => card.cancelability === 'terminal')) return 'revoked';
  const owner = holdCards.reduce<HoldCardRef | null>((best, card) => {
    if (!best) return card;
    if (card.timestamp !== best.timestamp) return card.timestamp > best.timestamp ? card : best;
    return card.id > best.id ? card : best;
  }, null);
  if (!owner) return 'revoked';
  return owner.id === cardId ? 'owner' : 'not_owner';
}
