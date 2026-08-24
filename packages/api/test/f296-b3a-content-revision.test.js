// F296 B3a hard gate 4 (second half): a producer must bump its revision when
// its content changes.
//
// Why this belongs to the ledger gate: the ledger dedupes on
// `subjectKey + asOf + epoch + presentation`. If a producer rewrites what it
// says while keeping `asOf` fixed, ANY ledger — in-memory, Redis, perfect —
// classifies the new content as already delivered and the cat never sees it.
// A shared persistent ledger without this makes the bug *more* durable.
//
// The fix is structural rather than a rule in a doc: producers derive the
// revision FROM the content, so "content changed but revision did not" is
// unrepresentable. The revision must also stay content-free, because it is a
// ledger-key coordinate and the ledger must never store payload.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { contentRevision } = await import('../dist/domains/cats/services/session/content-revision.js');
const { mapToPresentation } = await import('../dist/domains/cats/services/session/context-presentation.js');
const { mintDeliveryReceipt } = await import('../dist/domains/cats/services/session/delivery-receipt.js');
const { InMemoryPresentationLedgerStore, PresentationLedger } = await import(
  '../dist/domains/cats/services/session/PresentationLedger.js'
);

describe('F296 B3a gate 4: content-derived revision', () => {
  test('identical content yields an identical revision', () => {
    assert.deepEqual(
      contentRevision({ status: 'open', title: 'F296' }),
      contentRevision({ status: 'open', title: 'F296' }),
    );
  });

  test('any content change yields a different revision', () => {
    const base = contentRevision({ status: 'open', title: 'F296' });
    const mutations = [
      { status: 'merged', title: 'F296' },
      { status: 'open', title: 'F297' },
      { status: 'open', title: 'F296', extra: 1 },
      { status: 'open' },
    ];
    for (const mutation of mutations) {
      assert.notDeepEqual(contentRevision(mutation), base, `revision did not move for ${JSON.stringify(mutation)}`);
    }
  });

  test('key order is not content: reordering does not fake a new revision', () => {
    // Otherwise a serializer change would re-present everything in the thread.
    assert.deepEqual(contentRevision({ a: 1, b: 2 }), contentRevision({ b: 2, a: 1 }));
  });

  test('array order IS content', () => {
    assert.notDeepEqual(contentRevision([1, 2]), contentRevision([2, 1]));
  });

  test('whitespace and type differences are real differences', () => {
    assert.notDeepEqual(contentRevision('a b'), contentRevision('a  b'));
    assert.notDeepEqual(contentRevision('1'), contentRevision(1));
    assert.notDeepEqual(contentRevision(null), contentRevision('null'));
  });

  test('the revision is a version-kind SourceRevision', () => {
    const revision = contentRevision({ status: 'open' });
    assert.equal(revision.kind, 'version');
    assert.equal(typeof revision.value, 'string');
    assert.ok(revision.value.length > 0);
  });

  test('the revision is content-free: it cannot leak payload into the ledger key', () => {
    const secret = 'landy-private-note-do-not-store';
    const revision = contentRevision({ body: secret });
    assert.equal(revision.value.includes(secret), false);
    // Fixed width == a digest, not a truncated copy of the payload.
    assert.equal(contentRevision({ body: 'x' }).value.length, revision.value.length);
  });

  // ── kimi review P1-1 (PR #3783) ────────────────────────────────────────────
  // `Object.entries` sees nothing on a Date, a Map or a Set, so every instance
  // collapsed to `{}` and any two of them shared a revision. That is precisely
  // the failure this module exists to make unrepresentable, in its catastrophic
  // direction: new content classified as already delivered, so the cat never
  // sees it. Dates are what a producer most naturally puts in a payload.
  describe('non-plain objects cannot silently collapse', () => {
    test('two different Dates get different revisions', () => {
      assert.notDeepEqual(
        contentRevision({ deadline: new Date(0) }),
        contentRevision({ deadline: new Date(999_999_999_999) }),
      );
    });

    test('equal Dates still agree', () => {
      assert.deepEqual(contentRevision({ deadline: new Date(42) }), contentRevision({ deadline: new Date(42) }));
    });

    test('toJSON is honoured rather than ignored', () => {
      assert.notDeepEqual(contentRevision({ d: { toJSON: () => 'A' } }), contentRevision({ d: { toJSON: () => 'B' } }));
    });

    test('a nested Date inside an array is not flattened away', () => {
      assert.notDeepEqual(contentRevision([new Date(1)]), contentRevision([new Date(2)]));
    });

    // Loud beats silent: a container we cannot canonicalise must throw, because
    // the alternative is a collision the producer will never be told about.
    test('containers with no toJSON are rejected, not silently equal', () => {
      assert.throws(() => contentRevision({ m: new Map([[1, 2]]) }), /content_revision_unsupported/);
      assert.throws(() => contentRevision({ s: new Set([1]) }), /content_revision_unsupported/);
      assert.throws(() => contentRevision({ fn: () => 1 }), /content_revision_unsupported/);
      class Opaque {
        #hidden = 1;
        constructor() {
          void this.#hidden;
        }
      }
      assert.throws(() => contentRevision({ o: new Opaque() }), /content_revision_unsupported/);
    });

    test('a self-referential payload throws instead of hanging', () => {
      const cyclic = { name: 'a' };
      cyclic.self = cyclic;
      assert.throws(() => contentRevision(cyclic), /content_revision_/);
    });

    // JSON.stringify maps every non-finite number to `null`, so NaN, Infinity
    // and an actual null all shared one revision.
    test('non-finite numbers are distinct from null and from each other', () => {
      const revisions = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null].map(
        (value) => contentRevision(value).value,
      );
      assert.equal(new Set(revisions).size, revisions.length);
    });
  });

  test('changed content is admitted again; unchanged content is not', async () => {
    // The end-to-end reason this gate exists.
    const ledger = new PresentationLedger(new InMemoryPresentationLedgerStore(), { now: () => 1_000_000 });
    const scope = { scopeKey: 'user-1::opus5::thread-1', contextEpoch: 3 };
    const invalidator = { owner: 'task-store', ref: 'task-42' };

    const project = (content) =>
      mapToPresentation({
        subjectKey: 'pr:zts212653/cat-cafe#3776',
        asOf: contentRevision(content),
        sourceTier: 'T1',
        invalidator,
        requested: 'state',
      });

    const first = await ledger.reserve(project({ status: 'open' }), scope, { promptGenerationId: 'gen-1' });
    assert.equal(first.admitted, true);
    await ledger.commit(
      first.reservation,
      mintDeliveryReceipt({
        promptGenerationId: 'gen-1',
        providerReceivedAt: 1_700_000_000_000,
        providerAdapterId: 'codex/exec_json',
      }),
    );

    const unchanged = await ledger.reserve(project({ status: 'open' }), scope, { promptGenerationId: 'gen-2' });
    assert.equal(unchanged.admitted, false, 'unchanged content must not be repeated');

    const changed = await ledger.reserve(project({ status: 'merged' }), scope, { promptGenerationId: 'gen-3' });
    assert.equal(changed.admitted, true, 'changed content must reach the cat');
  });
});
