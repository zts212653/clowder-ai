/**
 * F322 S3-2b-1b: what the 待办 panel may say about an approval after the user pressed a button on its original card.
 *
 * A write's own answer is not the decision's outcome: a 2xx can leave the proposal open (a partly approved F276 selection),
 * a 5xx can land after the side effect, a lost connection says nothing at all, and the Approval Hub store removes an item
 * optimistically before anyone has re-read it. So the panel only ever states what a canonical re-read proved, and that
 * re-read must have started after the write ended (ordered by read generation, not by clocks: the client's and the
 * server's need not agree). The rules, each pinned below:
 *  - a final 401 is "需要登录" and a 403 is "没有权限", only from an explicit status on the attempt in question;
 *  - every other answer, and no answer, is followed by one canonical re-read; the write is never repeated by the panel;
 *  - "已批准/已拒绝" appears only when a settled row for exactly this proposal says so; an item that left the list without
 *    such a row is "已不在当前待办，结果待确认", and one the page cannot vouch for is "结果暂未确认";
 *  - what is not known stays unknown: no default to "已处理", no invented time or decider.
 */
import { describe, expect, it } from 'vitest';
import {
  describeReconcile,
  INITIAL_RECONCILE,
  type ReadEvidence,
  type ReconcileEvent,
  type ReconcileModel,
  reduceReconcile,
  type TrackedAttempt,
} from '../approval-reconcile';

const submitting = (attemptId: number): TrackedAttempt => ({ attemptId, state: { phase: 'submitting' } });
const answered = (attemptId: number, status: number): TrackedAttempt => ({
  attemptId,
  state: { phase: 'response_received', status, ok: status >= 200 && status < 300 },
});
const lost = (attemptId: number): TrackedAttempt => ({ attemptId, state: { phase: 'transport_unknown' } });
const refused = (attemptId: number): TrackedAttempt => ({ attemptId, state: { phase: 'client_validation' } });
const ended = (attemptId: number): TrackedAttempt => ({ attemptId, state: { phase: 'ended' } });

const pendingAligned: ReadEvidence['result'] = { kind: 'present', aligned: true };
const read = (generation: number, over: Partial<ReadEvidence> = {}): ReadEvidence => ({
  generation,
  sameOwner: true,
  result: pendingAligned,
  settled: { kind: 'unavailable' },
  ...over,
});

const run = (events: ReconcileEvent[], from: ReconcileModel = INITIAL_RECONCILE) =>
  events.reduce(reduceReconcile, from);
const attempt = (a: TrackedAttempt | null, readGeneration = 5): ReconcileEvent => ({
  type: 'attempt',
  attempt: a,
  readGeneration,
});
const readEvent = (r: ReadEvidence): ReconcileEvent => ({ type: 'read', read: r });
/** An attempt answered with `a` while reads up to generation 5 had started; the next read the panel starts is 6. */
const afterWrite = (a: TrackedAttempt) => run([attempt(submitting(a.attemptId)), attempt(a)]);

describe('the write itself', () => {
  it('starts idle and says nothing', () => {
    expect(INITIAL_RECONCILE.state).toEqual({ kind: 'idle' });
    expect(describeReconcile(INITIAL_RECONCILE.state)).toMatchObject({ line: null, actions: 'allowed' });
  });

  it('is "writing" while the attempt is under way, with the actions held', () => {
    const model = run([attempt(submitting(1))]);
    expect(model.state).toEqual({ kind: 'writing', attemptId: 1 });
    expect(describeReconcile(model.state)).toMatchObject({ line: '正在提交…', actions: 'held', canReread: false });
  });

  it('ignores no attempt at all and an attempt older than the one it has already followed', () => {
    expect(run([attempt(null)]).state).toEqual({ kind: 'idle' });
    const model = run([attempt(submitting(7)), attempt(submitting(3))]);
    expect(model.state).toEqual({ kind: 'writing', attemptId: 7 });
  });

  it.each([
    401, 403, 500, 200,
  ])('does not let a late %i from an older attempt move the newer attempt that is in flight', (status) => {
    const model = run([attempt(submitting(7)), attempt(answered(3, status))]);
    expect(model.state).toEqual({ kind: 'writing', attemptId: 7 });
    expect(model.seenAttemptId).toBe(7);
    const lostOlder = run([attempt(submitting(7)), attempt(lost(3)), attempt(refused(2))]);
    expect(lostOlder.state).toEqual({ kind: 'writing', attemptId: 7 });
  });

  it('follows a newer attempt that replaces the one in flight', () => {
    const model = run([attempt(submitting(1)), attempt(submitting(2))]);
    expect(model.state).toEqual({ kind: 'writing', attemptId: 2 });
  });

  it('does not act twice on the same answer delivered again', () => {
    const once = afterWrite(answered(1, 500));
    const twice = reduceReconcile(once, attempt(answered(1, 500), 6));
    expect(twice).toEqual(once);
  });
});

describe('what a write answered decides only whether a re-read is needed', () => {
  it('a final 401 is "需要登录": the session is gone, not the permission', () => {
    const model = afterWrite(answered(1, 401));
    expect(model.state).toEqual({ kind: 'needs_login' });
    expect(describeReconcile(model.state)).toMatchObject({ line: '需要登录', actions: 'held', canReread: true });
  });

  it('a 403 is "没有权限"', () => {
    const model = afterWrite(answered(1, 403));
    expect(model.state).toEqual({ kind: 'no_permission' });
    expect(describeReconcile(model.state)).toMatchObject({ line: '没有权限', actions: 'held', canReread: true });
  });

  it.each([
    200, 202, 400, 404, 409, 422, 500, 502, 503,
  ])('a %i is not an outcome: it waits for a canonical re-read started after the write', (status) => {
    const model = afterWrite(answered(1, status));
    expect(model.state).toMatchObject({ kind: 'confirming', attemptId: 1, afterGeneration: 5 });
    expect(describeReconcile(model.state)).toMatchObject({ actions: 'held', canReread: false });
  });

  it('no answer at all is not a "no permission" or a "not sent": it waits for a re-read too', () => {
    const model = afterWrite(lost(1));
    expect(model.state).toMatchObject({ kind: 'confirming', write: { outcome: 'unknown' } });
    expect(describeReconcile(model.state).line).toBe('没有收到回应，正在确认结果…');
  });

  it('says what it is waiting on without claiming a result', () => {
    expect(describeReconcile(afterWrite(answered(1, 200)).state).line).toBe('已提交，正在确认结果…');
    expect(describeReconcile(afterWrite(answered(1, 500)).state).line).toBe('请求返回异常，正在确认结果…');
  });

  it('a card that refused before sending anything says nothing was sent', () => {
    const model = afterWrite(refused(1));
    expect(model.state).toEqual({ kind: 'refused_before_send' });
    expect(describeReconcile(model.state)).toMatchObject({ line: '没有发出，请检查后再试', actions: 'allowed' });
  });
});

describe('only a re-read that started after the write counts', () => {
  const waiting = () => afterWrite(answered(1, 500));

  it('ignores a read that started before or at the write (its generation is not later than the one at write end)', () => {
    expect(reduceReconcile(waiting(), readEvent(read(4))).state.kind).toBe('confirming');
    expect(reduceReconcile(waiting(), readEvent(read(5))).state.kind).toBe('confirming');
  });

  it('accepts the first read that started after it', () => {
    expect(reduceReconcile(waiting(), readEvent(read(6))).state.kind).toBe('still_open');
  });

  it('ignores reads when nothing is waiting for one', () => {
    expect(reduceReconcile(INITIAL_RECONCILE, readEvent(read(9))).state).toEqual({ kind: 'idle' });
    const writing = run([attempt(submitting(1))]);
    expect(reduceReconcile(writing, readEvent(read(9))).state).toEqual({ kind: 'writing', attemptId: 1 });
  });

  it('never lets a read answer for a write that a newer attempt has replaced', () => {
    const replaced = reduceReconcile(waiting(), attempt(submitting(2), 6));
    expect(reduceReconcile(replaced, readEvent(read(7))).state).toEqual({ kind: 'writing', attemptId: 2 });
  });
});

describe('what the canonical re-read proved', () => {
  const confirmingAfter = (a: TrackedAttempt) => afterWrite(a);

  it('still open and aligned with the store: the actions come back, and the line says only what was proved', () => {
    const lines = new Map<number | 'lost', string>([
      [500, '请求返回异常，重新读取后仍待决定'],
      [409, '请求返回异常，重新读取后仍待决定'],
      [200, '已提交，重新读取后仍待决定'],
    ]);
    for (const [status, line] of lines) {
      const model = reduceReconcile(confirmingAfter(answered(1, status as number)), readEvent(read(6)));
      expect(describeReconcile(model.state)).toMatchObject({ line, actions: 'allowed', canReread: true });
    }
    const unknown = reduceReconcile(confirmingAfter(lost(1)), readEvent(read(6)));
    expect(describeReconcile(unknown.state)).toMatchObject({
      line: '没能确认提交结果，重新读取后仍待决定',
      actions: 'allowed',
    });
  });

  it('still open but not aligned with the store: it is open, and the card still cannot be trusted', () => {
    const model = reduceReconcile(
      confirmingAfter(answered(1, 500)),
      readEvent(read(6, { result: { kind: 'present', aligned: false } })),
    );
    expect(model.state).toEqual({ kind: 'unconfirmed', why: 'not_aligned' });
    expect(describeReconcile(model.state)).toMatchObject({
      line: '仍待决定，但和审批中心还没对上',
      actions: 'held',
      canReread: true,
    });
  });

  describe('gone from the list', () => {
    const gone = (over: Partial<ReadEvidence>) =>
      reduceReconcile(
        confirmingAfter(answered(1, 200)),
        readEvent(read(6, { result: { kind: 'absent', exhaustive: true }, ...over })),
      );

    it.each([
      ['accepted', '已批准'],
      ['rejected', '已拒绝'],
      ['closed_without_decision', '已结束，没有做决定'],
    ] as const)('a settled row for this proposal saying %s is the only way to say "%s"', (resolution, text) => {
      const model = gone({ settled: { kind: 'found', terminal: { resolution } } });
      expect(model.state).toEqual({ kind: 'decided', terminal: { resolution } });
      expect(describeReconcile(model.state)).toMatchObject({ line: text, actions: 'gone', canReread: false });
    });

    it('shows the time and the decider only when the settled row carries them, never invented', () => {
      const withMeta = gone({
        settled: {
          kind: 'found',
          terminal: { resolution: 'accepted', decidedAt: Date.UTC(2026, 9, 1, 8, 30), decidedBy: 'You' },
        },
      });
      expect(describeReconcile(withMeta.state).line).toMatch(/^已批准 · .+ · You$/);
      const timeOnly = gone({ settled: { kind: 'found', terminal: { resolution: 'rejected', decidedAt: 1_000_000 } } });
      expect(describeReconcile(timeOnly.state).line).toMatch(/^已拒绝 · [^·]+$/);
      const bare = gone({ settled: { kind: 'found', terminal: { resolution: 'rejected' } } });
      expect(describeReconcile(bare.state).line).toBe('已拒绝');
    });

    it('left the list but no settled row for it: not "已处理", and not "已批准"', () => {
      for (const settled of [{ kind: 'not_found' }, { kind: 'unavailable' }] as const) {
        const model = gone({ settled });
        expect(model.state).toEqual({ kind: 'unconfirmed', why: 'left_the_list' });
        expect(describeReconcile(model.state)).toMatchObject({
          line: '已不在当前待办，结果待确认',
          actions: 'held',
          canReread: true,
        });
      }
    });

    it('the page cannot vouch for absence (partial or more rows than a page): even less is claimed', () => {
      const model = gone({ result: { kind: 'absent', exhaustive: false } });
      expect(model.state).toEqual({ kind: 'unconfirmed', why: 'cannot_tell' });
      expect(describeReconcile(model.state).line).toBe('结果暂未确认');
    });

    it('a settled row found while the page cannot vouch for absence is still a settled row: it decides', () => {
      const model = gone({
        result: { kind: 'absent', exhaustive: false },
        settled: { kind: 'found', terminal: { resolution: 'accepted' } },
      });
      expect(model.state.kind).toBe('decided');
    });
  });

  describe('the read itself failed or is not the same person', () => {
    const outcome = (r: ReadEvidence) => reduceReconcile(confirmingAfter(answered(1, 500)), readEvent(r)).state;

    it('a read that could not be made is "结果暂未确认"', () => {
      expect(outcome(read(6, { result: { kind: 'failed', reason: 'unavailable' } }))).toEqual({
        kind: 'unconfirmed',
        why: 'read_failed',
      });
    });

    it('a read refused for lack of a session is "需要登录"', () => {
      expect(outcome(read(6, { result: { kind: 'failed', reason: 'unauthenticated' } }))).toEqual({
        kind: 'needs_login',
      });
    });

    it('a read made for a different owner proves nothing about this one, whatever it contained', () => {
      const state = outcome(
        read(6, {
          sameOwner: false,
          settled: { kind: 'found', terminal: { resolution: 'accepted' } },
        }),
      );
      expect(state).toEqual({ kind: 'unconfirmed', why: 'cannot_tell' });
    });
  });
});

describe('asking again', () => {
  it('re-reading from an unconfirmed result waits for a read that starts after the request, without writing again', () => {
    const unconfirmed = reduceReconcile(
      afterWrite(answered(1, 500)),
      readEvent(read(6, { result: { kind: 'absent', exhaustive: true } })),
    );
    expect(unconfirmed.state.kind).toBe('unconfirmed');
    const asked = reduceReconcile(unconfirmed, { type: 'reread', readGeneration: 6 });
    expect(asked.state).toMatchObject({ kind: 'confirming', attemptId: 1, afterGeneration: 6 });
    expect(reduceReconcile(asked, readEvent(read(6))).state.kind).toBe('confirming');
    expect(reduceReconcile(asked, readEvent(read(7))).state.kind).toBe('still_open');
  });

  it('re-reading after "需要登录" or "没有权限" is allowed and also writes nothing', () => {
    for (const status of [401, 403]) {
      const asked = reduceReconcile(afterWrite(answered(1, status)), { type: 'reread', readGeneration: 8 });
      expect(asked.state).toMatchObject({ kind: 'confirming', afterGeneration: 8 });
    }
  });

  it('is ignored where there is nothing to re-read about', () => {
    for (const model of [INITIAL_RECONCILE, run([attempt(submitting(1))])]) {
      expect(reduceReconcile(model, { type: 'reread', readGeneration: 9 })).toEqual(model);
    }
  });

  it('a decided approval stays decided', () => {
    const decided = reduceReconcile(
      afterWrite(answered(1, 200)),
      readEvent(
        read(6, {
          result: { kind: 'absent', exhaustive: true },
          settled: { kind: 'found', terminal: { resolution: 'accepted' } },
        }),
      ),
    );
    expect(reduceReconcile(decided, { type: 'reread', readGeneration: 9 })).toEqual(decided);
    expect(reduceReconcile(decided, readEvent(read(10))).state.kind).toBe('decided');
  });
});

/**
 * The events are built from a store record and a wire decode, so what arrives at runtime is not always what the types say.
 * The same rule as the matcher: what cannot be read is not guessed at, and nothing renders as "undefined".
 */
describe('what cannot be read is not guessed at', () => {
  const asAttempt = (attemptId: number, state: unknown): TrackedAttempt => ({ attemptId, state }) as TrackedAttempt;
  const asRead = (over: Record<string, unknown>): ReadEvidence => ({ ...read(6), ...over }) as ReadEvidence;
  const waiting = () => afterWrite(answered(1, 500));

  it('an attempt in a phase this build does not know changes nothing', () => {
    const before = run([attempt(submitting(1))]);
    expect(reduceReconcile(before, attempt(asAttempt(1, { phase: 'some_future_phase' })))).toEqual(before);
    expect(reduceReconcile(INITIAL_RECONCILE, attempt(asAttempt(1, { phase: 'some_future_phase' })))).toEqual(
      INITIAL_RECONCILE,
    );
  });

  it('an attempt with no state at all changes nothing', () => {
    const before = run([attempt(submitting(1))]);
    for (const state of [undefined, null, 'response_received']) {
      expect(reduceReconcile(before, attempt(asAttempt(1, state)))).toEqual(before);
    }
  });

  it.each([
    undefined,
    null,
    '401',
    Number.NaN,
    4.5,
  ])('a response whose status is %s is not a 401 or a 403, and not a claim about who is at fault: it waits for a re-read', (status) => {
    const model = run([
      attempt(submitting(1)),
      attempt(asAttempt(1, { phase: 'response_received', status, ok: false })),
    ]);
    expect(model.state).toMatchObject({ kind: 'confirming', write: { outcome: 'unknown' } });
  });

  it('a settled row whose resolution is not one of the three terminal ones does not decide anything', () => {
    for (const resolution of ['open', 'pending', 'APPROVED', '', undefined, null, 7]) {
      const model = reduceReconcile(
        waiting(),
        readEvent(
          read(6, {
            result: { kind: 'absent', exhaustive: true },
            settled: { kind: 'found', terminal: { resolution } },
          } as unknown as Partial<ReadEvidence>),
        ),
      );
      expect(model.state).toEqual({ kind: 'unconfirmed', why: 'left_the_list' });
    }
  });

  it('a settled row with no terminal at all does not decide anything', () => {
    const model = reduceReconcile(
      waiting(),
      readEvent(asRead({ result: { kind: 'absent', exhaustive: true }, settled: { kind: 'found' } })),
    );
    expect(model.state).toEqual({ kind: 'unconfirmed', why: 'left_the_list' });
  });

  it('a decided time or decider that is not what it should be is left out, not rendered as a value', () => {
    const odd = reduceReconcile(
      waiting(),
      readEvent(
        asRead({
          result: { kind: 'absent', exhaustive: true },
          settled: {
            kind: 'found',
            terminal: { resolution: 'accepted', decidedAt: 'yesterday', decidedBy: { name: 'You' } },
          },
        }),
      ),
    );
    expect(describeReconcile(odd.state).line).toBe('已批准');
    const nan = reduceReconcile(
      waiting(),
      readEvent(
        asRead({
          result: { kind: 'absent', exhaustive: true },
          settled: { kind: 'found', terminal: { resolution: 'accepted', decidedAt: Number.NaN, decidedBy: '   ' } },
        }),
      ),
    );
    expect(describeReconcile(nan.state).line).toBe('已批准');
  });

  it('a read with no result, or a result of a kind this build does not know, is a read that could not be made', () => {
    for (const result of [undefined, null, {}, { kind: 'something_new' }]) {
      const model = reduceReconcile(waiting(), readEvent(asRead({ result })));
      expect(model.state).toEqual({ kind: 'unconfirmed', why: 'read_failed' });
    }
  });

  it('no read evidence at all changes nothing', () => {
    const before = waiting();
    for (const bad of [undefined, null]) {
      expect(reduceReconcile(before, { type: 'read', read: bad } as unknown as ReconcileEvent)).toEqual(before);
    }
  });

  it('a state this build does not know is described without throwing and without a claim', () => {
    const view = describeReconcile({ kind: 'from_the_future' } as never);
    expect(view).toEqual({ line: '结果暂未确认', actions: 'held', canReread: true });
  });

  it('never renders "undefined" in any line, whatever it is handed', () => {
    const states = [
      { kind: 'decided', terminal: { resolution: 'weird' } },
      { kind: 'decided', terminal: {} },
      { kind: 'decided' },
      { kind: 'unconfirmed', why: 'new_reason' },
      { kind: 'confirming', attemptId: 1, write: undefined, afterGeneration: 1 },
      { kind: 'still_open', write: { outcome: 'strange' } },
    ];
    for (const state of states) {
      expect(describeReconcile(state as never).line ?? '').not.toContain('undefined');
    }
  });
});

/**
 * A request that came back with an error is not evidence that nothing was written. A 500 or 503 can be returned after the
 * side effect, and an approval that is still open after a re-read does not rule out a partial write (an F276 selection).
 * So before and after the re-read the line may say the request came back wrong and what the re-read found, and never that
 * the write failed, was not made, or did not take effect. (The first four cases are the reviewer's probes.)
 */
describe('a request error is not proof that nothing was written', () => {
  const NO_FAILURE_CLAIM = /提交没有成功|没能提交|没有生效|没有写入|没成功/;
  const serverError = () => afterWrite(answered(1, 500));
  const presentRead = (generation: number) => read(generation, { result: { kind: 'present', aligned: true } });

  it('does not claim the write failed before any canonical re-read', () => {
    const model = serverError();
    expect(model.state.kind).toBe('confirming');
    expect(describeReconcile(model.state).actions).toBe('held');
    expect(describeReconcile(model.state).line).not.toMatch(NO_FAILURE_CLAIM);
  });

  it('a new aligned pending read proves it is still pending, not that no partial write happened', () => {
    const model = reduceReconcile(serverError(), readEvent(presentRead(6)));
    expect(model.state.kind).toBe('still_open');
    expect(describeReconcile(model.state).line).toContain('仍待决定');
    expect(describeReconcile(model.state).line).not.toMatch(NO_FAILURE_CLAIM);
  });

  it('accepts a real settled decision after a 500 that arrived after its side effect', () => {
    const model = reduceReconcile(
      serverError(),
      readEvent(
        read(6, {
          result: { kind: 'absent', exhaustive: false },
          settled: { kind: 'found', terminal: { resolution: 'accepted' } },
        }),
      ),
    );
    expect(describeReconcile(model.state)).toEqual({ line: '已批准', actions: 'gone', canReread: false });
  });

  it('fences a read that had already started when the newer attempt ended', () => {
    const newer = reduceReconcile(serverError(), attempt(answered(2, 200), 6));
    const staleRead = readEvent(
      read(6, {
        result: { kind: 'absent', exhaustive: true },
        settled: { kind: 'found', terminal: { resolution: 'rejected' } },
      }),
    );
    expect(reduceReconcile(newer, staleRead)).toEqual(newer);
  });

  it.each([
    400, 404, 409, 422, 500, 502, 503,
  ])('a %i never makes the line say the write failed, before or after the re-read', (status) => {
    const waiting = afterWrite(answered(1, status));
    const open = reduceReconcile(waiting, readEvent(presentRead(6)));
    for (const model of [waiting, open]) {
      expect(describeReconcile(model.state).line).not.toMatch(NO_FAILURE_CLAIM);
      expect(describeReconcile(model.state).line).toContain('请求返回异常');
    }
  });

  it('a lost connection and an unreadable status say they could not be confirmed, and no more', () => {
    for (const model of [
      afterWrite(lost(1)),
      run([
        attempt(submitting(1)),
        attempt({ attemptId: 1, state: { phase: 'response_received', status: Number.NaN, ok: false } }),
      ]),
    ]) {
      const open = reduceReconcile(model, readEvent(presentRead(6)));
      for (const m of [model, open]) expect(describeReconcile(m.state).line).not.toMatch(NO_FAILURE_CLAIM);
    }
  });
});

describe('an operation that ended without saying what it saw (a card that reports its own request)', () => {
  const CLAIMS_A_RESPONSE =
    /没有收到回应|收到了回应|已提交|请求返回异常|提交没有成功|没能提交|没有生效|没有写入|没成功/;
  const presentRead = (generation: number) => read(generation, { result: { kind: 'present', aligned: true } });

  it('waits for a re-read and claims neither a response nor the lack of one', () => {
    const model = afterWrite(ended(1));
    expect(model.state).toMatchObject({
      kind: 'confirming',
      attemptId: 1,
      afterGeneration: 5,
      write: { outcome: 'ended' },
    });
    expect(describeReconcile(model.state)).toEqual({
      line: '操作已结束，正在确认结果…',
      actions: 'held',
      canReread: false,
    });
    expect(describeReconcile(model.state).line).not.toMatch(CLAIMS_A_RESPONSE);
  });

  it('a re-read that still lists it says it is still open, in the same neutral words', () => {
    const model = reduceReconcile(afterWrite(ended(1)), readEvent(presentRead(6)));
    expect(model.state).toMatchObject({ kind: 'still_open', write: { outcome: 'ended' } });
    expect(describeReconcile(model.state)).toMatchObject({
      line: '操作已结束，重新读取后仍待决定',
      actions: 'allowed',
      canReread: true,
    });
    expect(describeReconcile(model.state).line).not.toMatch(CLAIMS_A_RESPONSE);
  });

  it('a settled row still decides it', () => {
    const model = reduceReconcile(
      afterWrite(ended(1)),
      readEvent(
        read(6, {
          result: { kind: 'absent', exhaustive: true },
          settled: { kind: 'found', terminal: { resolution: 'accepted' } },
        }),
      ),
    );
    expect(describeReconcile(model.state)).toEqual({ line: '已批准', actions: 'gone', canReread: false });
  });

  it('without a settled row it is not decided, whatever the page says', () => {
    const model = reduceReconcile(
      afterWrite(ended(1)),
      readEvent(read(6, { result: { kind: 'absent', exhaustive: true }, settled: { kind: 'not_found' } })),
    );
    expect(model.state).toEqual({ kind: 'unconfirmed', why: 'left_the_list' });
  });

  it('a re-read the user asks for afterwards keeps the neutral wording', () => {
    const open = reduceReconcile(afterWrite(ended(1)), readEvent(presentRead(6)));
    const again = reduceReconcile(open, { type: 'reread', readGeneration: 7 });
    expect(again.state).toMatchObject({ kind: 'confirming', afterGeneration: 7, write: { outcome: 'ended' } });
    expect(describeReconcile(again.state).line).toBe('操作已结束，正在确认结果…');
  });

  it('is followed from a writing state like any other end, and a read that began before it end is ignored', () => {
    const waiting = afterWrite(ended(1));
    expect(reduceReconcile(waiting, readEvent(presentRead(5)))).toEqual(waiting);
  });

  it('an end for an attempt older than the one followed changes nothing', () => {
    const newer = run([attempt(submitting(2))]);
    expect(reduceReconcile(newer, attempt(ended(1)))).toEqual(newer);
  });
});
