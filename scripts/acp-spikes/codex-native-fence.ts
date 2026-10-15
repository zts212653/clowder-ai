/** W4.P only: caller-owned native fence, plugged into the fixed upstream bridge. */
import { type ControlIntent, ControlJournal, controlKey, digest, nativeClientId } from './codex-control-journal.js';
export interface TextPrompt {
  type: 'text';
  text: string;
}
export interface NativeCodexBridge {
  steerTurn(params: {
    threadId: string;
    turnId: string;
    prompt: TextPrompt[];
    clientUserMessageId?: string;
  }): Promise<{ turnId: string }>;
  readUserMessage?(params: { threadId: string; turnId: string; clientUserMessageId: string }): Promise<{
    nativeSessionId: string;
    nativeTurnId: string;
    nativeItemId: string;
    clientUserMessageId: string;
    prompt: TextPrompt[];
  } | null>;
}
interface Snapshot {
  sessionId: string;
  currentTurnId: string | null;
}
export class CodexNativeFence {
  private readonly operations = new Map<string, { signature: string; receipt: Promise<Record<string, unknown>> }>();
  private readonly journal?: ControlJournal;
  constructor(
    private readonly snapshot: (sessionId: string) => Snapshot,
    private readonly bridge: NativeCodexBridge,
    private readonly options?: { journalDirectory: string; bindingRevision: string },
  ) {
    if (options) this.journal = new ControlJournal(options.journalDirectory);
  }
  async handle(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof params['sessionId'] !== 'string' || !params['sessionId']) throw new Error('invalid_session');
    const state = this.snapshot(params['sessionId']);
    if (params['action'] === 'snapshot')
      return {
        nativeSessionId: state.sessionId,
        nativeTurnId: state.currentTurnId,
        source: 'native_turn_start_callback',
        ...(this.options ? { bindingRevision: this.options.bindingRevision } : {}),
      };
    if (
      (params['action'] !== 'steer' && params['action'] !== 'receipt') ||
      params['nativeSessionId'] !== state.sessionId ||
      (this.options && params['bindingRevision'] !== this.options.bindingRevision) ||
      typeof params['expectedTurnId'] !== 'string' ||
      !params['expectedTurnId'] ||
      typeof params['operationId'] !== 'string' ||
      !params['operationId']
    )
      throw new Error('invalid_native_target');
    const key = controlKey(this.options?.bindingRevision ?? 'process-local', state.sessionId, params['operationId']);
    if (params['action'] === 'receipt') {
      if (!this.journal) throw new Error('durable_receipts_unsupported');
      const intent = await this.journal.read(key);
      if (intent && intent.nativeTurnId !== params['expectedTurnId']) throw new Error('operation_conflict');
      return this.reconcile(key, intent, params['operationId'], state.sessionId, params['expectedTurnId']);
    }
    const prompt = params['prompt'];
    if (
      !Array.isArray(prompt) ||
      !prompt.length ||
      !prompt.every((item) => item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
    )
      throw new Error('invalid_prompt');
    const nativeSessionId = state.sessionId;
    const expectedTurnId = params['expectedTurnId'];
    const operationId = params['operationId'];
    // Snapshot caller content before any persistence await. Later mutation cannot change the native input.
    const capturedPrompt = prompt.map((item) => ({ type: 'text' as const, text: item.text as string }));
    const signature = digest([params['nativeSessionId'], params['expectedTurnId'], capturedPrompt]);
    const prior = this.operations.get(key);
    if (prior) {
      if (prior.signature !== signature) throw new Error('operation_conflict');
      return structuredClone(await prior.receipt);
    }
    // Never replace the caller target with the current turn, even after an await.
    const receipt = (async () => {
      const intent: ControlIntent = {
        operationId,
        nativeSessionId,
        nativeTurnId: expectedTurnId,
        bindingRevision: this.options?.bindingRevision ?? 'process-local',
        clientUserMessageId: nativeClientId(key),
        signature,
        promptHash: digest(capturedPrompt),
      };
      if (this.journal && !(await this.journal.claim(key, intent))) {
        const prior = await this.journal.read(key);
        if (prior && prior.signature !== signature) throw new Error('operation_conflict');
        return this.reconcile(key, prior, operationId, nativeSessionId, expectedTurnId);
      }
      const native = await this.bridge.steerTurn({
        threadId: nativeSessionId,
        turnId: expectedTurnId,
        prompt: capturedPrompt,
        ...(this.journal ? { clientUserMessageId: intent.clientUserMessageId } : {}),
      });
      if (native.turnId !== expectedTurnId) throw new Error('native_receipt_target_mismatch');
      const result = {
        operationId,
        nativeSessionId,
        nativeTurnId: native.turnId,
        outcome: 'injected',
        nativeReceipt: structuredClone(native),
      };
      if (this.journal) await this.journal.save(key, { ...intent, receipt: result });
      return result;
    })();
    this.operations.set(key, { signature, receipt });
    return structuredClone(await receipt);
  }
  private async reconcile(
    key: string,
    intent: ControlIntent | null,
    operationId: string,
    nativeSessionId: string,
    nativeTurnId: string,
  ): Promise<Record<string, unknown>> {
    const unknown = { operationId, nativeSessionId, nativeTurnId, outcome: 'outcome_unknown' };
    if (!intent) return { ...unknown, reason: 'no_durable_intent' };
    if (intent.receipt) {
      if (
        intent.receipt['operationId'] !== operationId ||
        intent.receipt['nativeSessionId'] !== nativeSessionId ||
        intent.receipt['nativeTurnId'] !== nativeTurnId ||
        intent.receipt['outcome'] !== 'injected'
      )
        throw new Error('control_journal_corrupt');
      this.operations.set(key, { signature: intent.signature, receipt: Promise.resolve(intent.receipt) });
      return structuredClone(intent.receipt);
    }
    if (!this.bridge.readUserMessage) return { ...unknown, reason: 'native_history_unsupported' };
    let proof: Awaited<ReturnType<NonNullable<NativeCodexBridge['readUserMessage']>>>;
    try {
      proof = await this.bridge.readUserMessage({
        threadId: nativeSessionId,
        turnId: nativeTurnId,
        clientUserMessageId: intent.clientUserMessageId,
      });
    } catch {
      return { ...unknown, reason: 'native_history_unavailable' };
    }
    if (
      !proof ||
      proof.nativeSessionId !== nativeSessionId ||
      proof.nativeTurnId !== nativeTurnId ||
      proof.clientUserMessageId !== intent.clientUserMessageId ||
      !proof.nativeItemId ||
      digest(proof.prompt) !== intent.promptHash
    )
      return { ...unknown, reason: 'no_exact_native_proof' };
    const receipt = {
      operationId,
      nativeSessionId,
      nativeTurnId,
      outcome: 'injected',
      nativeReceipt: {
        source: 'native_history',
        nativeItemId: proof.nativeItemId,
        clientUserMessageId: proof.clientUserMessageId,
        turnId: proof.nativeTurnId,
      },
    };
    await this.journal?.save(key, { ...intent, receipt });
    this.operations.set(key, { signature: intent.signature, receipt: Promise.resolve(receipt) });
    return structuredClone(receipt);
  }
}
