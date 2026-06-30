/**
 * F247 AC-B1c-3: PinchTab CDP adapter — real `IPinchTabBridgeAdapter` implementation.
 *
 * Connects to Chrome's DevTools Protocol via raw WebSocket (`ws` library) to:
 *   1. Check Chrome reachability + ChatGPT login state (`isReady`)
 *   2. Navigate to a ChatGPT chat (bound or fresh), inject the delta payload
 *      into `#prompt-textarea`, click the send button, and poll
 *      `window.location.href` until it matches `CHATGPT_CHAT_URL_REGEX`,
 *      returning the captured URL (`injectAndCaptureUrl`)
 *
 * CDP endpoint discovery uses Chrome's `/json` HTTP endpoint to list tabs and
 * obtain per-tab `webSocketDebuggerUrl` for targeted automation.
 *
 * Environment:
 *   - `PINCHTAB_CDP_PORT` (default 9870): Chrome's `--remote-debugging-port`
 *   - `CDP_DEBUG` (default off): verbose CDP message logging
 *
 * Error contract: `injectAndCaptureUrl` throws on any failure; the caller
 * (`CloudInvokeBridge.dispatch`) catches and emits fallback notifications.
 * `isReady` never throws — returns false on any failure.
 */

import http from 'node:http';

import WebSocket from 'ws';

import { CHATGPT_CHAT_URL_REGEX, isValidChatGptChatUrl } from '../../../../utils/chatgpt-chat-url.js';
import { quoteForEval } from './build-delta-payload.js';
import type { IPinchTabBridgeAdapter } from './types.js';

// ─────────────────── Configuration ───────────────────

const CDP_PORT = parseInt(process.env.PINCHTAB_CDP_PORT ?? '9870', 10);
const CDP_DEBUG = process.env.CDP_DEBUG === '1' || process.env.CDP_DEBUG === 'true';

/** Timeout for the entire inject+capture operation (ms). */
const INJECT_TIMEOUT_MS = 30_000;

/** Interval between URL-capture polls (ms). */
const URL_POLL_INTERVAL_MS = 500;

/** Maximum URL-capture polls before giving up. */
const URL_POLL_MAX_ATTEMPTS = 40; // 40 × 500ms = 20s max wait

/** Timeout for the HTTP /json discovery call (ms). */
const DISCOVERY_TIMEOUT_MS = 5_000;

/** Timeout for individual CDP commands (ms). */
const CDP_COMMAND_TIMEOUT_MS = 10_000;

/** ChatGPT base URL for opening a new chat. */
const CHATGPT_NEW_CHAT_URL = 'https://chatgpt.com/';

// ─────────────────── Types ───────────────────

interface CdpTab {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─────────────────── CDP Session ───────────────────

/**
 * Minimal CDP session: send commands, receive responses. One session per
 * operation — no long-lived connection. The session is created on connect
 * and disposed after the operation completes.
 */
class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as CdpResponse;
        if (CDP_DEBUG) {
          // biome-ignore lint: CDP debug-only console log
          console.log('[CDP:recv]', JSON.stringify(msg).slice(0, 300));
        }
        if (msg.id != null) {
          const cb = this.pending.get(msg.id);
          if (cb) {
            this.pending.delete(msg.id);
            if (msg.error) {
              cb.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              cb.resolve(msg.result);
            }
          }
        }
      } catch {
        /* ignore non-JSON or event frames */
      }
    });
  }

  /** Connect to a tab's webSocketDebuggerUrl. */
  static async connect(wsUrl: string, timeoutMs = CDP_COMMAND_TIMEOUT_MS): Promise<CdpSession> {
    return new Promise<CdpSession>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`CDP WebSocket connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error: ${err.message}`));
      });
    });
  }

  /** Send a CDP command and wait for its response. */
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${CDP_COMMAND_TIMEOUT_MS}ms`));
      }, CDP_COMMAND_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      const payload = JSON.stringify({ id, method, params });
      if (CDP_DEBUG) {
        // biome-ignore lint: CDP debug-only console log
        console.log('[CDP:send]', payload.slice(0, 300));
      }
      this.ws.send(payload);
    });
  }

  /** Evaluate a JavaScript expression in the page context and return the result value. */
  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown; type?: string; description?: string }; exceptionDetails?: unknown };

    if (result.exceptionDetails) {
      throw new Error(`CDP eval exception: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result?.value;
  }

  /** Close the WebSocket connection. */
  close(): void {
    try {
      for (const [id, cb] of this.pending) {
        cb.reject(new Error('CDP session closed'));
        this.pending.delete(id);
      }
      this.ws.close();
    } catch {
      /* best-effort cleanup */
    }
  }
}

// ─────────────────── Discovery ───────────────────

/**
 * HTTP GET Chrome's `/json` endpoint to list all debuggable tabs.
 * Returns an empty array on any failure (connection refused, timeout, etc.).
 */
async function discoverTabs(): Promise<CdpTab[]> {
  return new Promise<CdpTab[]>((resolve) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json`, { timeout: DISCOVERY_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as CdpTab[]);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

/**
 * Find a ChatGPT tab among the discovered tabs. Prefers the exact bound URL
 * if provided, falls back to any `chatgpt.com` tab.
 */
function findChatGptTab(tabs: CdpTab[], preferredUrl?: string | null): CdpTab | null {
  // Filter to page-type tabs on chatgpt.com
  const chatgptTabs = tabs.filter((t) => t.type === 'page' && t.url.includes('chatgpt.com'));
  if (chatgptTabs.length === 0) return null;

  // If a preferred URL is provided, find an exact match first
  if (preferredUrl) {
    const exact = chatgptTabs.find((t) => t.url === preferredUrl);
    if (exact) return exact;
  }

  // Fall back to the first ChatGPT tab
  return chatgptTabs[0];
}

// ─────────────────── Inject JS Helpers ───────────────────

/**
 * Build the JS expression that injects text into ChatGPT's prompt textarea,
 * dispatches an input event (so React state picks up the change), and clicks
 * the send button.
 *
 * ChatGPT's `#prompt-textarea` is a ProseMirror-based contenteditable `<div>`.
 * Setting `innerText` + dispatching `input` is the most reliable cross-version
 * approach (compared to clipboard simulation or property descriptors).
 *
 * The send button is identified by `[data-testid="send-button"]` (primary)
 * with a fallback to `button[aria-label="Send prompt"]` (older revisions).
 *
 * @param quotedPayload - The payload string as returned by `quoteForEval()`
 *   (already JSON.stringify'd, safe for eval interpolation).
 */
function buildInjectExpression(quotedPayload: string): string {
  // The expression is an IIFE that returns a status string for diagnostics.
  return `(function() {
  var el = document.querySelector('#prompt-textarea');
  if (!el) return 'ERR:no-textarea';

  // Focus + set content on the contenteditable div
  el.focus();
  // Use innerText for natural line-break handling in contenteditable
  el.innerText = ${quotedPayload};
  // Dispatch input event so ProseMirror / React state synchronizes
  el.dispatchEvent(new Event('input', { bubbles: true }));

  // Small delay to let React state settle before clicking send
  return new Promise(function(resolve) {
    setTimeout(function() {
      var sendBtn = document.querySelector('[data-testid="send-button"]')
        || document.querySelector('button[aria-label="Send prompt"]')
        || document.querySelector('form button[type="submit"]');
      if (!sendBtn) { resolve('ERR:no-send-button'); return; }
      sendBtn.click();
      resolve('OK');
    }, 200);
  });
})()`;
}

/**
 * Build a JS expression that reads the current page URL.
 */
function buildUrlCaptureExpression(): string {
  return 'window.location.href';
}

// ─────────────────── Adapter ───────────────────

/**
 * Real PinchTab CDP adapter. Implements `IPinchTabBridgeAdapter` using raw
 * Chrome DevTools Protocol over WebSocket.
 */
export class PinchTabBridgeAdapter implements IPinchTabBridgeAdapter {
  /**
   * Check if Chrome's CDP is reachable and a ChatGPT tab is open + loaded.
   * Returns false on any failure — never throws.
   */
  async isReady(): Promise<boolean> {
    try {
      const tabs = await discoverTabs();
      if (tabs.length === 0) return false;

      const chatGptTab = findChatGptTab(tabs);
      if (!chatGptTab?.webSocketDebuggerUrl) return false;

      // Verify the tab is actually responsive by trying a quick eval
      const session = await CdpSession.connect(chatGptTab.webSocketDebuggerUrl, 3_000);
      try {
        const ready = await session.evaluate('document.readyState');
        return ready === 'complete' || ready === 'interactive';
      } finally {
        session.close();
      }
    } catch {
      return false;
    }
  }

  /**
   * Inject the rendered delta payload into the cloud cat's ChatGPT chat and
   * capture the resulting chat URL.
   *
   * Flow:
   *   1. Discover tabs → find/navigate to the target chat
   *   2. Wait for page load
   *   3. Inject text into `#prompt-textarea` + click send
   *   4. Poll `window.location.href` until it matches `CHATGPT_CHAT_URL_REGEX`
   *   5. Validate + return the captured URL
   *
   * Throws on any failure — caller (`CloudInvokeBridge`) catches and emits
   * fallback notifications.
   */
  async injectAndCaptureUrl(args: {
    readonly renderedPrompt: string;
    readonly boundUrl: string | null;
  }): Promise<string> {
    const { renderedPrompt, boundUrl } = args;
    const deadline = Date.now() + INJECT_TIMEOUT_MS;

    // 1. Discover tabs
    const tabs = await discoverTabs();
    if (tabs.length === 0) {
      throw new Error('Chrome CDP unreachable: no tabs discovered');
    }

    // 2. Find the target ChatGPT tab
    let tab = findChatGptTab(tabs, boundUrl);
    if (!tab?.webSocketDebuggerUrl) {
      // No ChatGPT tab — try the first page tab so we can navigate it
      tab = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
      if (!tab?.webSocketDebuggerUrl) {
        throw new Error('No debuggable page tab found in Chrome');
      }
    }

    // 3. Connect CDP session
    const session = await CdpSession.connect(tab.webSocketDebuggerUrl);
    try {
      // 4. Navigate to the bound URL or open a fresh ChatGPT chat
      const targetUrl = boundUrl ?? CHATGPT_NEW_CHAT_URL;
      const currentUrl = (await session.evaluate('window.location.href')) as string;

      if (currentUrl !== targetUrl) {
        await session.send('Page.navigate', { url: targetUrl });
        // Wait for load
        await this.waitForLoad(session, deadline);
      }

      // 5. Ensure the page is in a good state
      await this.waitForSelector(session, '#prompt-textarea', deadline);

      // 6. Inject the payload text + click send
      const quotedPayload = quoteForEval(renderedPrompt);
      const injectResult = await session.evaluate(buildInjectExpression(quotedPayload));

      if (typeof injectResult === 'string' && injectResult.startsWith('ERR:')) {
        throw new Error(`Inject failed: ${injectResult}`);
      }

      // 7. Poll for URL change to a /c/<id> pattern
      const capturedUrl = await this.pollForChatUrl(session, deadline);

      // 8. Validate against CHATGPT_CHAT_URL_REGEX (defense-in-depth).
      // Use regex directly instead of the type guard (isValidChatGptChatUrl)
      // to avoid TypeScript narrowing `capturedUrl` (already a string) to `never`.
      if (!CHATGPT_CHAT_URL_REGEX.test(capturedUrl)) {
        throw new Error(`Captured URL failed regex validation: ${capturedUrl.slice(0, 80)}`);
      }

      return capturedUrl;
    } finally {
      session.close();
    }
  }

  // ─── Private helpers ───

  /**
   * Wait for `document.readyState === 'complete'` by polling.
   */
  private async waitForLoad(session: CdpSession, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const state = await session.evaluate('document.readyState');
      if (state === 'complete') return;
      await sleep(300);
    }
    throw new Error('Page load timed out');
  }

  /**
   * Wait for a DOM selector to appear on the page by polling.
   */
  private async waitForSelector(session: CdpSession, selector: string, deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const exists = await session.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (exists) return;
      await sleep(300);
    }
    throw new Error(`Selector ${selector} not found within timeout`);
  }

  /**
   * Poll `window.location.href` until it matches the ChatGPT chat URL pattern.
   * On a fresh chat, ChatGPT initially shows `/` and transitions to `/c/<id>`
   * after the first model response is streamed.
   */
  private async pollForChatUrl(session: CdpSession, deadline: number): Promise<string> {
    let lastUrl = '';
    let attempts = 0;

    while (attempts < URL_POLL_MAX_ATTEMPTS && Date.now() < deadline) {
      const url = (await session.evaluate(buildUrlCaptureExpression())) as string;
      lastUrl = url;

      if (isValidChatGptChatUrl(url)) {
        return url;
      }

      attempts++;
      await sleep(URL_POLL_INTERVAL_MS);
    }

    throw new Error(`URL capture timed out after ${attempts} polls. Last URL: ${lastUrl.slice(0, 80)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────── Exports for testing ───────────────────

/** @internal — exported for unit tests only. */
export const _testing = {
  CdpSession,
  discoverTabs,
  findChatGptTab,
  buildInjectExpression,
  buildUrlCaptureExpression,
  CDP_PORT,
  INJECT_TIMEOUT_MS,
  URL_POLL_INTERVAL_MS,
  URL_POLL_MAX_ATTEMPTS,
  CHATGPT_NEW_CHAT_URL,
};
