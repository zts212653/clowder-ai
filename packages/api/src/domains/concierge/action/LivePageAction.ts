import { createHash } from 'node:crypto';
import { type LiveContextScope, whileNotAborted } from '../live/host/live-controlled-context.js';
import type {
  PageActionFence,
  PageActionFenceState,
  PageActionGrant,
  PageActionPort,
  PageActionResult,
  PageActionSelector,
} from './PageActionLoop.js';
import { runPageActionLoop } from './PageActionLoop.js';

export interface LivePageActionRequest {
  readonly sourceRef: string;
  readonly revision: string;
  readonly text: string;
}

export interface LivePageActionGrant {
  readonly authorityId: string;
  readonly permissionScope: string;
  readonly expiresAtMs: number;
  readonly action: PageActionGrant;
}

/** One immutable request/grant identity, checked against the Host ledger on every fence. */
export interface LivePageActionBinding {
  readonly scope: LiveContextScope;
  readonly request: Readonly<LivePageActionRequest & { textSha256: string }>;
  readonly grant: Readonly<LivePageActionGrant & { actionSha256: string }>;
}

export interface LivePageActionCurrent {
  readonly scope: LiveContextScope;
  readonly request: { sourceRef: string; revision: string; textSha256: string; kind: 'direct_owner' };
  readonly grant: { authorityId: string; permissionScope: string; expiresAtMs: number; actionSha256: string };
}

export interface LivePageActionAdmission {
  readonly scope: LiveContextScope;
  readonly request: LivePageActionRequest;
  readonly grant: LivePageActionGrant;
  readonly signal: AbortSignal;
  /** Read the canonical direct request and grant ledger, not the submitted binding itself. */
  readCurrent(binding: LivePageActionBinding, signal: AbortSignal): Promise<LivePageActionCurrent | null>;
}

export interface LivePageActionPort extends Pick<PageActionPort, 'inspect'> {
  /** Release a per-action browser session after readback or cancellation. */
  close?(): Promise<void>;
  /** The actuator must call fence at its commit point; a preflight alone is insufficient. */
  perform(
    choice: Parameters<PageActionPort['perform']>[0],
    fingerprint: string,
    url: string,
    requestRevision: string,
    fence: PageActionFence,
  ): ReturnType<PageActionPort['perform']>;
}

export interface LivePageActionSelector {
  select(
    input: Parameters<PageActionSelector['select']>[0] & { signal: AbortSignal },
  ): ReturnType<PageActionSelector['select']>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function pageActionGrantSha256(grant: PageActionGrant): string {
  return sha256(
    JSON.stringify({
      origin: grant.origin,
      url: grant.url,
      requestRevision: grant.requestRevision,
      actions: grant.actions.map((action) => ({
        targetId: action.targetId,
        operation: action.operation,
        value: action.value,
        fingerprint: action.fingerprint,
        expectedReadback: action.expectedReadback,
      })),
    }),
  );
}

function snapshot(admission: LivePageActionAdmission): LivePageActionBinding {
  const action: PageActionGrant = Object.freeze({
    origin: admission.grant.action.origin,
    url: admission.grant.action.url,
    requestRevision: admission.grant.action.requestRevision,
    actions: Object.freeze(admission.grant.action.actions.map((entry) => Object.freeze({ ...entry }))),
  });
  const request = Object.freeze({
    sourceRef: admission.request.sourceRef,
    revision: admission.request.revision,
    text: admission.request.text,
    textSha256: sha256(admission.request.text),
  });
  const grant = Object.freeze({
    authorityId: admission.grant.authorityId,
    permissionScope: admission.grant.permissionScope,
    expiresAtMs: admission.grant.expiresAtMs,
    action,
    actionSha256: pageActionGrantSha256(action),
  });
  return Object.freeze({ scope: Object.freeze({ ...admission.scope }), request, grant });
}

function sameScope(left: LiveContextScope, right: LiveContextScope): boolean {
  return (
    left.userId === right.userId &&
    left.threadId === right.threadId &&
    left.catId === right.catId &&
    left.invocationId === right.invocationId &&
    left.callId === right.callId &&
    left.generation === right.generation
  );
}

function sameGrant(left: LivePageActionCurrent['grant'], right: LivePageActionBinding['grant']): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.permissionScope === right.permissionScope &&
    left.expiresAtMs === right.expiresAtMs &&
    left.actionSha256 === right.actionSha256
  );
}

async function whileActionActive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error('Page action stopped');
  const settled = Promise.resolve()
    .then(() => {
      if (signal.aborted) throw new Error('Page action stopped');
      return operation();
    })
    .then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
  const result = await whileNotAborted(signal, settled);
  if (result.kind === 'error') throw result.error;
  return result.value;
}

async function performWithStop(
  signal: AbortSignal,
  operation: () => ReturnType<LivePageActionPort['perform']>,
): ReturnType<LivePageActionPort['perform']> {
  if (signal.aborted) return 'cancelled';
  const work = Promise.resolve().then(() => (signal.aborted ? ('cancelled' as const) : operation()));
  const settled = work.then(
    (value) => ({ kind: 'value' as const, value }),
    () => ({ kind: 'error' as const }),
  );
  try {
    return await whileActionActive(signal, () => work);
  } catch (error) {
    if (!signal.aborted) throw error;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), 100);
    });
    const outcome = await Promise.race([settled, grace]);
    if (timer) clearTimeout(timer);
    if (outcome.kind === 'value' && outcome.value !== 'applied') return outcome.value;
    throw new Error('Page action effect unconfirmed after stop');
  }
}

async function closePort(port: LivePageActionPort): Promise<boolean> {
  if (!port.close) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), 120);
  });
  const completed = Promise.resolve()
    .then(() => port.close?.())
    .then(
      () => true,
      () => false,
    );
  const closed = await Promise.race([completed, deadline]);
  if (timer) clearTimeout(timer);
  return closed;
}

async function readHostCurrent(
  binding: LivePageActionBinding,
  signal: AbortSignal,
  readCurrent: LivePageActionAdmission['readCurrent'],
): Promise<{ kind: 'current'; value: LivePageActionCurrent | null } | { kind: 'cancelled' | 'denied' }> {
  try {
    return { kind: 'current', value: await whileActionActive(signal, () => readCurrent(binding, signal)) };
  } catch {
    return { kind: signal.aborted ? 'cancelled' : 'denied' };
  }
}

function compareHostCurrent(
  current: LivePageActionCurrent | null,
  binding: LivePageActionBinding,
  signal: AbortSignal,
): PageActionFenceState {
  if (signal.aborted || !current || !sameScope(current.scope, binding.scope)) return 'cancelled';
  if (
    current.request.kind !== 'direct_owner' ||
    current.request.sourceRef !== binding.request.sourceRef ||
    current.request.textSha256 !== binding.request.textSha256 ||
    !sameGrant(current.grant, binding.grant) ||
    Date.now() >= binding.grant.expiresAtMs
  )
    return 'denied';
  if (current.request.revision !== binding.request.revision) return 'changed_request';
  return 'current';
}

export async function runLivePageAction(input: {
  admission: LivePageActionAdmission;
  selector: LivePageActionSelector;
  port: LivePageActionPort;
}): Promise<PageActionResult> {
  const binding = snapshot(input.admission);
  const signal = input.admission.signal;
  const readCurrent = input.admission.readCurrent.bind(input.admission);
  let effectPossible = false;
  let result: PageActionResult;
  try {
    const [sourceThreadId, sourceMessageId, extra] = binding.request.sourceRef.split('#');
    if (
      sourceThreadId !== binding.scope.threadId ||
      !sourceMessageId ||
      extra !== undefined ||
      !binding.request.revision ||
      !binding.grant.authorityId ||
      !binding.grant.permissionScope ||
      binding.grant.action.requestRevision !== binding.request.revision ||
      !Number.isFinite(binding.grant.expiresAtMs)
    ) {
      result = { status: 'denied', before: '', reason: 'invalid_action_binding' };
    } else {
      const fence: PageActionFence = async () => {
        if (signal.aborted) return 'cancelled';
        const read = await readHostCurrent(binding, signal, readCurrent);
        if (read.kind !== 'current') return read.kind;
        return compareHostCurrent(read.value, binding, signal);
      };

      result = await runPageActionLoop({
        utterance: binding.request.text,
        grant: binding.grant.action,
        selector: {
          select: (choiceInput) => whileActionActive(signal, () => input.selector.select({ ...choiceInput, signal })),
        },
        fence,
        // The fence reads the Host's authoritative revision at every boundary.
        currentRequestRevision: async () => binding.request.revision,
        port: {
          inspect: () => whileActionActive(signal, () => input.port.inspect()),
          async perform(choice, fingerprint, url, requestRevision) {
            const state = await fence();
            if (state !== 'current') return state;
            effectPossible = true;
            return performWithStop(signal, () => input.port.perform(choice, fingerprint, url, requestRevision, fence));
          },
        },
      });
    }
  } catch {
    result = {
      status: effectPossible ? 'unknown' : signal.aborted ? 'cancelled' : 'unknown',
      before: '',
      reason: 'action_loop_interrupted',
    };
  }
  const closed = await closePort(input.port);
  if (!closed)
    return {
      status: 'unknown',
      before: result.before,
      after: result.after,
      choice: result.choice,
      reason: 'actor_cleanup_unconfirmed',
    };
  if (signal.aborted && effectPossible && result.status === 'applied')
    return { ...result, status: 'unknown', reason: 'stopped_after_effect' };
  return result;
}
