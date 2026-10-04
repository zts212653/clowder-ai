import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type PageActionPort,
  type PageActionSelector,
  type PageCandidate,
  type PageChoice,
  runPageActionLoop,
} from '../src/domains/concierge/action/PageActionLoop.js';

const open: PageCandidate = {
  id: 'open-note',
  operation: 'click',
  label: 'Open note',
  fingerprint: 'button|open-note|v1',
};
const input: PageCandidate = { id: 'note-input', operation: 'fill', label: 'Note', fingerprint: 'input|note-input|v1' };
const danger: PageCandidate = {
  id: 'delete-note',
  operation: 'click',
  label: 'Delete note',
  fingerprint: 'button|delete-note|v1',
};

function setup(
  choice: PageChoice,
  options: {
    result?: 'applied' | 'stale';
    revision?: string;
    origin?: string;
    url?: string;
    candidateFingerprint?: string;
    afterReadback?: string;
    changeReadback?: boolean;
    readbackFails?: boolean;
  } = {},
) {
  let operations = 0;
  let inspections = 0;
  let readback = 'closed';
  const port: PageActionPort = {
    async inspect() {
      inspections += 1;
      if (options.readbackFails && inspections > 1) throw new Error('browser disconnected');
      return {
        origin: options.origin ?? 'http://127.0.0.1:5227',
        url: options.url ?? 'http://127.0.0.1:5227/',
        readback,
        candidates: [
          options.candidateFingerprint ? { ...open, fingerprint: options.candidateFingerprint } : open,
          input,
          danger,
        ],
      };
    },
    async perform() {
      operations += 1;
      if (options.changeReadback !== false && options.result !== 'stale') readback = options.afterReadback ?? 'open';
      return options.result ?? 'applied';
    },
  };
  const selector: PageActionSelector = {
    async select() {
      return choice;
    },
  };
  return {
    input: {
      utterance: 'Open note',
      grant: {
        origin: 'http://127.0.0.1:5227',
        url: 'http://127.0.0.1:5227/',
        requestRevision: 'r1',
        actions: [
          {
            targetId: 'open-note',
            operation: 'click' as const,
            fingerprint: open.fingerprint,
            expectedReadback: 'open',
          },
        ],
      },
      selector,
      port,
      currentRequestRevision: async () => options.revision ?? 'r1',
    },
    operations: () => operations,
  };
}

test('allowed choice performs an action and reports the page readback', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' });
  const result = await runPageActionLoop(x.input);
  assert.equal(result.status, 'applied');
  assert.equal(result.before, 'closed');
  assert.equal(result.after, 'open');
  assert.equal(x.operations(), 1);
});

test('stale DOM target stops before any claimed effect', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' }, { result: 'stale' });
  const result = await runPageActionLoop(x.input);
  assert.equal(result.status, 'stale');
  assert.equal(x.operations(), 1);
  assert.equal(result.after, undefined);
});

test('user change of mind invalidates the old selection', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' }, { revision: 'r2' });
  assert.equal((await runPageActionLoop(x.input)).status, 'changed_request');
  assert.equal(x.operations(), 0);
});

test('page quote cannot grant a destructive action', async () => {
  const x = setup({ kind: 'act', targetId: danger.id, operation: 'click' });
  assert.equal((await runPageActionLoop(x.input)).status, 'denied');
  assert.equal(x.operations(), 0);
});

test('authorization cannot be widened while the model is selecting', async () => {
  const choice = { kind: 'act' as const, targetId: danger.id, operation: 'click' as const };
  const x = setup(choice);
  x.input.selector.select = async () => {
    x.input.grant.actions.push({ targetId: danger.id, operation: 'click' });
    return choice;
  };
  assert.equal((await runPageActionLoop(x.input)).status, 'denied');
  assert.equal(x.operations(), 0);
});

test('a model cannot replace the exact text authorized for an input', async () => {
  const x = setup({ kind: 'act', targetId: input.id, operation: 'fill', value: 'other text' });
  x.input.grant.actions = [{ targetId: input.id, operation: 'fill', value: 'approved text' }];
  assert.equal((await runPageActionLoop(x.input)).status, 'denied');
  assert.equal(x.operations(), 0);
});

test('a click without observed page change is not success', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' }, { changeReadback: false });
  assert.equal((await runPageActionLoop(x.input)).status, 'no_effect');
});

test('lost readback after a click is an unknown outcome, never a success receipt', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' }, { readbackFails: true });
  assert.equal((await runPageActionLoop(x.input)).status, 'unknown');
  assert.equal(x.operations(), 1);
});

test('an unexpected origin is denied before selection', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' }, { origin: 'https://example.org' });
  assert.equal((await runPageActionLoop(x.input)).status, 'denied');
  assert.equal(x.operations(), 0);
});

test('same-origin page substitution before first inspect cannot reuse a grant', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' }, { url: 'http://127.0.0.1:5227/other' });
  assert.equal((await runPageActionLoop(x.input)).status, 'denied');
  assert.equal(x.operations(), 0);
});

test('a target replaced before first inspect cannot reuse the granted fingerprint', async () => {
  const x = setup(
    { kind: 'act', targetId: open.id, operation: 'click' },
    { candidateFingerprint: 'button|open-note|v2' },
  );
  assert.equal((await runPageActionLoop(x.input)).status, 'stale');
  assert.equal(x.operations(), 0);
});

test('an unrelated readback change does not prove the requested effect', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' }, { afterReadback: 'closed;ticker=1' });
  assert.equal((await runPageActionLoop(x.input)).status, 'unknown');
  assert.equal(x.operations(), 1);
});

test('ask is surfaced without a browser action', async () => {
  const x = setup({ kind: 'ask', reason: 'Ambiguous target' });
  assert.equal((await runPageActionLoop(x.input)).status, 'ask');
  assert.equal(x.operations(), 0);
});

test('a stopped Host generation after selection cannot actuate', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' });
  let current = true;
  x.input.selector.select = async () => {
    current = false;
    return { kind: 'act', targetId: open.id, operation: 'click' };
  };
  const result = await runPageActionLoop({
    ...x.input,
    fence: async () => (current ? 'current' : 'cancelled'),
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(x.operations(), 0);
});

test('lost Host authority after actuation never yields an applied receipt', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' });
  let current = true;
  const originalPerform = x.input.port.perform;
  x.input.port.perform = async (...args) => {
    const result = await originalPerform(...args);
    current = false;
    return result;
  };
  const result = await runPageActionLoop({
    ...x.input,
    fence: async () => (current ? 'current' : 'cancelled'),
  });
  assert.equal(result.status, 'unknown');
  assert.equal(x.operations(), 1);
});

test('navigation after a possible effect is unknown rather than a pre-action stale target', async () => {
  const x = setup({ kind: 'act', targetId: open.id, operation: 'click' });
  const originalInspect = x.input.port.inspect;
  let inspected = 0;
  x.input.port.inspect = async () => {
    const snapshot = await originalInspect();
    inspected++;
    return inspected === 1 ? snapshot : { ...snapshot, url: 'http://127.0.0.1:5227/other' };
  };
  const result = await runPageActionLoop(x.input);
  assert.equal(result.status, 'unknown');
  assert.equal(x.operations(), 1);
});
