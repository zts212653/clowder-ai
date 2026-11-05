import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CloudConversationLink } from '@/components/CloudConversationLink';

/** Shared by the thread panel's route tests: a Host that keeps one thread's bindings in memory. */

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface Candidate {
  conversationId: string;
  chatUrl: string;
  displayTitle?: string;
  authorizedAt: string;
  updatedAt: string;
}

export function candidate(conversationId: string, displayTitle?: string, minute = 0): Candidate {
  const at = new Date(Date.UTC(2026, 8, 5, 6, minute)).toISOString();
  return {
    conversationId,
    chatUrl: `https://chatgpt.com/c/${conversationId}`,
    ...(displayTitle ? { displayTitle } : {}),
    authorizedAt: at,
    updatedAt: at,
  };
}

export const STARS = candidate('conversation-stars', '把云端的小星星接回家', 3);
export const REVIEW = candidate('conversation-review', '周末一起看连接体验', 2);
export const UNTITLED = candidate('conversation-untitled', undefined, 1);

type Handler = () => Promise<Response>;

/**
 * One thread on a fake Host. Reads answer from `bindings`; a PATCH applies to `bindings` first and then
 * answers as `patch` says — so a lost answer still leaves the write in place, as it can on a real Host.
 */
export class FakeHost {
  bindings: Record<string, string> = {};
  cloudCat: unknown = { status: 'resolved', catId: 'gpt-pro' };
  candidates: Candidate[] = [STARS, REVIEW, UNTITLED];
  /**
   * How the next PATCHes answer, in order; the default applies the write and answers with it. `gate`
   * holds the request before it reaches the Host; `commitThenHold` applies it at once and holds only
   * the answer — which then reports the bindings as they were when the write landed.
   */
  patchPlan: Array<
    | 'ok'
    | 'lost'
    | 'unapplied-lost'
    | '500'
    | { status: number; body: unknown }
    | { gate: Promise<void>; answer?: { status: number; body: unknown } }
    | { commitThenHold: Promise<void> }
    | { commitThenFail: Promise<void> }
  > = [];
  /** How the next binding reads answer, in order; the default answers. */
  readPlan: Array<'ok' | 'fail' | { gate: Promise<void> }> = [];
  pluginPlan: Array<'ok' | 'fail'> = [];
  readonly calls: Array<{ path: string; method: string; body?: unknown; options?: unknown }> = [];

  constructor(readonly threadId = 'thread-one') {}

  get bindingsPath(): string {
    return `/api/threads/${this.threadId}/cloud-bindings`;
  }

  patches(): unknown[] {
    return this.calls.filter((call) => call.method === 'PATCH').map((call) => call.body);
  }

  bindingReads(): Array<{ options?: unknown }> {
    return this.calls.filter((call) => call.method === 'GET' && call.path === this.bindingsPath);
  }

  handle(path: string, init?: RequestInit, options?: unknown): Promise<Response> | undefined {
    const method = init?.method ?? 'GET';
    const actions = '/api/plugins/official.companion.personal-chrome/actions/personalChromeAuthorizations/';
    if (path === actions + 'list' && method === 'POST') {
      this.calls.push({ path, method });
      if (this.pluginPlan.shift() === 'fail') return Promise.resolve(jsonResponse({ error: 'down' }, 503));
      return Promise.resolve(jsonResponse(packageRows(this.candidates)));
    }
    if (path === actions + 'status')
      return Promise.resolve(jsonResponse({ ok: true, data: { helper: { state: 'connected' } } }));
    if (path === actions + 'refresh-titles' && method === 'POST') {
      this.calls.push({ path, method });
      return Promise.resolve(
        jsonResponse({ ok: true, data: { titleSync: { status: 'synced', updatedCount: 0, requestedCount: 0 } } }),
      );
    }
    if (path !== this.bindingsPath) return undefined;
    if (method === 'GET') {
      this.calls.push({ path, method, options });
      return this.read();
    }
    const body = JSON.parse(String(init?.body)) as { catId: string; chatUrl: string | null };
    this.calls.push({ path, method, body });
    return this.patch(body);
  }

  /** A read answers with the bindings as they were when it arrived, however late the answer comes. */
  private read: Handler = async () => {
    const step = this.readPlan.shift() ?? 'ok';
    const answer = { bindings: { ...this.bindings }, cloudCat: this.cloudCat };
    if (typeof step === 'object') await step.gate;
    if (step === 'fail') throw new TypeError('Failed to fetch');
    return jsonResponse(answer);
  };

  private apply(body: { catId: string; chatUrl: string | null }): void {
    if (body.chatUrl === null) delete this.bindings[body.catId];
    else this.bindings[body.catId] = body.chatUrl;
  }

  private async patch(body: { catId: string; chatUrl: string | null }): Promise<Response> {
    let step = this.patchPlan.shift() ?? 'ok';
    if (typeof step === 'object' && 'commitThenFail' in step) {
      this.apply(body);
      await step.commitThenFail;
      throw new TypeError('Failed to fetch');
    }
    if (typeof step === 'object' && 'commitThenHold' in step) {
      this.apply(body);
      const answer = jsonResponse({ bindings: { ...this.bindings } });
      await step.commitThenHold;
      return answer;
    }
    if (typeof step === 'object' && 'gate' in step) {
      await step.gate;
      step = step.answer ?? 'ok';
    }
    if (typeof step === 'object') return jsonResponse(step.body, step.status);
    if (step !== 'unapplied-lost') this.apply(body);
    if (step === 'lost' || step === 'unapplied-lost') throw new TypeError('Failed to fetch');
    if (step === '500') return jsonResponse({ error: 'Internal Server Error' }, 500);
    return jsonResponse({ bindings: { ...this.bindings } });
  }
}

/** A promise to hold a response back until the test lets it go. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

export function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === text);
}

export function radioFor(root: ParentNode, conversationId: string): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(`input[type="radio"][value="${conversationId}"]`);
}

export async function click(element: HTMLElement | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to click');
  await act(async () => {
    element.click();
  });
  await flush();
}

export function connected(conversation: Candidate, threadId = 'thread-one'): FakeHost {
  const host = new FakeHost(threadId);
  host.bindings = { 'gpt-pro': conversation.chatUrl };
  return host;
}

/** Answers every request from the first of these Hosts that knows the path. */
export function serveHosts(apiFetch: { mockImplementation: (impl: never) => unknown }, ...hosts: FakeHost[]): void {
  const impl = async (path: string, init?: RequestInit, options?: unknown) => {
    for (const host of hosts) {
      const answer = host.handle(path, init, options);
      if (answer) return answer;
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  apiFetch.mockImplementation(impl as never);
}

/** The thread panel's card, mounted on its own. */
export function mountPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const panel = {
    container,
    async show(threadId: string) {
      await act(async () => root.render(<CloudConversationLink threadId={threadId} />));
      await flush();
    },
    status: () => container.querySelector('[data-route-status]')?.getAttribute('data-route-status'),
    async changeTo(conversation: Candidate) {
      if (buttonByText(container, '更换')) await click(buttonByText(container, '更换'));
      await click(radioFor(container, conversation.conversationId));
      await click(buttonByText(container, '改用这个会话'));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
  return panel;
}

/** Package action rows deliberately carry no timestamps. */
export function packageRows(conversations: Array<{ conversationId: string; displayTitle?: string }>) {
  return {
    ok: true,
    render: 'rows',
    data: {
      rows: conversations.map(({ conversationId, displayTitle }) => ({
        key: conversationId,
        label: displayTitle ?? conversationId,
      })),
    },
  };
}
