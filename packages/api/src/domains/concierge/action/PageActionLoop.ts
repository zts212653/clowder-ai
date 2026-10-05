export type PageOperation = 'click' | 'fill';

export interface PageCandidate {
  id: string;
  operation: PageOperation;
  label: string;
  fingerprint: string;
  untrustedContext?: string;
}

export interface PageSnapshot {
  origin: string;
  url: string;
  readback: string;
  candidates: readonly PageCandidate[];
}

export type PageChoice =
  | { kind: 'act'; targetId: string; operation: PageOperation; value?: string }
  | { kind: 'ask' | 'none'; reason: string };

export type PageActionFenceState = 'current' | 'cancelled' | 'changed_request' | 'denied';
export type PageActionFence = () => Promise<PageActionFenceState>;

export interface PageActionGrant {
  origin: string;
  url: string;
  requestRevision: string;
  actions: readonly {
    targetId: string;
    operation: PageOperation;
    value?: string;
    fingerprint: string;
    /** Exact canonical state expected after this action; absent means success cannot be claimed. */
    expectedReadback?: string;
  }[];
}

export interface PageActionPort {
  inspect(): Promise<PageSnapshot>;
  /** Fence the live URL, DOM target and request revision in the actuator task. */
  perform(
    choice: Extract<PageChoice, { kind: 'act' }>,
    fingerprint: string,
    url: string,
    requestRevision: string,
  ): Promise<'applied' | 'stale' | 'changed_request' | 'cancelled' | 'denied'>;
}

export interface PageActionSelector {
  select(input: { utterance: string; candidates: readonly PageCandidate[] }): Promise<PageChoice>;
}

export type PageActionResult = {
  status: 'applied' | 'ask' | 'none' | 'denied' | 'cancelled' | 'changed_request' | 'stale' | 'no_effect' | 'unknown';
  before: string;
  after?: string;
  choice?: PageChoice;
  reason?: string;
};

async function performAndRead(input: {
  port: PageActionPort;
  choice: Extract<PageChoice, { kind: 'act' }>;
  authorized: PageActionGrant['actions'][number];
  grant: PageActionGrant;
  before: PageSnapshot;
  checkFence: PageActionFence;
}): Promise<PageActionResult> {
  const { port, choice, authorized, grant, before, checkFence } = input;
  let performed: Awaited<ReturnType<PageActionPort['perform']>>;
  try {
    performed = await port.perform(choice, authorized.fingerprint, grant.url, grant.requestRevision);
  } catch {
    return { status: 'unknown', before: before.readback, choice, reason: 'perform_unconfirmed' };
  }
  if (performed === 'changed_request' || performed === 'cancelled' || performed === 'denied')
    return { status: performed, before: before.readback, choice };
  if (performed === 'stale') return { status: 'stale', before: before.readback, choice, reason: 'target_changed' };
  if ((await checkFence()) !== 'current')
    return { status: 'unknown', before: before.readback, choice, reason: 'host_authority_lost_after_perform' };

  let after: PageSnapshot;
  try {
    after = await port.inspect();
  } catch {
    return { status: 'unknown', before: before.readback, choice, reason: 'readback_unavailable' };
  }
  if ((await checkFence()) !== 'current')
    return {
      status: 'unknown',
      before: before.readback,
      after: after.readback,
      choice,
      reason: 'host_authority_lost_after_perform',
    };
  if (after.url !== grant.url)
    return {
      status: 'unknown',
      before: before.readback,
      after: after.readback,
      choice,
      reason: 'page_changed_after_perform',
    };
  if (after.readback === before.readback)
    return { status: 'no_effect', before: before.readback, after: after.readback, choice };
  if (authorized.expectedReadback !== after.readback)
    return { status: 'unknown', before: before.readback, after: after.readback, choice, reason: 'effect_unverified' };
  return { status: 'applied', before: before.readback, after: after.readback, choice };
}

export async function runPageActionLoop(input: {
  utterance: string;
  grant: PageActionGrant;
  selector: PageActionSelector;
  port: PageActionPort;
  currentRequestRevision: () => Promise<string>;
  /** Host-owned authority recheck. An actuator must repeat it at its commit point. */
  fence?: PageActionFence;
}): Promise<PageActionResult> {
  const checkFence = async (): Promise<PageActionFenceState> => {
    try {
      return (await input.fence?.()) ?? 'current';
    } catch {
      return 'denied';
    }
  };
  const grant: PageActionGrant = {
    origin: input.grant.origin,
    url: input.grant.url,
    requestRevision: input.grant.requestRevision,
    actions: input.grant.actions.map((action) => ({ ...action })),
  };
  const initialFence = await checkFence();
  if (initialFence !== 'current') return { status: initialFence, before: '', reason: 'host_authority_unavailable' };
  const before = await input.port.inspect();
  const candidates = before.candidates.map((candidate) => ({ ...candidate }));
  const inspectedFence = await checkFence();
  if (inspectedFence !== 'current')
    return { status: inspectedFence, before: before.readback, reason: 'host_authority_unavailable' };
  if (before.origin !== grant.origin) {
    return { status: 'denied', before: before.readback, reason: 'origin_mismatch' };
  }
  if (before.url !== grant.url) {
    return { status: 'denied', before: before.readback, reason: 'resource_not_granted' };
  }

  const choice = await input.selector.select({
    utterance: input.utterance,
    candidates: candidates.map((candidate) => ({ ...candidate })),
  });
  const selectedFence = await checkFence();
  if (selectedFence !== 'current')
    return { status: selectedFence, before: before.readback, choice, reason: 'host_authority_unavailable' };
  if (choice.kind !== 'act') {
    return { status: choice.kind, before: before.readback, choice, reason: choice.reason };
  }

  if ((await input.currentRequestRevision()) !== grant.requestRevision) {
    return { status: 'changed_request', before: before.readback, choice };
  }

  const candidate = candidates.find((item) => item.id === choice.targetId);
  const authorized = grant.actions.find(
    (action) =>
      action.targetId === choice.targetId && action.operation === choice.operation && action.value === choice.value,
  );
  if (!candidate || candidate.operation !== choice.operation || !authorized) {
    return { status: 'denied', before: before.readback, choice, reason: 'action_not_granted' };
  }
  if (candidate.fingerprint !== authorized.fingerprint) {
    return { status: 'stale', before: before.readback, choice, reason: 'target_changed_since_grant' };
  }

  const actionFence = await checkFence();
  if (actionFence !== 'current')
    return { status: actionFence, before: before.readback, choice, reason: 'host_authority_unavailable' };

  return performAndRead({ port: input.port, choice, authorized, grant, before, checkFence });
}
