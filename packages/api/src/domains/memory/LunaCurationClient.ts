import type Database from 'better-sqlite3';
import type { AgentService, AgentServiceOptions, TokenUsage } from '../cats/services/types.js';
import { prepareAbstractiveBatch } from './abstractive-summary-input.js';
import type { AbstractiveInput, AbstractiveResult, SummaryGenerationUsage } from './abstractive-summary-types.js';
import { curationSourceIdResolver } from './curation/curation-source-ids.js';
import {
  isCanonicalThreadOverview,
  overviewRevision,
  overviewSourceIds,
  takeCurationSession,
} from './curation/LunaCurationState.js';
import { runLunaNative } from './curation/LunaNativeRun.js';
import { LUNA_CURATION_PROMPT, LUNA_CURATION_PROMPT_VERSION } from './luna-curation-prompt.js';

export interface CurationProvider {
  catId: string;
  model: string;
  accountIdentity?: string;
  service: Pick<AgentService, 'invoke'>;
  options?: AgentServiceOptions;
}
interface LunaClientDeps {
  resolveService: () => CurationProvider;
  workingDirectory: string;
  db?: Database.Database;
  ownerUserId?: string;
  isSourceReadable?: (threadId: string, messageId: string) => Promise<boolean>;
  logger: { info: (text: string) => void; error: (text: string) => void };
}

/** Per-source native context is disposable; the committed overview remains authority. */
export function createLunaCurationClient(deps: LunaClientDeps) {
  const active = new Map<string, Promise<unknown>>();
  return (input: AbstractiveInput, signal?: AbortSignal, onUsage?: (usage: SummaryGenerationUsage) => void) => {
    const key = input.threadId;
    const prior = active.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => curate(input, signal, onUsage));
    active.set(key, next);
    void next
      .finally(() => {
        if (active.get(key) === next) active.delete(key);
      })
      .catch(() => {});
    return next;
  };

  async function curate(
    input: AbstractiveInput,
    signal?: AbortSignal,
    onUsage?: (usage: SummaryGenerationUsage) => void,
  ): Promise<AbstractiveResult | null> {
    const started = Date.now();
    const prepared = prepareAbstractiveBatch(input);
    if (!prepared) return null;
    const usage: SummaryGenerationUsage = {
      threadId: input.threadId,
      messageCount: prepared.input.messages.length,
      modelId: 'unknown',
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    };
    try {
      const resolved = deps.resolveService();
      usage.modelId = resolved.model;
      const identity = `${resolved.catId}:${resolved.model}:${resolved.accountIdentity ?? resolved.options?.codexAccountLaunch?.accountRevision ?? 'legacy'}:${LUNA_CURATION_PROMPT_VERSION}:${deps.workingDirectory}`;
      const owner = deps.ownerUserId ?? 'default-user';
      if (
        deps.isSourceReadable &&
        !(
          await Promise.all(
            prepared.input.messages.map((message) => deps.isSourceReadable!(input.threadId, message.id)),
          )
        ).every(Boolean)
      )
        return null;
      const prior = deps.db ? takeCurationSession(deps.db, owner, input.threadId) : undefined;
      const oldIds =
        deps.db && isCanonicalThreadOverview(deps.db, owner, input.threadId, input.previousSummary)
          ? overviewSourceIds(input.previousSummary, input.threadId)
          : [];
      const validOld = deps.isSourceReadable
        ? (
            await Promise.all(
              oldIds.map(async (id) => ((await deps.isSourceReadable!(input.threadId, id)) ? id : null)),
            )
          ).filter((id): id is string => id !== null)
        : [];
      const sourcesChanged = validOld.length !== oldIds.length;
      const allowed = new Set([...validOld, ...prepared.input.messages.map((m) => m.id)]);
      let sessionId =
        !sourcesChanged &&
        prior?.providerIdentity === identity &&
        prior.summaryRevision === overviewRevision(input.previousSummary)
          ? (prior.sessionId ?? undefined)
          : undefined;
      // Remove a whole prior claim if any of its evidence was withdrawn.
      const previousSummary =
        oldIds.length === 0
          ? null
          : sourcesChanged
            ? (input.previousSummary
                ?.split('\n')
                .filter((line) => overviewSourceIds(line, input.threadId).every((id) => allowed.has(id)))
                .join('\n') ?? null)
            : input.previousSummary;
      const safePrepared = prepareAbstractiveBatch({ ...input, previousSummary })!;
      let current = previousSummary;
      let directoryLine = '';
      for (let index = 0; index < safePrepared.prompts.length; index++) {
        signal?.throwIfAborted();
        const fragmentPrompt =
          index > 0 && current
            ? `${safePrepared.prompts[index]}\n\nCurrent overview from earlier fragments (retain valid facts):\n${current}`
            : safePrepared.prompts[index];
        const prompt = `${fragmentPrompt}\n\nAllowed source IDs: ${[...allowed].join(', ')}`;
        let fragment = await runLunaNative({
          provider: resolved,
          prompt,
          instructions: LUNA_CURATION_PROMPT,
          workingDirectory: deps.workingDirectory,
          signal,
          ...(sessionId ? { sessionId } : {}),
        });
        addUsage(usage, fragment.usage);
        // One fresh reconstruction after an invalid/overlong native session.
        if (!fragment.success && sessionId && !signal?.aborted) {
          fragment = await runLunaNative({
            provider: resolved,
            prompt,
            instructions: LUNA_CURATION_PROMPT,
            workingDirectory: deps.workingDirectory,
            signal,
          });
          addUsage(usage, fragment.usage);
        }
        if (!fragment.success) return null;
        usage.modelId = fragment.modelId;
        sessionId = fragment.sessionId;
        const parsed = parseCuration(fragment.text, input.threadId, allowed);
        if (!parsed) return null;
        current = parsed.summary;
        directoryLine = parsed.directoryLine;
      }
      if (!current) return null;
      if (
        deps.isSourceReadable &&
        !(
          await Promise.all(
            overviewSourceIds(current, input.threadId).map((id) => deps.isSourceReadable!(input.threadId, id)),
          )
        ).every(Boolean)
      )
        return null;
      const result: AbstractiveResult = {
        modelId: usage.modelId,
        promptVersion: LUNA_CURATION_PROMPT_VERSION,
        segments: [
          {
            summary: current,
            topicKey: 'thread-overview',
            topicLabel: directoryLine || '线程概况',
            boundaryReason: 'current narrative overview',
            boundaryConfidence: 'high',
            fromMessageId: prepared.input.messages[0].id,
            toMessageId: prepared.input.messages.at(-1)!.id,
            messageCount: prepared.input.messages.length,
            candidates: [],
          },
        ],
        curationState: {
          ownerUserId: owner,
          sessionId: sessionId ?? null,
          providerIdentity: identity,
          summaryRevision: overviewRevision(current),
          directoryLine,
        },
      };
      if (usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== null)
        result.usage = {
          inputTokens: usage.inputTokens!,
          outputTokens: usage.outputTokens!,
          totalTokens: usage.totalTokens,
          ...(usage.cacheReadTokens !== null ? { cacheReadTokens: usage.cacheReadTokens! } : {}),
        };
      return result;
    } catch (error) {
      deps.logger.error(`[memory-curation] ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      if (usage.modelId === 'unknown') {
        usage.totalTokens = null;
        usage.inputTokens = null;
        usage.outputTokens = null;
        usage.cacheReadTokens = null;
      }
      usage.elapsedMs = Date.now() - started;
      try {
        onUsage?.(usage);
      } catch (error) {
        deps.logger.error(`[memory-curation] usage unavailable: ${String(error)}`);
      }
    }
  }
}

function parseCuration(text: string, threadId: string, allowed: Set<string>) {
  const resolveId = curationSourceIdResolver(allowed);
  const lines = text
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  while (lines.at(-1)?.match(/^\[[^\]\n]+\/[^\]\n]+🐾\]$/u)) lines.pop();
  const directoryLine =
    lines
      .find((line) => line.startsWith('# '))
      ?.slice(2)
      .trim() ?? '';
  const claims = lines.filter((line) => !line.startsWith('#'));
  if (!claims.length) return null;
  const projected: string[] = [];
  for (const line of claims) {
    const suffix = line.match(/\s*\[sources:\s*([^\]]+)\]\s*$/i);
    if (!suffix) return null;
    const ids = [
      ...new Set(
        suffix[1].split(',').map((label) => {
          return resolveId(label);
        }),
      ),
    ];
    if (!ids.length || ids.some((id) => id === null || !allowed.has(id))) return null;
    projected.push(
      `${line.slice(0, suffix.index).trim()} （来源：${ids.map((id) => `${threadId}#${id}`).join('，')}）`,
    );
  }
  return { summary: projected.join('\n'), directoryLine: directoryLine.slice(0, 300) };
}

function addUsage(total: SummaryGenerationUsage, usage?: TokenUsage) {
  const tokens =
    usage?.totalTokens ??
    (usage?.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : null);
  total.totalTokens = total.totalTokens === null || tokens === null ? null : total.totalTokens + tokens;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens'] as const)
    total[key] = total[key] === null || usage?.[key] === undefined ? null : (total[key] ?? 0) + usage[key]!;
}
