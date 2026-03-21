/** CDP bridge to Antigravity IDE (Electron). See also cdp-target-selection.ts, cdp-dom-scripts.ts. */

import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import {
  CLICK_MODEL_SELECTOR_JS,
  DISPATCH_ENTER_JS,
  FIND_MODEL_OPTION_JS,
  FIND_SEND_BUTTON_JS,
  GET_CURRENT_MODEL_JS,
  NEW_CONVERSATION_JS,
  POLL_RESPONSE_JS,
} from './cdp-dom-scripts.js';
import type { CdpTarget } from './cdp-target-selection.js';
import { rankEditorTargets } from './cdp-target-selection.js';

const log = createModuleLogger('antigravity-cdp');

export type { CdpTarget, FindEditorTargetOptions } from './cdp-target-selection.js';
export { findEditorTarget, normaliseHint, rankEditorTargets } from './cdp-target-selection.js';

export interface AntigravityCdpClientOptions {
  port?: number;
  host?: string;
  titleHint?: string;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  fetchTimeoutMs?: number;
  probeTimeoutMs?: number;
  debug?: boolean;
}

export interface PollResponseOptions {
  expectedUserMessageCount?: number;
  pollIntervalMs?: number;
  stablePollCount?: number;
  maxTimeoutMs?: number;
}

export interface PollResponseResult {
  text: string;
  thinking?: string;
}

function isMissingCdpMethod(error: unknown, method: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`'${method}' wasn't found`) || message.includes('Method not found');
}

type Pending = { resolve: (v: unknown) => void; reject: (r: unknown) => void; timer: ReturnType<typeof setTimeout> };

export class AntigravityCdpClient {
  private readonly port: number;
  private readonly host: string;
  private readonly titleHint: string | undefined;
  private readonly commandTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly debug: boolean;
  private ws: WebSocket | null = null;
  private idCounter = 0;
  private pending = new Map<number, Pending>();

  constructor(options?: AntigravityCdpClientOptions) {
    const o = options ?? {};
    this.port = o.port ?? 9000;
    this.host = o.host ?? 'localhost';
    this.titleHint = o.titleHint;
    this.commandTimeoutMs = o.commandTimeoutMs ?? 10_000;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 5_000;
    this.fetchTimeoutMs = o.fetchTimeoutMs ?? 5_000;
    this.probeTimeoutMs = o.probeTimeoutMs ?? 2_000;
    this.debug = o.debug ?? !!process.env.CDP_DEBUG;
  }

  private log(...args: unknown[]): void {
    if (this.debug) log.debug({}, `[CDP] ${args.map(String).join(' ')}`);
  }
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** Fetch targets, probe for health, connect to best candidate. */
  async connect(runtimeTitleHint?: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/json`, { signal: AbortSignal.timeout(this.fetchTimeoutMs) });
    const targets = (await resp.json()) as CdpTarget[];
    const hint = runtimeTitleHint ?? this.titleHint;
    this.log(
      'targets:',
      targets.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url })),
    );
    const candidates = rankEditorTargets(targets, hint ? { titleHint: hint } : undefined);
    if (candidates.length === 0)
      throw new Error(
        `No Antigravity editor page on port ${this.port}. Targets: ${targets.map((t) => `${t.type}:${t.title}`).join(', ')}`,
      );
    for (const c of candidates) {
      this.log('probing:', c.title, c.url);
      try {
        await this.connectToTarget(c);
        await this.cdp('Runtime.enable');
        await this.evaluate('1', this.probeTimeoutMs);
        this.log('probe OK:', c.title);
        try {
          await this.cdp('Input.enable');
        } catch (e) {
          if (!isMissingCdpMethod(e, 'Input.enable')) throw e;
        }
        return;
      } catch (err) {
        this.log('probe FAIL:', c.title, err instanceof Error ? err.message : err);
        await this.disconnect();
      }
    }
    throw new Error(
      `All ${candidates.length} CDP candidates failed health probe. Tried: ${candidates.map((t) => t.title).join(', ')}`,
    );
  }

  /** Open WebSocket to a target and wire up handlers. */
  private async connectToTarget(target: CdpTarget): Promise<void> {
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    };

    const rejectAll = (reason: string) => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error(reason));
      }
    };
    this.ws.onclose = () => rejectAll('CDP WebSocket closed unexpectedly');
    this.ws.onerror = () => rejectAll('CDP WebSocket error');
    const ws = this.ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`CDP WebSocket connect timeout (${this.connectTimeoutMs}ms)`));
        ws.close();
      }, this.connectTimeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      const prevOnerror = ws.onerror;
      ws.onerror = (e) => {
        clearTimeout(timer);
        if (typeof prevOnerror === 'function') prevOnerror.call(ws, e);
        reject(new Error('CDP WebSocket error during connect'));
      };
    });
  }

  async disconnect(): Promise<void> {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }

  /** Send CDP command and await result. */
  async cdp(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('CDP not connected');
    const id = ++this.idCounter;
    const t = timeoutMs ?? this.commandTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout for ${method} (${t}ms)`));
        }
      }, t);
      this.pending.set(id, { resolve, reject, timer });
      this.ws?.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate JS in page. Surfaces CDP exceptions. */
  async evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T> {
    const r = (await this.cdp('Runtime.evaluate', { expression }, timeoutMs)) as {
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails)
      throw new Error(`CDP evaluate error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Inject text and send via multi-strategy: button click → JS Enter → CDP Enter. */
  async sendMessage(text: string): Promise<void> {
    if (!this.connected) throw new Error('CDP not connected');

    // 1. Find and click the textbox to focus
    const tbInfo = await this.evaluate<string | null>(`(() => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      if (!tb) return null;
      const r = tb.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
    })()`);

    if (!tbInfo) throw new Error('Antigravity chat textbox not found');
    const { x, y } = JSON.parse(tbInfo);
    await this.clickAt(x, y);

    // 2. Small delay for focus
    await new Promise((r) => setTimeout(r, 300));

    // 3. Inject text via execCommand (Lexical hook)
    await this.evaluate(`document.execCommand('insertText', false, ${JSON.stringify(text)})`);
    await new Promise((r) => setTimeout(r, 200));

    // 4. Send — multi-strategy (try each until one succeeds)
    // Strategy A: Find and click the send button
    const sendBtnInfo = await this.evaluate<string | null>(FIND_SEND_BUTTON_JS);
    if (sendBtnInfo) {
      const btn = JSON.parse(sendBtnInfo);
      await this.clickAt(btn.x, btn.y);
      return;
    }

    // Strategy B: JS-level KeyboardEvent dispatch (Lexical catches these)
    const dispatched = await this.evaluate<boolean>(DISPATCH_ENTER_JS);
    if (dispatched) return;

    // Strategy C: CDP Input.dispatchKeyEvent (last resort)
    const enterKey = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enterKey });
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...enterKey });
  }

  /** Click at (x, y) via CDP. */
  private async clickAt(x: number, y: number): Promise<void> {
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /** Poll DOM for response. Idle timeout resets on activity; maxTimeoutMs is absolute ceiling. */
  async pollResponse(idleTimeoutMs = 60_000, options?: PollResponseOptions): Promise<PollResponseResult | null> {
    if (!this.connected) throw new Error('CDP not connected');

    const start = Date.now();
    const pollInterval = options?.pollIntervalMs ?? 1_000;
    const stablePollCount = options?.stablePollCount ?? 4;
    const maxTimeoutMs = options?.maxTimeoutMs ?? 300_000;
    const expectedUserMessageCount =
      options?.expectedUserMessageCount ??
      (await this.evaluate<number>(`document.querySelectorAll('.whitespace-pre-wrap').length`));
    let lastResponseText = '';
    let lastThinkingText = '';
    let stablePolls = 0;
    let lastActivityTime = Date.now();

    while (Date.now() - lastActivityTime < idleTimeoutMs && Date.now() - start < maxTimeoutMs) {
      await new Promise((r) => setTimeout(r, pollInterval));

      const state = await this.evaluate<string>(POLL_RESPONSE_JS);
      const parsed = JSON.parse(state) as {
        userMsgCount: number;
        responseText: string;
        thinkingText?: string;
        hasInlineLoading: boolean;
      };
      const { userMsgCount, responseText, hasInlineLoading } = parsed;
      const hasStopButton = !!(parsed as { hasStopButton?: boolean }).hasStopButton;
      const thinkingText = parsed.thinkingText ?? '';
      const isGenerating = hasInlineLoading || hasStopButton;

      if (userMsgCount < expectedUserMessageCount) continue;

      // Activity detection — reset idle timer regardless of responseText presence.
      // Model may be thinking/loading with empty responseText; that still counts as active.
      if (isGenerating || responseText !== lastResponseText || thinkingText !== lastThinkingText) {
        lastActivityTime = Date.now();
      }
      if (thinkingText !== lastThinkingText) lastThinkingText = thinkingText;

      if (!responseText || isGenerating) {
        lastResponseText = responseText;
        stablePolls = 0;
        continue;
      }
      if (responseText === lastResponseText) {
        stablePolls += 1;
      } else {
        lastResponseText = responseText;
        stablePolls = 1;
      }
      if (stablePolls >= stablePollCount) {
        return thinkingText ? { text: responseText, thinking: thinkingText } : { text: responseText };
      }
    }
    return null;
  }

  /** Read the currently selected model label from the Antigravity footer. */
  async getCurrentModel(): Promise<string | null> {
    if (!this.connected) throw new Error('CDP not connected');
    return this.evaluate<string | null>(GET_CURRENT_MODEL_JS);
  }

  /** Switch Antigravity to a different model via the dropdown. No-op if already correct. */
  async switchModel(targetModelLabel: string): Promise<void> {
    if (!this.connected) throw new Error('CDP not connected');
    const normalised = targetModelLabel.toLowerCase().split('(')[0]?.trim();
    const current = await this.getCurrentModel();
    if (current?.toLowerCase().includes(normalised)) return;

    const selectorInfo = await this.evaluate<string | null>(CLICK_MODEL_SELECTOR_JS);
    if (!selectorInfo) throw new Error('Model selector not found in Antigravity UI');
    const { x, y } = JSON.parse(selectorInfo);
    await this.clickAt(x, y);
    await new Promise((r) => setTimeout(r, 500));

    const script = FIND_MODEL_OPTION_JS.replace('__TARGET__', JSON.stringify(normalised));
    const clicked = await this.evaluate<boolean>(script);
    if (!clicked) {
      await this.evaluate(
        `document.activeElement?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
      );
      throw new Error(`Model "${targetModelLabel}" not found in Antigravity dropdown`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  /** Click + button to start new conversation. */
  async newConversation(): Promise<void> {
    if (!this.connected) throw new Error('CDP not connected');
    const btnInfo = await this.evaluate<string | null>(NEW_CONVERSATION_JS);
    if (!btnInfo) throw new Error('New conversation button not found');
    const { x, y } = JSON.parse(btnInfo);
    await this.clickAt(x, y);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
