/** Abstractive summary transport; coverage comes from the actual prepared input. */
import { buildProviderEndpoint } from '../../config/provider-endpoint.js';
import { prepareAbstractiveBatch } from './abstractive-summary-input.js';
import { MAX_CANDIDATES_PER_SEGMENT, parseNaturalLanguageOutput } from './abstractive-summary-output.js';
import { buildAbstractiveSummaryPrompt } from './abstractive-summary-prompt.js';
import type { AbstractiveInput, AbstractiveResult } from './abstractive-summary-types.js';

export {
  isImplementationNoise,
  MAX_CANDIDATES_PER_SEGMENT,
  parseNaturalLanguageOutput,
} from './abstractive-summary-output.js';
export type {
  AbstractiveInput,
  AbstractiveMessage,
  AbstractiveResult,
  DurableCandidate,
  TopicSegment,
} from './abstractive-summary-types.js';

interface ProviderProfile {
  mode: 'api_key' | 'subscription';
  baseUrl: string;
  apiKey: string;
}

// ─── Client factory ─────────────────────────────────────────────
export function createAbstractiveClient(
  resolveProfile: () => Promise<ProviderProfile | null>,
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void },
): (input: AbstractiveInput) => Promise<AbstractiveResult | null> {
  return async (input: AbstractiveInput): Promise<AbstractiveResult | null> => {
    try {
      const profile = await resolveProfile();
      if (!profile || profile.mode !== 'api_key') {
        logger.info('[abstractive-client] no API key profile, skipping');
        return null;
      }
      const prepared = prepareAbstractiveBatch(input);
      if (!prepared) return null;
      const results: AbstractiveResult[] = [];
      for (const userContent of prepared.prompts) {
        const result = await generateSummaryFragment(profile, userContent, prepared.input, logger);
        if (!result) return null;
        results.push(result);
      }
      return mergeSummaryFragments(results);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[abstractive-client] fetch/parse error: ${msg}`);
      return null;
    }
  };
}

async function generateSummaryFragment(
  profile: ProviderProfile,
  userContent: string,
  input: AbstractiveInput,
  logger: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void },
): Promise<AbstractiveResult | null> {
  const res = await fetch(buildProviderEndpoint({ protocol: 'anthropic', baseUrl: profile.baseUrl }), {
    method: 'POST',
    redirect: 'error',
    headers: {
      'x-api-key': profile.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      system: buildAbstractiveSummaryPrompt(),
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    logger.error(`[abstractive-client] API error ${res.status}: ${res.statusText}`);
    return null;
  }

  const body = (await res.json()) as { content: Array<{ type: string; text?: string }>; stop_reason?: string };
  if (body.stop_reason === 'max_tokens') {
    logger.error('[abstractive-client] incomplete model output; keeping watermark unchanged');
    return null;
  }
  const text = body.content
    ?.filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
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
}

function mergeSummaryFragments(results: AbstractiveResult[]): AbstractiveResult | null {
  const first = results[0]?.segments[0];
  if (!first) return null;
  // Preserve the existing per-segment candidate cap when fragment results combine.
  const candidates = results.flatMap((result) => result.segments[0].candidates ?? []);
  candidates.sort((a, b) => (a.confidence === 'explicit' ? 0 : 1) - (b.confidence === 'explicit' ? 0 : 1));
  // A fragmented message is acknowledged once, after every fragment succeeded.
  return {
    segments: [
      {
        ...first,
        summary: results.map((result) => result.segments[0].summary).join('\n\n'),
        candidates: candidates.slice(0, MAX_CANDIDATES_PER_SEGMENT),
      },
    ],
  };
}
