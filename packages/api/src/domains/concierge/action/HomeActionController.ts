import type { PageCandidate, PageChoice } from './PageActionLoop.js';

export interface HomeActionRequest {
  readonly messageId: string;
  readonly userId: string;
  readonly callId: string;
  readonly revision: string;
  readonly text: string;
  readonly signal: AbortSignal;
}

/** Opaque owner targets. Labels are model data; they confer no execution authority. */
export interface HomeActionTarget extends Pick<PageCandidate, 'id' | 'label' | 'operation'> {
  readonly revision: string;
}

export type HomeActionNotice = {
  readonly status: 'ask' | 'none' | 'unavailable' | 'stale' | 'blocked';
  readonly reason: string;
};

export type HomeActionResult = {
  readonly requestMessageId: string;
  readonly observedAtMs: number;
  readonly status: 'applied' | 'queued' | 'blocked' | 'unconfirmed' | 'stale' | 'unavailable' | 'ask' | 'none';
  readonly reason?: string;
  readonly jev?: { requestId: string; servedModel: string; inputSha256: string; elapsedMs: number };
};

export interface HomeActionPorts {
  currentRequest(): Promise<HomeActionRequest | null>;
  targets(request: HomeActionRequest): Promise<readonly HomeActionTarget[] | HomeActionNotice>;
  select(request: HomeActionRequest, targets: readonly HomeActionTarget[]): Promise<PageChoice>;
  /** The existing owner performs its final scope/revision check and operation together. */
  execute(
    request: HomeActionRequest,
    target: HomeActionTarget,
    choice: Extract<PageChoice, { kind: 'act' }>,
  ): Promise<Pick<HomeActionResult, 'status' | 'reason'>>;
  record(request: HomeActionRequest, result: HomeActionResult): Promise<void>;
  selectionReceipt?(request: HomeActionRequest): HomeActionResult['jev'];
}

function sameRequest(a: HomeActionRequest, b: HomeActionRequest | null): boolean {
  return Boolean(
    b &&
      !a.signal.aborted &&
      !b.signal.aborted &&
      a.messageId === b.messageId &&
      a.userId === b.userId &&
      a.callId === b.callId &&
      a.revision === b.revision &&
      a.text === b.text,
  );
}

function sameTarget(a: HomeActionTarget, b: HomeActionTarget | undefined): boolean {
  return Boolean(b && a.id === b.id && a.label === b.label && a.operation === b.operation && a.revision === b.revision);
}

/** Per-live-call coalescing only. Message/draft/route owners retain persistence and authority. */
export class HomeActionController {
  private readonly requests = new Map<string, Promise<HomeActionResult>>();
  private closed = false;
  constructor(private readonly ports: HomeActionPorts) {}

  async run(): Promise<HomeActionResult | null> {
    if (this.closed) return null;
    const request = await this.ports.currentRequest();
    if (!request || request.signal.aborted || !request.text.trim()) return null;
    const key = JSON.stringify([request.userId, request.callId, request.messageId, request.revision]);
    const previous = this.requests.get(key);
    if (previous) return previous;
    // A bounded call cache never evicts an executed request and then silently replays it.
    if (this.requests.size >= 64)
      return this.record(request, this.result(request, 'unavailable', 'call_request_capacity'));
    const operation = this.perform(request);
    this.requests.set(key, operation);
    return operation;
  }

  close(): void {
    this.closed = true;
  }

  private result(request: HomeActionRequest, status: HomeActionResult['status'], reason?: string): HomeActionResult {
    return { requestMessageId: request.messageId, observedAtMs: Date.now(), status, ...(reason ? { reason } : {}) };
  }

  private async isCurrent(request: HomeActionRequest): Promise<boolean> {
    return !this.closed && sameRequest(request, await this.ports.currentRequest());
  }

  private async perform(request: HomeActionRequest): Promise<HomeActionResult> {
    let result: HomeActionResult;
    try {
      result = await this.chooseAndExecute(request);
    } catch {
      result = this.result(request, 'unconfirmed', 'home_action_not_confirmed');
    }
    const jev = this.ports.selectionReceipt?.(request);
    return this.record(request, { ...result, ...(jev ? { jev } : {}) });
  }

  private async record(request: HomeActionRequest, result: HomeActionResult): Promise<HomeActionResult> {
    try {
      await this.ports.record(request, result);
    } catch {
      return this.result(request, 'unconfirmed', 'durable_receipt_not_confirmed');
    }
    return result;
  }

  private async chooseAndExecute(request: HomeActionRequest): Promise<HomeActionResult> {
    const discovery = await this.ports.targets(request);
    if (!(await this.isCurrent(request))) return this.result(request, 'stale', 'request_changed');
    if ('status' in discovery) return this.result(request, discovery.status, discovery.reason);
    const targets = discovery;
    if (targets.length > 32 || new Set(targets.map((t) => t.id)).size !== targets.length)
      throw new Error('Invalid owner targets');
    if (!(await this.isCurrent(request))) return this.result(request, 'stale', 'request_changed');
    if (!targets.length) return this.result(request, 'unavailable', 'no_current_owner_targets');
    const choice = await this.ports.select(request, targets);
    if (!(await this.isCurrent(request))) return this.result(request, 'stale', 'request_changed');
    if (choice.kind !== 'act') return this.result(request, choice.kind, choice.reason);
    return this.executeChoice(request, targets, choice);
  }

  private async executeChoice(
    request: HomeActionRequest,
    targets: readonly HomeActionTarget[],
    choice: Extract<PageChoice, { kind: 'act' }>,
  ): Promise<HomeActionResult> {
    const target = targets.find((t) => t.id === choice.targetId);
    if (!target || target.operation !== choice.operation) return this.result(request, 'blocked', 'target_not_offered');
    if (choice.operation === 'fill' && (!choice.value || !request.text.includes(choice.value)))
      return this.result(request, 'blocked', 'value_not_from_owner');
    const currentTargets = await this.ports.targets(request);
    if (
      'status' in currentTargets ||
      !sameTarget(
        target,
        currentTargets.find((t) => t.id === target.id),
      ) ||
      !(await this.isCurrent(request))
    )
      return this.result(request, 'stale', 'target_or_request_changed');
    // Owner ports must fence again after their own IO and immediately before mutation.
    const receipt = await this.ports.execute(request, target, choice);
    return this.result(request, receipt.status, receipt.reason);
  }
}
