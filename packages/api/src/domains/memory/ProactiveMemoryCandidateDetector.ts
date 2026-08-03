import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isDelivered } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import { getTimelineOrderTime, isSystemUserMessage } from '../cats/services/stores/visibility.js';
import {
  DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG,
  type ProactiveMemoryCandidate,
  type ProactiveMemoryCandidateConfig,
} from './proactive-memory-candidate-contract.js';
import { extractCandidatePhrases, normalizeCandidatePhrase } from './proactive-memory-lexical-noise.js';
import { resolveThreadPrivacy } from './thread-privacy-resolver.js';

type CandidateMessageStore = Pick<IMessageStore, 'getById' | 'listOwnerMessagesInWindow'>;
type CandidateThreadStore = Pick<IThreadStore, 'get'>;

export interface ProactiveMemoryCandidateDetectorInput {
  readonly ownerUserId: string;
  readonly currentUserMessageId: string;
  readonly now?: number;
}

interface CandidateOccurrence {
  displayPhrase: string;
  hasCompleteSegment: boolean;
  readonly messageIdsByThread: Map<string, Set<string>>;
}

interface FrequencyWindow {
  readonly recentSinceInclusive: number;
  readonly backgroundEligibleMessageCount: number;
  readonly recentEligibleMessageCount: number;
  readonly messageTimeById: ReadonlyMap<string, number>;
}

export class ProactiveMemoryCandidateDetector {
  private readonly config: ProactiveMemoryCandidateConfig;

  constructor(
    private readonly messageStore: CandidateMessageStore,
    private readonly threadStore: CandidateThreadStore,
    config?: Partial<ProactiveMemoryCandidateConfig>,
  ) {
    this.config = Object.freeze({ ...DEFAULT_PROACTIVE_MEMORY_CANDIDATE_CONFIG, ...config });
  }

  getConfig(): ProactiveMemoryCandidateConfig {
    return this.config;
  }

  async detect(input: ProactiveMemoryCandidateDetectorInput): Promise<ProactiveMemoryCandidate[]> {
    try {
      const currentMessage = await this.messageStore.getById(input.currentUserMessageId);
      if (!currentMessage || !(await this.isEligibleMessage(currentMessage, input.ownerUserId))) return [];
      const untilInclusive = input.now ?? getTimelineOrderTime(currentMessage);
      const sinceInclusive = Math.max(0, untilInclusive - this.config.windowMs);

      const messages = await this.messageStore.listOwnerMessagesInWindow(
        input.ownerUserId,
        sinceInclusive,
        untilInclusive,
      );
      const eligibleMessages = await this.filterEligibleMessages(messages, input.ownerUserId);
      if (!eligibleMessages.some((message) => message.id === currentMessage.id)) return [];

      return this.buildCandidates(eligibleMessages, sinceInclusive, untilInclusive);
    } catch {
      return [];
    }
  }

  private async filterEligibleMessages(
    messages: readonly StoredMessage[],
    ownerUserId: string,
  ): Promise<StoredMessage[]> {
    const privacyByThread = new Map<string, boolean>();
    const eligible: StoredMessage[] = [];

    for (const message of messages) {
      if (!this.isEligibleMessageShape(message, ownerUserId)) continue;
      let isPrivate = privacyByThread.get(message.threadId);
      if (isPrivate === undefined) {
        isPrivate = await this.resolvePrivateFailClosed(message.threadId);
        privacyByThread.set(message.threadId, isPrivate);
      }
      if (!isPrivate) eligible.push(message);
    }

    return eligible;
  }

  private async isEligibleMessage(message: StoredMessage | null, ownerUserId: string): Promise<boolean> {
    if (!message || !this.isEligibleMessageShape(message, ownerUserId)) return false;
    return !(await this.resolvePrivateFailClosed(message.threadId));
  }

  private isEligibleMessageShape(message: StoredMessage, ownerUserId: string): boolean {
    return (
      message.userId === ownerUserId &&
      message.catId === null &&
      message.source === undefined &&
      isDelivered(message) &&
      !message.deletedAt &&
      !message._tombstone &&
      message.visibility !== 'whisper' &&
      message.origin !== 'briefing' &&
      message.extra?.systemKind === undefined &&
      !isSystemUserMessage(message) &&
      message.content.trim().length > 0
    );
  }

  private async resolvePrivateFailClosed(threadId: string): Promise<boolean> {
    try {
      return await resolveThreadPrivacy(threadId, this.threadStore);
    } catch {
      return true;
    }
  }

  private buildCandidates(
    messages: readonly StoredMessage[],
    sinceInclusive: number,
    untilInclusive: number,
  ): ProactiveMemoryCandidate[] {
    const occurrences = new Map<string, CandidateOccurrence>();
    const recentSinceInclusive = Math.max(sinceInclusive, untilInclusive - this.config.recentWindowMs);
    const messageTimeById = new Map(messages.map((message) => [message.id, getTimelineOrderTime(message)]));
    const frequencyWindow: FrequencyWindow = {
      recentSinceInclusive,
      backgroundEligibleMessageCount: messages.filter((message) => getTimelineOrderTime(message) < recentSinceInclusive)
        .length,
      recentEligibleMessageCount: messages.filter((message) => getTimelineOrderTime(message) >= recentSinceInclusive)
        .length,
      messageTimeById,
    };

    for (const message of messages) {
      const extracted = extractCandidatePhrases(message.content);
      const completeSegments = new Map(
        [...extracted.completeSegments].map((phrase) => [normalizeCandidatePhrase(phrase), phrase]),
      );
      const uniquePhrases = new Map(extracted.phrases.map((phrase) => [normalizeCandidatePhrase(phrase), phrase]));

      for (const [normalizedPhrase, phrase] of uniquePhrases) {
        const completeDisplay = completeSegments.get(normalizedPhrase);
        let occurrence = occurrences.get(normalizedPhrase);
        if (!occurrence) {
          occurrence = {
            displayPhrase: completeDisplay ?? phrase,
            hasCompleteSegment: completeDisplay !== undefined,
            messageIdsByThread: new Map(),
          };
          occurrences.set(normalizedPhrase, occurrence);
        } else if (!occurrence.hasCompleteSegment && completeDisplay !== undefined) {
          occurrence.displayPhrase = completeDisplay;
          occurrence.hasCompleteSegment = true;
        }

        let messageIds = occurrence.messageIdsByThread.get(message.threadId);
        if (!messageIds) {
          messageIds = new Set();
          occurrence.messageIdsByThread.set(message.threadId, messageIds);
        }
        messageIds.add(message.id);
      }
    }

    const candidates = [...occurrences.entries()]
      .map(([normalizedPhrase, occurrence]) =>
        this.toCandidate(
          normalizedPhrase,
          occurrence,
          messages.length,
          sinceInclusive,
          untilInclusive,
          frequencyWindow,
        ),
      )
      .filter((candidate): candidate is ProactiveMemoryCandidate => candidate !== null);

    const deduped = candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) =>
            other.normalizedPhrase !== candidate.normalizedPhrase &&
            other.normalizedPhrase.includes(candidate.normalizedPhrase),
        ),
    );

    return deduped.sort(
      (left, right) =>
        left.messageShare - right.messageShare ||
        right.distinctThreadCount - left.distinctThreadCount ||
        right.distinctMessageCount - left.distinctMessageCount ||
        [...right.normalizedPhrase].length - [...left.normalizedPhrase].length ||
        left.normalizedPhrase.localeCompare(right.normalizedPhrase),
    );
  }

  private toCandidate(
    normalizedPhrase: string,
    occurrence: CandidateOccurrence,
    eligibleMessageCount: number,
    sinceInclusive: number,
    untilInclusive: number,
    frequencyWindow: FrequencyWindow,
  ): ProactiveMemoryCandidate | null {
    const distinctThreadCount = occurrence.messageIdsByThread.size;
    const distinctMessageCount = [...occurrence.messageIdsByThread.values()].reduce(
      (total, messageIds) => total + messageIds.size,
      0,
    );
    if (
      !occurrence.hasCompleteSegment ||
      distinctThreadCount < this.config.minDistinctThreads ||
      distinctMessageCount < this.config.minDistinctMessages
    ) {
      return null;
    }

    const occurrenceMessageIds = new Set(
      [...occurrence.messageIdsByThread.values()].flatMap((messageIds) => [...messageIds]),
    );
    const backgroundDistinctMessageCount = [...occurrenceMessageIds].filter(
      (messageId) =>
        (frequencyWindow.messageTimeById.get(messageId) ?? Number.POSITIVE_INFINITY) <
        frequencyWindow.recentSinceInclusive,
    ).length;
    const recentDistinctMessageCount = distinctMessageCount - backgroundDistinctMessageCount;
    const backgroundMessageShare = this.ratio(
      backgroundDistinctMessageCount,
      frequencyWindow.backgroundEligibleMessageCount,
    );
    const recentMessageShare = this.ratio(recentDistinctMessageCount, frequencyWindow.recentEligibleMessageCount);
    if (
      frequencyWindow.backgroundEligibleMessageCount >= this.config.minBackgroundMessages &&
      (recentDistinctMessageCount === 0 || recentMessageShare < backgroundMessageShare * this.config.minRecentBurstLift)
    ) {
      return null;
    }

    const sourceCoordinates = [...occurrence.messageIdsByThread.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([threadId, messageIds]) => ({
        threadId,
        messageIds: [...messageIds].sort(),
      }));

    return {
      phrase: occurrence.displayPhrase,
      normalizedPhrase,
      window: { sinceInclusive, untilInclusive },
      distinctThreadCount,
      distinctMessageCount,
      messageShare: this.ratio(distinctMessageCount, eligibleMessageCount),
      frequency: {
        background: {
          untilExclusive: frequencyWindow.recentSinceInclusive,
          eligibleMessageCount: frequencyWindow.backgroundEligibleMessageCount,
          distinctMessageCount: backgroundDistinctMessageCount,
          messageShare: backgroundMessageShare,
        },
        recentBurst: {
          sinceInclusive: frequencyWindow.recentSinceInclusive,
          eligibleMessageCount: frequencyWindow.recentEligibleMessageCount,
          distinctMessageCount: recentDistinctMessageCount,
          messageShare: recentMessageShare,
        },
      },
      sourceCoordinates,
    };
  }

  private ratio(numerator: number, denominator: number): number {
    return denominator === 0 ? 0 : numerator / denominator;
  }
}
