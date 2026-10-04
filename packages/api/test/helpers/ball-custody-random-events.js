/**
 * Deterministic random ball-custody event sequences.
 *
 * The projector, the replay used by supersession, and any future consumer of the custody state
 * machine must agree on what every event does. These sequences are wide on purpose: every event
 * kind, valid and invalid payloads, `hold_expired` fireAts that match and that do not, and time
 * gaps on both sides of the dead-ball heartbeat grace window.
 */

const CATS = ['cat-a', 'cat-b', 'cat-c'];
const GRACE_MS = 600_000;

/** mulberry32: a tiny, well-known seeded PRNG so a failing sequence can be reproduced from its seed. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, items) => items[Math.floor(random() * items.length)];

function payloadFor(kind, random, context) {
  switch (kind) {
    case 'ball.handed':
      return { toCatId: pick(random, CATS), ...(random() < 0.7 ? { fromCatId: pick(random, CATS) } : {}) };
    case 'ball.handed_cvo':
      return {
        ...(random() < 0.8 ? { fromCatId: pick(random, CATS) } : {}),
        intent: pick(random, ['handoff', 'fyi', 'done_notify', 'bogus']),
      };
    case 'ball.held': {
      const fireAt = context.at + 1000 + Math.floor(random() * 5000);
      context.lastFireAt = fireAt;
      return { catId: pick(random, CATS), ...(random() < 0.9 ? { fireAt } : {}) };
    }
    case 'ball.hold_expired':
      return { fireAt: random() < 0.55 && context.lastFireAt !== undefined ? context.lastFireAt : context.at + 17 };
    case 'ball.wake_condition_met':
      return { taskId: 'task-1', catId: pick(random, CATS) };
    case 'ball.hold_dispositioned':
      return {
        catId: pick(random, CATS),
        sourceMessageId: 'message-1',
        taskId: 'task-1',
        disposition: 'handled',
        retired: random() < 0.4,
      };
    case 'ball.dispatch_dispositioned':
      return {
        catId: pick(random, CATS),
        sourceMessageId: 'message-2',
        fromCatId: pick(random, CATS),
        disposition: 'handled',
      };
    case 'task.blocked':
      return { resolveMode: pick(random, ['bounces_back', 'completes', 'bogus']) };
    case 'invocation.died':
      return random() < 0.5 ? { lastScanAt: context.at - 5 } : {};
    default:
      return {};
  }
}

const KINDS = [
  'ball.handed',
  'ball.handed',
  'ball.handed_cvo',
  'ball.void_pass',
  'ball.held',
  'ball.held',
  'ball.hold_expired',
  'invocation.started',
  'invocation.heartbeat',
  'invocation.heartbeat',
  'invocation.died',
  'task.blocked',
  'task.unblocked',
  'task.idle_long',
  'task.done',
  'ball.wake_sent',
  'ball.wake_condition_met',
  'ball.hold_dispositioned',
  'ball.dispatch_dispositioned',
  'ball.frozen',
  'ball.degraded',
  'ball.abandoned',
];

export function randomEventSequence(seed, { subjectKey = 'ball:thread:thread-1', maxLength = 40 } = {}) {
  const random = seededRandom(seed);
  const length = 1 + Math.floor(random() * maxLength);
  const context = { at: 1_000_000, lastFireAt: undefined };
  const events = [];
  for (let index = 0; index < length; index += 1) {
    // Gaps on both sides of the dead-ball heartbeat grace window.
    context.at += pick(random, [1, 50, 1000, 30_000, GRACE_MS - 1, GRACE_MS, GRACE_MS + 1, 2 * GRACE_MS]);
    const kind = pick(random, KINDS);
    events.push({
      sourceEventId: `${kind}:${seed}:${index}`,
      subjectKey,
      kind,
      classification: kind === 'ball.wake_sent' ? 'informational' : 'state-changing',
      payload: payloadFor(kind, random, context),
      at: context.at,
    });
  }
  return events;
}

export function randomEventSequences(count, firstSeed = 1, options) {
  return Array.from({ length: count }, (_, offset) => randomEventSequence(firstSeed + offset, options));
}
