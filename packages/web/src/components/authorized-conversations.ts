import { apiFetch } from '@/utils/api-client';
import { parseChatGptConversationUrl } from '@/utils/chatgpt-chat-url';

export interface AuthorizedConversationCandidate {
  conversationId: string;
  chatUrl: string;
  displayTitle?: string;
  authorizedAt?: string;
  updatedAt?: string;
}

/** The conversations the extension may use, as a view needs them. */
export type AuthorizedConversationsRead =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; candidates: AuthorizedConversationCandidate[] };

/** The authorization source's answer; the recovery card also reads its connection and title fields. */
export interface PersonalChromeStateResponse {
  status?: {
    status?: string;
    helper?: { state?: string };
    delivery?: { failure?: string; reloadRequired?: boolean };
  };
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
    const candidate = candidateFromRow(raw);
    if (!candidate || seen.has(candidate.conversationId)) continue;
    seen.add(candidate.conversationId);
    candidates.push(candidate);
  }
  return candidates;
}

function candidateFromRow(raw: unknown): AuthorizedConversationCandidate | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as { key?: unknown; label?: unknown; authorizedAt?: unknown; updatedAt?: unknown };
  if (typeof row.key !== 'string') return undefined;
  const parsed = parseChatGptConversationUrl(`https://chatgpt.com/c/${row.key}`);
  if (!parsed || parsed.conversationId !== row.key) return undefined;
  const authorizedAt = canonicalTimestamp(row.authorizedAt);
  const updatedAt = canonicalTimestamp(row.updatedAt);
  if (authorizedAt && updatedAt && updatedAt < authorizedAt) return undefined;
  const displayTitle = row.label === row.key ? undefined : safeDisplayTitle(row.label);
  return {
    ...parsed,
    ...(authorizedAt ? { authorizedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(displayTitle ? { displayTitle } : {}),
  };
}

const ACTIONS = '/api/plugins/official.companion.personal-chrome/actions/personalChromeAuthorizations/';
interface ActionResult {
  ok?: boolean;
  render?: string;
  data?: { rows?: unknown } & NonNullable<PersonalChromeStateResponse['status']> &
    Pick<PersonalChromeStateResponse, 'titleSync'>;
  error?: string;
}

async function action(name: string, signal: AbortSignal) {
  const response = await apiFetch(ACTIONS + name, { method: 'POST', signal });
  const value: unknown = await response.json().catch(() => undefined);
  const body = value && typeof value === 'object' ? (value as ActionResult) : {};
  return { response, body };
}

/** Optional health/title observations must not turn a readable authorization list into an error. */
async function observation(name: string, signal: AbortSignal): Promise<ActionResult['data']> {
  try {
    const result = await action(name, signal);
    return result.response.ok && result.body.ok === true ? result.body.data : undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

/** One package-backed source shared by the route panel and recovery cards. */
export async function fetchAuthorizedConversations(
  signal: AbortSignal,
  { syncTitles = false }: { syncTitles?: boolean } = {},
): Promise<AuthorizedConversationsSnapshot> {
  let titleSync: PersonalChromeStateResponse['titleSync'];
  if (syncTitles) {
    titleSync = (await observation('refresh-titles', signal))?.titleSync ?? {
      status: 'unavailable',
      errorCode: 'AMBIGUOUS_EFFECT',
    };
  }
  signal.throwIfAborted();
  const { response, body } = await action('list', signal);
  if (response.ok && (body.ok !== true || body.render !== 'rows' || !Array.isArray(body.data?.rows))) {
    throw new Error('The authorization list could not be read');
  }
  // Connection health cannot revoke a successfully read authorization list.
  const status = response.ok ? await observation('status', signal) : undefined;
  return {
    response,
    body: {
      ...(status ? { status } : {}),
      ...(titleSync ? { titleSync } : {}),
      ...(body.error ? { error: body.error } : {}),
    },
    candidates: response.ok && body.ok === true && body.render === 'rows' ? authorizedCandidates(body.data?.rows) : [],
  };
}
