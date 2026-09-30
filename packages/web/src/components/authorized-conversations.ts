import { apiFetch } from '@/utils/api-client';
import { parseChatGptConversationUrl } from '@/utils/chatgpt-chat-url';

export interface AuthorizedConversationCandidate {
  conversationId: string;
  chatUrl: string;
  displayTitle?: string;
  authorizedAt: string;
  updatedAt: string;
}

/** The conversations the extension may use, as a view needs them. */
export type AuthorizedConversationsRead =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; candidates: AuthorizedConversationCandidate[] };

/** The authorization source's answer; the recovery card also reads its connection and title fields. */
export interface PersonalChromeStateResponse {
  authorization?: { conversations?: unknown };
  artifact?: { helper?: string };
  live?: { status?: string };
  titleSync?: { status?: string; errorCode?: string; updatedCount?: number; requestedCount?: number };
  error?: string;
}

export interface AuthorizedConversationsSnapshot {
  response: Response;
  body: PersonalChromeStateResponse;
  /** Empty unless the source answered: an unreadable answer authorizes nothing. */
  candidates: AuthorizedConversationCandidate[];
}

function safeDisplayTitle(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 160) return undefined;
  const invalid = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint < 32 ||
      codePoint === 127 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
  if (invalid) return undefined;
  const title = value.trim().replace(/\s+/g, ' ');
  return title && !/^(ChatGPT|New chat|新聊天)$/iu.test(title) ? title : undefined;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

export function authorizedCandidates(value: unknown): AuthorizedConversationCandidate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const candidates: AuthorizedConversationCandidate[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const conversationId = (raw as { conversationId?: unknown }).conversationId;
    if (typeof conversationId !== 'string') continue;
    const parsed = parseChatGptConversationUrl(`https://chatgpt.com/c/${conversationId}`);
    if (!parsed || parsed.conversationId !== conversationId || seen.has(conversationId)) continue;
    const authorizedAt = canonicalTimestamp((raw as { authorizedAt?: unknown }).authorizedAt);
    const updatedAt = canonicalTimestamp((raw as { updatedAt?: unknown }).updatedAt);
    if (!authorizedAt || !updatedAt || updatedAt < authorizedAt) continue;
    seen.add(conversationId);
    const displayTitle = safeDisplayTitle((raw as { displayTitle?: unknown }).displayTitle);
    candidates.push({ ...parsed, authorizedAt, updatedAt, ...(displayTitle ? { displayTitle } : {}) });
  }
  return candidates.sort((left, right) => right.authorizedAt.localeCompare(left.authorizedAt));
}

/**
 * The conversations the extension may use: the only ones a thread can be routed to. This is the one
 * place that knows where they come from — today the Personal ChatGPT Pro plugin state; F202 h3c-3
 * changes the source here — and both the thread panel and the recovery card read them through it.
 * `syncTitles` asks the source to refresh the conversation names first.
 */
export async function fetchAuthorizedConversations(
  signal: AbortSignal,
  { syncTitles = false }: { syncTitles?: boolean } = {},
): Promise<AuthorizedConversationsSnapshot> {
  const response = syncTitles
    ? await apiFetch('/api/plugins/personal-chrome/refresh-titles', { method: 'POST', signal })
    : await apiFetch('/api/plugins/personal-chrome', { signal });
  const body = (await response.json().catch(() => ({}))) as PersonalChromeStateResponse;
  return {
    response,
    body,
    candidates: response.ok ? authorizedCandidates(body.authorization?.conversations) : [],
  };
}
