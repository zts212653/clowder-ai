import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createModuleLogger } from '../../../../../../../infrastructure/logger.js';
import type { AgentClientActiveRunHandle, AgentClientDispatchInput, AgentServiceOptions } from '../../../../types.js';
import type { AgyStreamJsonEvent } from '../../agy-stream-json-parser.js';
import { encodeAgyStreamJsonUserMessage } from '../../agy-stream-json-parser.js';

const log = createModuleLogger('agy-native-input');

interface Supplement {
  readonly input: AgentClientDispatchInput;
  readonly signature: string;
  read: boolean;
  completed: boolean;
}

function withinDirectory(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Live stream ownership only; durable delivery/unfinished-input recovery stays in Queue. */
export class AgyNativeRunInput {
  private writer: ((input: string) => void) | undefined;
  private accepting = false;
  private release: (() => void) | undefined;
  private readonly pending: Supplement[] = [];
  private readonly deliveries = new Map<string, Supplement>();
  private current: Supplement | undefined;
  private inputIndex: number | undefined;
  private readIndex: number | undefined;
  private firstTurn = true;
  private resultSeen = false;
  private initialRead = false;
  private resolveInitialRead!: (at: number) => void;
  readonly initialInputRead = new Promise<number>((resolveInit) => {
    this.resolveInitialRead = resolveInit;
  });

  constructor(
    private readonly options: AgentServiceOptions,
    private readonly closeStdin: () => void,
    private readonly workspaceRoot?: string,
    private readonly onSupplementalInput?: (text: string) => void,
    private readonly grantedUploadRoot?: string,
  ) {
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }

  private readonly abort = () => this.stop();

  onStdinReady(write: (input: string) => void): void {
    this.writer = write;
  }

  private async resolveSupplementalAttachments(
    imagePaths: readonly string[] | undefined,
  ): Promise<
    | { readonly ok: true; readonly paths: readonly string[] }
    | { readonly ok: false; readonly reason: 'invalid_input' | 'provider_rejected' }
  > {
    if (!imagePaths?.length) return { ok: true, paths: [] };
    const allowedRoots: string[] = [];
    try {
      const workCandidate = this.workspaceRoot ?? this.options.workingDirectory;
      if (workCandidate && existsSync(workCandidate)) allowedRoots.push(realpathSync(workCandidate));
    } catch {
      // Ignore unavailable workspace root.
    }
    let uploadRoot: string | undefined;
    try {
      if (this.grantedUploadRoot) {
        uploadRoot = realpathSync(this.grantedUploadRoot);
        if (uploadRoot !== this.grantedUploadRoot || !statSync(uploadRoot).isDirectory())
          return { ok: false, reason: 'provider_rejected' };
        allowedRoots.push(uploadRoot);
      }
    } catch {
      // Ignore unavailable upload root.
    }

    const verified: string[] = [];
    for (const raw of imagePaths) {
      if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'invalid_input' };
      let candidate = raw;
      if (raw.startsWith('hmr:')) {
        if (!this.options.resolveTrustedImagePath) return { ok: false, reason: 'provider_rejected' };
        const resolvedHmr = await this.options.resolveTrustedImagePath(raw);
        if (!resolvedHmr) return { ok: false, reason: 'invalid_input' };
        candidate = resolvedHmr;
      } else if (raw.startsWith('/uploads/')) {
        if (!uploadRoot) return { ok: false, reason: 'provider_rejected' };
        const logicalUpload = resolve(uploadRoot, raw.slice('/uploads/'.length));
        if (!withinDirectory(uploadRoot, logicalUpload)) return { ok: false, reason: 'invalid_input' };
        candidate = logicalUpload;
      }
      if (!isAbsolute(candidate)) return { ok: false, reason: 'invalid_input' };
      const logicalAllowedRoot = allowedRoots.find((root) => withinDirectory(root, resolve(candidate)));
      if (!logicalAllowedRoot) return { ok: false, reason: 'invalid_input' };
      try {
        const real = realpathSync(candidate);
        if (!withinDirectory(logicalAllowedRoot, real) || !statSync(real).isFile()) {
          return { ok: false, reason: 'invalid_input' };
        }
        verified.push(real);
      } catch {
        return { ok: false, reason: 'invalid_input' };
      }
    }
    return { ok: true, paths: verified };
  }

  register(sessionId: string): void {
    const registration = this.options.activeRunDispatch;
    if (!registration || !this.writer || this.options.signal?.aborted) return;
    const handle: AgentClientActiveRunHandle = {
      provider: 'google',
      carrier: 'agy_stream_json',
      threadId: sessionId,
      turnId: randomUUID(),
    };
    this.accepting = true;
    this.release = registration.register({
      invocationId: registration.invocationId,
      capabilities: { append: true, steer: false, inputReadReceipt: true, inputCompletionReceipt: true },
      initialInputRead: this.initialInputRead,
      handle,
      dispatch: async (input, control) => {
        if (control.expectedInvocationId !== registration.invocationId)
          return { accepted: false, reason: 'active_run_mismatch', acceptance: 'not_accepted' };
        if (!this.accepting || this.options.signal?.aborted || !this.writer)
          return { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' };
        if (control.force) return { accepted: false, reason: 'provider_rejected', acceptance: 'not_accepted' };
        const attachments = await this.resolveSupplementalAttachments(input.imagePaths);
        if (!this.accepting || this.options.signal?.aborted || !this.writer)
          return { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' };
        if (!attachments.ok) return { accepted: false, reason: attachments.reason, acceptance: 'not_accepted' };
        if (!input.text.trim() && attachments.paths.length === 0)
          return { accepted: false, reason: 'invalid_input', acceptance: 'not_accepted' };
        const signature = JSON.stringify([input.text, input.messageIds, attachments.paths]);
        const previous = input.deliveryId ? this.deliveries.get(input.deliveryId) : undefined;
        if (previous)
          return previous.signature === signature
            ? { accepted: true, handle }
            : { accepted: false, reason: 'invalid_input', acceptance: 'not_accepted' };
        const supplement: Supplement = { input, signature, read: false, completed: false };
        this.pending.push(supplement);
        if (input.deliveryId) this.deliveries.set(input.deliveryId, supplement);
        const formattedText = attachments.paths.length
          ? `${input.text ? `${input.text}\n\n` : ''}[User attachments — read their contents before answering]\n${attachments.paths
              .map((path) => `image file for read_file (view_file on older CLI): ${JSON.stringify(path)}`)
              .join('\n')}`
          : input.text;
        try {
          this.writer(`${encodeAgyStreamJsonUserMessage(formattedText)}\n`);
          return { accepted: true, handle };
        } catch {
          // A failed write cannot establish whether the child received bytes.
          this.stop();
          return { accepted: false, reason: 'exception', acceptance: 'unknown' };
        }
      },
    });
  }

  async step(event: Extract<AgyStreamJsonEvent, { kind: 'step' }>): Promise<void> {
    if (event.stepType !== 'user_input') return;
    if (this.inputIndex !== undefined && event.stepIndex !== this.inputIndex)
      throw new Error('AGY native emitted multiple user inputs before a terminal result');
    this.inputIndex = event.stepIndex;
    if (!this.firstTurn && !this.current) {
      this.current = this.pending[0];
      if (!this.current) throw new Error('AGY native read an input not accepted by this run');
      this.onSupplementalInput?.(this.current.input.text);
    }
    if (event.state !== 'DONE' || this.readIndex === event.stepIndex) return;
    this.readIndex = event.stepIndex;
    if (this.firstTurn) {
      this.initialRead = true;
      this.resolveInitialRead(Date.now());
      return;
    }
    this.current ??= this.pending[0];
    if (!this.current) throw new Error('AGY native read an input not accepted by this run');
    if (!this.current.read) {
      this.current.read = true;
      // This observer is best effort. Exact-ref/CAS fences keep a late write
      // from restoring a compensated binding; delivery and Stop never await it.
      try {
        void this.current.input
          .onInputRead?.()
          .catch((error: unknown) => log.warn({ error }, 'Native read receipt failed'));
      } catch (error) {
        log.warn({ error }, 'Native read receipt failed');
      }
    }
  }

  /** Called synchronously on the raw result, before archive writes or other awaits. */
  resultBoundary(): void {
    const waiting = this.pending.length - (this.current ? 1 : 0);
    if (waiting === 0) this.stop();
  }

  observeResult(successful: boolean): void {
    this.resultSeen = true;
    if (!successful) this.stop();
  }

  /** Only a verified successor input or the final host verdict closes this turn. */
  async completeTurn(successful: boolean): Promise<void> {
    this.firstTurn = false;
    this.resultSeen = false;
    this.inputIndex = undefined;
    if (this.current) {
      const current = this.current;
      current.completed = true;
      this.pending.shift();
      this.current = undefined;
      await current.input.onInputCompleted?.(successful && current.read);
    }
    if (!successful) this.stop();
  }

  get hasUnconfirmedInput(): boolean {
    return this.inputIndex !== undefined && (this.firstTurn ? !this.initialRead : !this.current?.read);
  }

  get hasUnfinishedInput(): boolean {
    return this.pending.length > (this.current && this.resultSeen ? 1 : 0);
  }

  stop(): void {
    this.accepting = false;
    this.options.signal?.removeEventListener('abort', this.abort);
    this.closeStdin();
    this.release?.();
    this.release = undefined;
  }

  async dispose(): Promise<void> {
    this.stop();
    let failure: unknown;
    for (const supplement of this.pending) {
      try {
        if (!supplement.completed) {
          supplement.completed = true;
          await supplement.input.onInputCompleted?.(false);
        }
      } catch (error) {
        failure ??= error;
      }
    }
    this.pending.length = 0;
    if (failure) throw failure;
  }
}
