/**
 * F167 PR-2 review P1 (codex61-sol, PR #5031): a field NAME on the whitelist is not a field VALUE that is safe.
 *
 * The ledger payload is `Record<string, unknown>` and Redis hands it back as a JSON.parse type assertion, so a
 * stored value under an allowed key can be anything. The inspector must say "ids, codes and times" about the VALUES
 * too: a code leaves only if it is one of the codes its event kind defines, an identifier only if it looks like one,
 * a time only if it is a finite number. Anything else is withheld, and the response says it was withheld
 * (`unrecognizedFields`) rather than inventing a state, a terminal or an absence.
 *
 * The reproduction here is a CONSTRUCTED shape (a stored or unknown writer), not an observed production leak.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  A2A_DISPATCH_DISPOSITIONS,
  buildDispatchDispositionEvent,
  buildHandedEvent,
  buildHoldDispositionEvent,
  DISPATCH_TERMINAL_VIAS,
  MANAGED_HOLD_DISPOSITIONS,
  MANAGED_HOLD_RETIRED_REASONS,
} from '../dist/domains/ball-custody/ball-custody-events.js';
import { CustodyEventInspector } from '../dist/domains/ball-custody/CustodyEventInspector.js';

const THREAD = 'thread-values';
const SUBJECT = `ball:thread:${THREAD}`;
const SENTINEL = 'PRIVATE NOTE SENTINEL: arbitrary free text, not a custody code';

function inspectorOver(events, projection = null) {
  return new CustodyEventInspector({
    ballCustodyEventLog: {
      async read(subjectKey) {
        return events.filter((event) => event.subjectKey === subjectKey);
      },
    },
    ballCustodyProjectionStore: {
      async get() {
        return structuredClone(projection);
      },
    },
  });
}

const handed = (messageId = 'src-1') =>
  buildHandedEvent({ threadId: THREAD, fromCatId: 'sonnet', toCatId: 'codex-sol', messageId, at: 1_000 });

const dispatchTerminal = (payload = {}) => {
  const event = buildDispatchDispositionEvent({
    threadId: THREAD,
    catId: 'codex-sol',
    fromCatId: 'sonnet',
    invocationId: 'inv-1',
    sourceMessageId: 'src-1',
    disposition: 'handled',
    via: 'direct',
    at: 2_000,
  });
  return { ...event, payload: { ...event.payload, ...payload } };
};

const holdTerminal = (payload = {}) => {
  const event = buildHoldDispositionEvent({
    threadId: THREAD,
    catId: 'codex-sol',
    invocationId: 'inv-2',
    sourceMessageId: 'src-1',
    taskId: 'task-1',
    disposition: 'completed',
    retired: true,
    retiredReason: 'superseded',
    at: 3_000,
  });
  return { ...event, payload: { ...event.payload, ...payload } };
};

const inspect = (events, projection) =>
  inspectorOver(events, projection).inspect({ threadId: THREAD, sourceMessageId: 'src-1' });

describe('F167 custody event inspector: values, not just keys', () => {
  test('free text under the three code keys is withheld and named, never returned', async () => {
    const result = await inspect([
      handed(),
      dispatchTerminal({ disposition: SENTINEL, via: SENTINEL }),
      holdTerminal({ disposition: SENTINEL, retiredReason: SENTINEL }),
    ]);

    assert.equal(result.status, 'ok');
    assert.equal(JSON.stringify(result).includes('SENTINEL'), false, JSON.stringify(result));
    const [, dispatch, hold] = result.events;
    assert.equal('disposition' in dispatch, false);
    assert.equal('via' in dispatch, false);
    assert.deepEqual(dispatch.unrecognizedFields, ['disposition', 'via']);
    assert.equal('disposition' in hold, false);
    assert.equal('retiredReason' in hold, false);
    assert.deepEqual(hold.unrecognizedFields, ['disposition', 'retiredReason']);
    assert.equal(hold.retired, true, 'the boolean fact next to a withheld reason still reads as it was stored');
  });

  test('a withheld code is not turned into a terminal, an absence or a default', async () => {
    const result = await inspect([handed(), dispatchTerminal({ via: SENTINEL })]);

    const dispatch = result.events[1];
    assert.equal(dispatch.kind, 'ball.dispatch_dispositioned');
    assert.equal(dispatch.disposition, 'handled', 'the legal code beside it is untouched');
    assert.equal('via' in dispatch, false, 'not "direct", not "unknown": the stored value was not a code');
    assert.deepEqual(dispatch.unrecognizedFields, ['via']);
  });

  test('every code its event kind defines still passes through unchanged', async () => {
    for (const disposition of A2A_DISPATCH_DISPOSITIONS) {
      for (const via of DISPATCH_TERMINAL_VIAS) {
        const [, dispatch] = (await inspect([handed(), dispatchTerminal({ disposition, via })])).events;
        assert.equal(dispatch.disposition, disposition);
        assert.equal(dispatch.via, via);
        assert.equal('unrecognizedFields' in dispatch, false, 'nothing was withheld');
      }
    }
    for (const disposition of MANAGED_HOLD_DISPOSITIONS) {
      for (const retiredReason of MANAGED_HOLD_RETIRED_REASONS) {
        const [, hold] = (await inspect([handed(), holdTerminal({ disposition, retiredReason })])).events;
        assert.equal(hold.disposition, disposition);
        assert.equal(hold.retiredReason, retiredReason);
        assert.equal('unrecognizedFields' in hold, false, 'nothing was withheld');
      }
    }
  });

  test('a code under a kind that does not define it is not a code', async () => {
    const stray = { ...handed(), payload: { ...handed().payload, via: 'direct', retiredReason: 'superseded' } };

    const [event] = (await inspect([stray])).events;

    assert.equal(event.kind, 'ball.handed');
    assert.equal('via' in event, false);
    assert.equal('retiredReason' in event, false);
    assert.deepEqual(event.unrecognizedFields, ['retiredReason', 'via']);
  });

  test('identifiers are held to the shape of an identifier: free text with spaces or a runaway length is withheld', async () => {
    const result = await inspect([
      handed(),
      dispatchTerminal({ invocationId: SENTINEL, taskId: 'x'.repeat(201), catId: 'line one\nline two' }),
    ]);

    const dispatch = result.events[1];
    for (const key of ['invocationId', 'taskId', 'catId']) assert.equal(key in dispatch, false, key);
    assert.deepEqual(dispatch.unrecognizedFields, ['catId', 'invocationId', 'taskId']);
    assert.equal(dispatch.fromCatId, 'sonnet', 'a real identifier passes');
    assert.equal(dispatch.sourceMessageId, 'src-1');
    assert.equal(JSON.stringify(result).includes('SENTINEL'), false);
  });

  test('an unknown event kind and a non-numeric time are withheld, and the event keeps its place in the sequence', async () => {
    const odd = { ...dispatchTerminal(), kind: SENTINEL, at: SENTINEL };

    const result = await inspect([handed(), odd, holdTerminal()]);

    assert.deepEqual(
      result.events.map((event) => event.sequence),
      [0, 1, 2],
    );
    assert.equal(result.events[1].kind, 'unrecognized');
    assert.equal(result.events[1].at, null);
    assert.equal(JSON.stringify(result).includes('SENTINEL'), false);
    assert.equal(result.events[2].kind, 'ball.hold_dispositioned', 'its neighbours read as they were stored');
  });

  test('retired and adopted are facts: only `true` / an object read as facts, any other stored value is withheld and named', async () => {
    const result = await inspect([
      handed(),
      dispatchTerminal({ retired: SENTINEL, adopted: SENTINEL }),
      dispatchTerminal({ retired: false }),
      dispatchTerminal({ retired: true, adopted: { adoptedSourceMessageId: 'src-1' } }),
    ]);

    const [, odd, notRetired, facts] = result.events;
    assert.equal('retired' in odd, false);
    assert.equal('adopted' in odd, false);
    assert.deepEqual(odd.unrecognizedFields, ['adopted', 'retired']);
    assert.equal(JSON.stringify(result).includes('SENTINEL'), false);
    assert.equal('retired' in notRetired, false, 'false is simply not retired');
    assert.equal('unrecognizedFields' in notRetired, false, 'and nothing was withheld');
    assert.equal(facts.retired, true);
    assert.equal(facts.adopted, true);
  });

  test('names every object inherits (constructor, toString, __proto__) are not kinds, states or codes', async () => {
    for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const odd = { ...dispatchTerminal({ disposition: inherited }), kind: inherited };
      const projection = {
        subjectKey: SUBJECT,
        state: inherited,
        holder: null,
        lastStateChangeAt: 1,
        lastRejectedEvent: null,
      };

      const result = await inspect([handed(), odd], projection);

      assert.equal(result.events[1].kind, 'unrecognized', inherited);
      assert.equal('disposition' in result.events[1], false, inherited);
      assert.deepEqual(result.projection, { status: 'unavailable', reason: 'projection_malformed' }, inherited);
    }
  });

  test('a payload that is not an object does not break the read', async () => {
    const hollow = { ...dispatchTerminal(), payload: null };

    const result = await inspect([handed(), hollow]);

    assert.equal(result.status, 'ok');
    assert.equal(result.events.length, 2);
    assert.equal(result.events[1].kind, 'ball.dispatch_dispositioned');
  });

  test('a projection holding free text is `unavailable: projection_malformed`, and the events still come back', async () => {
    const good = {
      subjectKey: SUBJECT,
      state: 'active',
      holder: 'codex-sol',
      lastStateChangeAt: 1_000,
      lastRejectedEvent: null,
    };
    const cases = [
      { ...good, state: SENTINEL },
      { ...good, holder: SENTINEL },
      { ...good, lastStateChangeAt: SENTINEL },
      { ...good, lastRejectedEvent: { ...handed(), kind: SENTINEL, at: 5 } },
      { ...good, lastRejectedEvent: { ...handed(), at: SENTINEL } },
    ];
    for (const projection of cases) {
      const result = await inspect([handed()], projection);

      assert.equal(result.status, 'ok');
      assert.equal(result.found, true, 'the ledger is still read');
      assert.deepEqual(result.projection, { status: 'unavailable', reason: 'projection_malformed' });
      assert.equal(JSON.stringify(result).includes('SENTINEL'), false, JSON.stringify(projection));
    }

    const ok = await inspect([handed()], good);
    assert.deepEqual(ok.projection, {
      status: 'ok',
      state: 'active',
      holderCatId: 'codex-sol',
      lastStateChangeAt: 1_000,
      lastRejectedEvent: null,
    });
  });

  test('the Redis shape: a stored event as JSON.parse returns it carries the same protection', async () => {
    const stored = JSON.parse(
      JSON.stringify(dispatchTerminal({ disposition: SENTINEL, via: SENTINEL, invocationId: SENTINEL })),
    );

    const result = await inspect([handed(), stored]);

    assert.equal(JSON.stringify(result).includes('SENTINEL'), false, JSON.stringify(result));
  });
});
