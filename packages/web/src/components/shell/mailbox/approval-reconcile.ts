/**
 * F322 S3-2b-1b: what the 待办 panel may say about an approval after the user pressed a button on its original card.
 *
 * A write's own answer is not the decision's outcome. A 2xx can leave the proposal open (a partly approved F276
 * selection), a 5xx can land after the side effect, a lost connection says nothing at all, and the Approval Hub store
 * removes an item optimistically before anyone has re-read it. So the panel states only what a canonical re-read proved,
 * and that re-read must have started after the write ended. "After" is a read generation, not a clock: the client's and the
 * server's clocks need not agree, but the panel knows which of its own reads it started later.
 *
 * Pure on purpose: the events say what the store and the unified read reported, the state says what may be shown, and
 * `describeReconcile` turns the state into the one line and the one rule about the actions. Nothing here defaults to
 * "已处理": what is not known stays unknown.
 */

/** What one write attempt saw: the part of the Approval Hub store's attempt record the reconciler needs. */
export type AttemptEvidence =
  | { phase: 'submitting' }
  | { phase: 'response_received'; status: number; ok: boolean }
  | { phase: 'transport_unknown' }
  /**
   * The card that reports its own request finished and cannot say what it saw: it may have had a 2xx, or it may have stopped
   * on purpose between two requests with nothing answered. Neither "a response came" nor "none came" is a claim it can back.
   */
  | { phase: 'ended' }
  | { phase: 'client_validation' };

export interface TrackedAttempt {
  attemptId: number;
  state: AttemptEvidence;
}

/**
 * What the request looked like when it came back; only used to word the line, never to decide the outcome. `errored` is a
 * request that came back with an error status, which says nothing about whether anything was written: a 500 can be
 * returned after the side effect, and an approval that is still open after a re-read does not rule out a partial write.
 */
export type WriteSeen =
  | { outcome: 'accepted'; status: number }
  | { outcome: 'errored'; status: number }
  | { outcome: 'unknown' }
  | { outcome: 'ended' };

export interface Terminal {
  resolution: 'accepted' | 'rejected' | 'closed_without_decision';
  decidedAt?: number;
  decidedBy?: string;
}

/** The settled lookup: a row for exactly this proposal and producer, or nothing that can be relied on. */
export type SettledLookup = { kind: 'found'; terminal: Terminal } | { kind: 'not_found' } | { kind: 'unavailable' };

export type CanonicalRead =
  /** The item is on the page. `aligned`: the Approval Hub store holds the same decision (see approval-match). */
  | { kind: 'present'; aligned: boolean }
  /** The item is not on the page. `exhaustive`: the page is known to be everything (complete coverage, no more rows). */
  | { kind: 'absent'; exhaustive: boolean }
  | { kind: 'failed'; reason: 'unauthenticated' | 'unavailable' };

export interface ReadEvidence {
  /** The panel's own count of reads started; later reads have larger generations. */
  generation: number;
  /** The read's verified owner is the owner this card was shown to. */
  sameOwner: boolean;
  result: CanonicalRead;
  settled: SettledLookup;
}

export type UnconfirmedWhy = 'left_the_list' | 'cannot_tell' | 'read_failed' | 'not_aligned';

export type ReconcileState =
  | { kind: 'idle' }
  | { kind: 'writing'; attemptId: number }
  | { kind: 'confirming'; attemptId: number; write: WriteSeen; afterGeneration: number }
  | { kind: 'still_open'; write: WriteSeen }
  | { kind: 'decided'; terminal: Terminal }
  | { kind: 'unconfirmed'; why: UnconfirmedWhy }
  | { kind: 'needs_login' }
  | { kind: 'no_permission' }
  | { kind: 'refused_before_send' };

export interface ReconcileModel {
  /** The newest attempt this model has followed; anything older is a stale answer. */
  seenAttemptId: number;
  /** How that attempt ended, kept so a later "read again" can word its result without pretending to know more. */
  lastWrite: WriteSeen | null;
  state: ReconcileState;
}

export const INITIAL_RECONCILE: ReconcileModel = { seenAttemptId: 0, lastWrite: null, state: { kind: 'idle' } };

export type ReconcileEvent =
  /** The store's current attempt for this proposal (null when it has none). `readGeneration`: reads started so far. */
  | { type: 'attempt'; attempt: TrackedAttempt | null; readGeneration: number }
  | { type: 'read'; read: ReadEvidence }
  /** The user asked to read again. `readGeneration`: reads started so far, before the one this asks for. */
  | { type: 'reread'; readGeneration: number };

/**
 * Events are built from a store record and a wire decode, and TypeScript's types do not exist at runtime. So the shapes this
 * module reads are checked on the way in, and what cannot be read is not guessed at: an unknown phase changes nothing, an
 * unreadable status is not a claim about who is at fault, an unreadable read is a read that could not be made, and a settled
 * row only decides when its resolution is one of the three terminal ones.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isHttpStatus = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;

const TERMINAL_RESOLUTIONS: readonly Terminal['resolution'][] = ['accepted', 'rejected', 'closed_without_decision'];

/** A terminal, from a settled row, or null when the row does not say one of the three; the time and decider only if real. */
function readTerminal(value: unknown): Terminal | null {
  if (!isRecord(value)) return null;
  const resolution = TERMINAL_RESOLUTIONS.find((candidate) => candidate === value.resolution);
  if (!resolution) return null;
  const decidedBy = typeof value.decidedBy === 'string' ? value.decidedBy.trim() : '';
  return {
    resolution,
    ...(typeof value.decidedAt === 'number' && Number.isFinite(value.decidedAt) ? { decidedAt: value.decidedAt } : {}),
    ...(decidedBy ? { decidedBy } : {}),
  };
}

function confirmingModel(seenAttemptId: number, write: WriteSeen, afterGeneration: number): ReconcileModel {
  return {
    seenAttemptId,
    lastWrite: write,
    state: { kind: 'confirming', attemptId: seenAttemptId, write, afterGeneration },
  };
}

/** An answer with a status. Only an explicit HTTP status from this attempt says who is at fault; anything else says nothing. */
function answeredModel(seenAttemptId: number, state: Record<string, unknown>, readGeneration: number): ReconcileModel {
  if (!isHttpStatus(state.status)) return confirmingModel(seenAttemptId, { outcome: 'unknown' }, readGeneration);
  const { status } = state;
  const ok = state.ok === true;
  const errored: WriteSeen = { outcome: 'errored', status };
  if (!ok && status === 401) return { seenAttemptId, lastWrite: errored, state: { kind: 'needs_login' } };
  if (!ok && status === 403) return { seenAttemptId, lastWrite: errored, state: { kind: 'no_permission' } };
  return confirmingModel(seenAttemptId, ok ? { outcome: 'accepted', status } : errored, readGeneration);
}

function onAttempt(model: ReconcileModel, attempt: TrackedAttempt | null, readGeneration: number): ReconcileModel {
  if (!isRecord(attempt) || !Number.isInteger(attempt.attemptId) || attempt.attemptId < model.seenAttemptId)
    return model;
  const isNew = attempt.attemptId > model.seenAttemptId;
  // The same attempt, already followed to its end, delivered again: nothing to do. Only "writing" can still move.
  if (!isNew && model.state.kind !== 'writing') return model;
  const seenAttemptId = attempt.attemptId;
  const state: unknown = attempt.state;
  if (!isRecord(state)) return model;

  switch (state.phase) {
    case 'submitting':
      return isNew ? { seenAttemptId, lastWrite: null, state: { kind: 'writing', attemptId: seenAttemptId } } : model;
    case 'client_validation':
      return { seenAttemptId, lastWrite: null, state: { kind: 'refused_before_send' } };
    case 'transport_unknown':
      return confirmingModel(seenAttemptId, { outcome: 'unknown' }, readGeneration);
    case 'ended':
      return confirmingModel(seenAttemptId, { outcome: 'ended' }, readGeneration);
    case 'response_received':
      return answeredModel(seenAttemptId, state, readGeneration);
    default:
      // A phase this build does not know is not followed.
      return model;
  }
}

/** What a read made after the write proved, in order. Another owner's read and an unreadable one prove nothing. */
function outcomeOfRead(read: ReadEvidence, write: WriteSeen): ReconcileState {
  if (read.sameOwner !== true) return { kind: 'unconfirmed', why: 'cannot_tell' };
  const result: unknown = read.result;
  if (!isRecord(result)) return { kind: 'unconfirmed', why: 'read_failed' };
  switch (result.kind) {
    case 'failed':
      return result.reason === 'unauthenticated'
        ? { kind: 'needs_login' }
        : { kind: 'unconfirmed', why: 'read_failed' };
    case 'present':
      return result.aligned === true ? { kind: 'still_open', write } : { kind: 'unconfirmed', why: 'not_aligned' };
    case 'absent': {
      // Not on the page. Only a settled row for exactly this proposal makes it decided; the page alone never does.
      const settled: unknown = read.settled;
      const terminal = isRecord(settled) && settled.kind === 'found' ? readTerminal(settled.terminal) : null;
      if (terminal) return { kind: 'decided', terminal };
      return { kind: 'unconfirmed', why: result.exhaustive === true ? 'left_the_list' : 'cannot_tell' };
    }
    default:
      return { kind: 'unconfirmed', why: 'read_failed' };
  }
}

function onRead(model: ReconcileModel, read: ReadEvidence): ReconcileModel {
  const { state } = model;
  if (state.kind !== 'confirming' || !isRecord(read) || !Number.isFinite(read.generation)) return model;
  // A read that started at or before the write's end says nothing about the write.
  if (read.generation <= state.afterGeneration) return model;
  return { ...model, state: outcomeOfRead(read, state.write) };
}

const REREADABLE = new Set<ReconcileState['kind']>(['unconfirmed', 'needs_login', 'no_permission', 'still_open']);

function onReread(model: ReconcileModel, readGeneration: number): ReconcileModel {
  if (!REREADABLE.has(model.state.kind)) return model;
  const write = model.lastWrite ?? { outcome: 'unknown' as const };
  return {
    ...model,
    state: { kind: 'confirming', attemptId: model.seenAttemptId, write, afterGeneration: readGeneration },
  };
}

export function reduceReconcile(model: ReconcileModel, event: ReconcileEvent): ReconcileModel {
  switch (event.type) {
    case 'attempt':
      return onAttempt(model, event.attempt, event.readGeneration);
    case 'read':
      return onRead(model, event.read);
    case 'reread':
      return onReread(model, event.readGeneration);
  }
}

export interface ReconcileView {
  /** The one line to show under the card, or null when there is nothing to say. */
  line: string | null;
  /**
   * `allowed`: the card may act (the host still asks each time); `held`: the card is shown but writes are locked;
   * `gone`: nothing is left to decide, so the card goes away and the line stands alone.
   */
  actions: 'allowed' | 'held' | 'gone';
  /** Whether "重新读取" is offered. */
  canReread: boolean;
}

const RESOLUTION_TEXT: Record<Terminal['resolution'], string> = {
  accepted: '已批准',
  rejected: '已拒绝',
  closed_without_decision: '已结束，没有做决定',
};

function decidedAtText(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const UNKNOWN_LINE = '结果暂未确认';

function decidedLine(terminal: Terminal): string {
  const resolution = readTerminal(terminal)?.resolution;
  if (!resolution) return UNKNOWN_LINE;
  const parts = [RESOLUTION_TEXT[resolution]];
  const { decidedAt, decidedBy } = readTerminal(terminal) as Terminal;
  if (decidedAt !== undefined) parts.push(decidedAtText(decidedAt));
  if (decidedBy) parts.push(decidedBy);
  return parts.join(' · ');
}

function confirmingLine(write: WriteSeen | undefined): string {
  if (write?.outcome === 'accepted') return '已提交，正在确认结果…';
  if (write?.outcome === 'ended') return '操作已结束，正在确认结果…';
  return write?.outcome === 'errored' ? '请求返回异常，正在确认结果…' : '没有收到回应，正在确认结果…';
}

function stillOpenLine(write: WriteSeen | undefined): string {
  if (write?.outcome === 'accepted') return '已提交，重新读取后仍待决定';
  if (write?.outcome === 'ended') return '操作已结束，重新读取后仍待决定';
  return write?.outcome === 'errored' ? '请求返回异常，重新读取后仍待决定' : '没能确认提交结果，重新读取后仍待决定';
}

const UNCONFIRMED_LINE: Record<UnconfirmedWhy, string> = {
  left_the_list: '已不在当前待办，结果待确认',
  cannot_tell: '结果暂未确认',
  read_failed: '结果暂未确认',
  not_aligned: '仍待决定，但和审批中心还没对上',
};

export function describeReconcile(state: ReconcileState): ReconcileView {
  switch (state.kind) {
    case 'idle':
      return { line: null, actions: 'allowed', canReread: false };
    case 'writing':
      return { line: '正在提交…', actions: 'held', canReread: false };
    case 'confirming':
      return { line: confirmingLine(state.write), actions: 'held', canReread: false };
    case 'still_open':
      return { line: stillOpenLine(state.write), actions: 'allowed', canReread: true };
    case 'decided':
      return { line: decidedLine(state.terminal), actions: 'gone', canReread: false };
    case 'unconfirmed':
      return { line: UNCONFIRMED_LINE[state.why] ?? UNKNOWN_LINE, actions: 'held', canReread: true };
    case 'needs_login':
      return { line: '需要登录', actions: 'held', canReread: true };
    case 'no_permission':
      return { line: '没有权限', actions: 'held', canReread: true };
    case 'refused_before_send':
      return { line: '没有发出，请检查后再试', actions: 'allowed', canReread: false };
    default:
      // A state this build does not know: say nothing it cannot back, and let the user ask again.
      return { line: UNKNOWN_LINE, actions: 'held', canReread: true };
  }
}
