/**
 * Phase G: Opus API client for generating abstractive summaries + durable candidates.
 *
 * Design: Opus outputs NATURAL LANGUAGE (what it's good at).
 * Program parses the output into structured segments (what code is good at).
 *
 * 铲屎官原话："我们就不能让他返回自然语言直接帮他加格式吗？格式就是程序加。"
 */

export interface AbstractiveInput {
  previousSummary: string | null;
  messages: Array<{ id: string; content: string; catId?: string; timestamp: number }>;
  threadId: string;
}

export interface TopicSegment {
  summary: string;
  topicKey: string;
  topicLabel: string;
  boundaryReason: string;
  boundaryConfidence: 'high' | 'medium' | 'low';
  fromMessageId: string;
  toMessageId: string;
  messageCount: number;
  relatedSegmentIds?: string[];
  candidates?: DurableCandidate[];
}

export interface DurableCandidate {
  kind: 'decision' | 'lesson' | 'method';
  title: string;
  claim: string;
  why_durable: string;
  evidence: Array<{ threadId: string; messageId: string; span: string }>;
  relatedAnchors: string[];
  confidence: 'explicit' | 'inferred';
}

export interface AbstractiveResult {
  segments: TopicSegment[];
}

interface ProviderProfile {
  mode: 'api_key' | 'subscription';
  baseUrl: string;
  apiKey: string;
}

// ─── System Prompt: natural language output ──────────────────────
const SYSTEM_PROMPT = `You are a thread summarizer for Clowder AI, an AI-collaborative project management system.

IMPORTANT: You are a SUMMARIZER, not a conversation participant. Do NOT respond to the messages — summarize them.

Given a batch of thread messages, write a summary using this format:

# Title of what was discussed

A 200-400 character summary of what was discussed, what was decided, risks, and next steps.

## Durable Knowledge (if any)

[decision] Short title — One-line description of the decision and why it matters
[lesson] Short title — One-line description of the lesson learned
[method] Short title — One-line description of the method/technique worth preserving

Rules:
- The # title line is REQUIRED
- The summary paragraph is REQUIRED (200-400 chars, after the title)
- [decision], [lesson], [method] tags are OPTIONAL — only include if there's genuinely durable knowledge
- Do NOT extract brainstorm branches, temporary TODOs, or session-local context
- Keep it concise — this is a summary, not a transcript
- Write in the same language as the messages (Chinese/English/mixed)`;

// ─── Build user prompt ──────────────────────────────────────────
function buildUserPrompt(input: AbstractiveInput): string {
  const parts: string[] = [];

  parts.push('Summarize the following thread messages.\n');

  if (input.previousSummary) {
    parts.push(`## Previous Summary\n${input.previousSummary}\n`);
  }

  parts.push(`## Messages\n`);
  const MAX_MSG_CHARS = 1000;
  const MAX_TOTAL_CHARS = 80000;
  let totalChars = 0;
  for (const msg of input.messages) {
    const speaker = msg.catId ?? 'user';
    const time = new Date(msg.timestamp).toISOString().slice(0, 19);
    const content = msg.content.length > MAX_MSG_CHARS ? `${msg.content.slice(0, MAX_MSG_CHARS)}...` : msg.content;
    const line = `[${time}] [${speaker}]: ${content}`;
    totalChars += line.length;
    if (totalChars > MAX_TOTAL_CHARS) {
      parts.push(`[... ${input.messages.length} total messages, truncated]`);
      break;
    }
    parts.push(line);
  }

  return parts.join('\n');
}

// ─── Parse natural language output into structured segments ─────
function parseNaturalLanguageOutput(text: string, input: AbstractiveInput): AbstractiveResult | null {
  // Extract title: first line starting with # or ## or ###
  const titleMatch = text.match(/^#{1,3}\s+(.+)$/m);
  if (!titleMatch) return null;

  const topicLabel = titleMatch[1].trim();
  const topicKey = topicLabel
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  // Extract summary: text between title and ## or [decision]/[lesson]/[method] or end
  const titleEnd = text.indexOf(titleMatch[0]) + titleMatch[0].length;
  const candidateStart = text.search(/\n##\s+Durable|\n\[(decision|lesson|method)\]/i);
  const summaryText =
    candidateStart > titleEnd ? text.slice(titleEnd, candidateStart).trim() : text.slice(titleEnd).trim();

  // Clean up summary: remove markdown headers, keep plain text
  const summary = summaryText
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800); // cap at 800 chars

  if (!summary) return null;

  // Extract candidates: [decision], [lesson], [method] tags
  const candidates: DurableCandidate[] = [];
  const candidateRegex = /\[(decision|lesson|method)\]\s*(.+?)(?:\s*[—–-]\s*(.+))?$/gim;
  let match;
  while ((match = candidateRegex.exec(text)) !== null) {
    const kind = match[1].toLowerCase() as 'decision' | 'lesson' | 'method';
    const title = match[2].trim();
    const claim = match[3]?.trim() || title;
    candidates.push({
      kind,
      title,
      claim,
      why_durable: 'Extracted from thread summary',
      evidence: [{ threadId: input.threadId, messageId: input.messages[0]?.id ?? '', span: '' }],
      relatedAnchors: [],
      confidence: 'inferred',
    });
  }

  // Build single segment covering entire batch
  const firstMsg = input.messages[0];
  const lastMsg = input.messages[input.messages.length - 1];
  if (!firstMsg || !lastMsg) return null;

  const segment: TopicSegment = {
    summary,
    topicKey,
    topicLabel,
    boundaryReason: 'single batch',
    boundaryConfidence: 'high',
    fromMessageId: firstMsg.id,
    toMessageId: lastMsg.id,
    messageCount: input.messages.length,
    candidates: candidates.length > 0 ? candidates : undefined,
  };

  return { segments: [segment] };
}

// ─── Client factory ─────────────────────────────────────────────
export function createAbstractiveClient(
  resolveProfile: () => Promise<ProviderProfile | null>,
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void },
): (input: AbstractiveInput) => Promise<AbstractiveResult | null> {
  return async (input: AbstractiveInput): Promise<AbstractiveResult | null> => {
    const profile = await resolveProfile();
    if (!profile || profile.mode !== 'api_key') {
      logger.info('[abstractive-client] no API key profile, skipping');
      return null;
    }

    const userContent = buildUserPrompt(input);

    try {
      const res = await fetch(`${profile.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': profile.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }],
        }),
      });

      if (!res.ok) {
        logger.error(`[abstractive-client] API error ${res.status}: ${res.statusText}`);
        return null;
      }

      const body = (await res.json()) as { content: Array<{ type: string; text?: string }> };
      const text = body.content?.find((c) => c.type === 'text')?.text;
      if (!text) {
        logger.error('[abstractive-client] no text in response');
        return null;
      }

      // Parse natural language output into structured segments
      const result = parseNaturalLanguageOutput(text, input);
      if (!result) {
        logger.error(`[abstractive-client] failed to parse output: ${text.slice(0, 150)}`);
        return null;
      }

      logger.info(
        `[abstractive-client] parsed: "${result.segments[0]?.topicLabel}" (${result.segments[0]?.summary.length} chars, ${result.segments[0]?.candidates?.length ?? 0} candidates)`,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[abstractive-client] fetch/parse error: ${msg}`);
      return null;
    }
  };
}
