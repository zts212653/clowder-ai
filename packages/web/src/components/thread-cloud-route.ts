import { type CloudBindingRefusal, isCloudBindingRefusal } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { parseChatGptConversationUrl } from '@/utils/chatgpt-chat-url';

export interface BoundConversation {
  chatUrl: string;
  conversationId: string;
}

/** A thread's conversation for its cloud cat: none, one, or a stored value that is not a conversation. */
export type RouteBinding = BoundConversation | 'invalid' | null;

/** What the Host says about the thread's ChatGPT conversation. */
export type ThreadCloudRouteRead =
  | { kind: 'loading' }
  | { kind: 'no-cloud-cat' }
  | { kind: 'unauthorized' }
  | { kind: 'error' }
  | { kind: 'ready'; catId: string; binding: RouteBinding };

export type SettledRouteRead = Exclude<ThreadCloudRouteRead, { kind: 'loading' }>;

interface CloudBindingsBody {
  bindings?: unknown;
  cloudCat?: { status?: unknown; catId?: unknown };
  code?: unknown;
}

function bindingsRoute(threadId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/cloud-bindings`;
}

function bindingIn(bindings: unknown, catId: string): RouteBinding | undefined {
  if (!bindings || typeof bindings !== 'object') return undefined;
  const raw = (bindings as Record<string, unknown>)[catId];
  if (raw === undefined) return null;
  return parseChatGptConversationUrl(raw) ?? 'invalid';
}

/**
 * Reads the thread's binding for the cloud cat the Host resolves (F202 h3c-2): none, or several, means
 * there is no conversation to show. `afterWrite` waits for a read that starts after any read already in
 * flight, which may predate a write.
 */
export async function readThreadCloudRoute(
  threadId: string,
  { signal, afterWrite = false }: { signal?: AbortSignal; afterWrite?: boolean } = {},
): Promise<SettledRouteRead> {
  try {
    const response = afterWrite
      ? await apiFetch(bindingsRoute(threadId), { signal }, { afterCurrentGet: true })
      : await apiFetch(bindingsRoute(threadId), { signal });
    if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' };
    if (!response.ok) return { kind: 'error' };
    const body = (await response.json()) as CloudBindingsBody;
    if (body.cloudCat?.status !== 'resolved' || typeof body.cloudCat.catId !== 'string') {
      return { kind: 'no-cloud-cat' };
    }
    const catId = body.cloudCat.catId;
    const binding = bindingIn(body.bindings ?? {}, catId);
    return binding === undefined ? { kind: 'error' } : { kind: 'ready', catId, binding };
  } catch {
    return { kind: 'error' };
  }
}

export type RouteWriteOutcome =
  | { kind: 'written'; binding: RouteBinding }
  | { kind: 'refused'; reason: string }
  | { kind: 'unknown' };

const REFUSAL_REASON: Record<CloudBindingRefusal, string> = {
  CLOUD_BINDING_AUTH_REQUIRED: '登录状态失效了，刷新页面后再试。',
  CLOUD_BINDING_RESERVED_IDENTITY: '当前身份不能修改连接。',
  CLOUD_BINDING_INVALID_BODY: '这个会话的链接不符合要求。',
  CLOUD_BINDING_THREAD_NOT_FOUND: '这个对话已经不存在了。',
  CLOUD_BINDING_SYSTEM_THREAD: '系统对话不能连接 ChatGPT 会话。',
  CLOUD_BINDING_NOT_OWNER: '只有对话所有者可以修改连接。',
};

/**
 * Writes the thread's conversation for `catId` (`null` disconnects it). Only a refusal the endpoint
 * makes before writing — one carrying a `CloudBindingRefusal` code — proves that nothing changed. Any
 * other failure is an unknown outcome: the write may have landed and only its answer got lost.
 */
export async function writeThreadCloudRoute(
  threadId: string,
  catId: string,
  chatUrl: string | null,
): Promise<RouteWriteOutcome> {
  let response: Response;
  try {
    response = await apiFetch(bindingsRoute(threadId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId, chatUrl }),
    });
  } catch {
    return { kind: 'unknown' };
  }
  const body = (await response.json().catch(() => undefined)) as CloudBindingsBody | undefined;
  if (response.ok) {
    const binding = bindingIn(body?.bindings, catId);
    return binding === undefined ? { kind: 'unknown' } : { kind: 'written', binding };
  }
  const code = body?.code;
  if (response.status >= 400 && response.status < 500 && isCloudBindingRefusal(code)) {
    return { kind: 'refused', reason: REFUSAL_REASON[code] };
  }
  return { kind: 'unknown' };
}

/** Whether the binding is the one a write asked for (`null`: disconnected). */
export function bindingIs(binding: RouteBinding, conversationId: string | null): boolean {
  if (conversationId === null) return binding === null;
  return binding !== null && binding !== 'invalid' && binding.conversationId === conversationId;
}
