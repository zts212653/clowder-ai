import {
  HUMAN_DISPOSITION_REASON_CORRECTIONS,
  type HumanDispositionEnvelope,
  isHumanDispositionEnvelopeEligible,
} from '@cat-cafe/shared';
import type { PersonMemoryDispositionSubjectProof } from '../memory/people/PersonMemoryDispositionSubjectProofResolver.js';
import { extractCandidatePhrases, normalizeCandidatePhrase } from '../memory/proactive-memory-lexical-noise.js';
import type { HumanDispositionLedger } from './HumanDispositionLedger.js';

const MAX_LEXICAL_CANDIDATES = 50;
const MAX_ROOTS_PER_TURN = 3;
const MAX_ENTRIES_PER_ROOT = 100;
const MAX_SCANNED_PER_ROOT = 500;

interface SubjectProofResolverPort {
  resolve(input: { ownerUserId: string; phrase: string }): Promise<PersonMemoryDispositionSubjectProof>;
}

interface FeedbackContextLogger {
  warn(fields: { reason: string }, message: string): void;
}

export interface HumanDispositionFeedbackContextServiceDeps {
  subjectResolver: SubjectProofResolverPort;
  ledger: Pick<HumanDispositionLedger, 'query'>;
  logger?: FeedbackContextLogger;
}

export interface HumanDispositionFeedbackContextInput {
  ownerUserId: string;
  text: string;
  now?: number;
}

function lexicalCandidates(text: string): string[] {
  const extracted = extractCandidatePhrases(text);
  const complete = [...extracted.completeSegments];
  const completeKeys = new Set(complete.map(normalizeCandidatePhrase));
  const remaining = extracted.phrases.filter((phrase) => !completeKeys.has(normalizeCandidatePhrase(phrase)));
  const unique = new Map<string, string>();
  for (const phrase of [...complete, ...remaining]) {
    const normalized = normalizeCandidatePhrase(phrase);
    if (normalized && !unique.has(normalized)) unique.set(normalized, phrase);
    if (unique.size === MAX_LEXICAL_CANDIDATES) break;
  }
  return [...unique.values()];
}

function newestEnvelope(entries: Array<{ envelope?: HumanDispositionEnvelope }>): HumanDispositionEnvelope | null {
  return entries.find((entry) => entry.envelope)?.envelope ?? null;
}

function renderContext(
  corrections: Array<{ reason: keyof typeof HUMAN_DISPOSITION_REASON_CORRECTIONS; correction: string }>,
): string {
  if (corrections.length === 0) return '';
  const lines = corrections.map(
    ({ reason, correction }) => `- scope=exact_subject reason=${reason} correction=${correction}`,
  );
  return (
    '\n[human-disposition-feedback]\n' +
    '以下是co-creator对当前 exact subject 的已验证定向反馈；只修正该 subject，不外推到 lane、其他 subject 或猫的整体判断：\n' +
    `${lines.join('\n')}\n` +
    '[/human-disposition-feedback]'
  );
}

export class HumanDispositionFeedbackContextService {
  constructor(private readonly deps: HumanDispositionFeedbackContextServiceDeps) {}

  async prepare(input: HumanDispositionFeedbackContextInput): Promise<string> {
    const corrections: Array<{
      reason: keyof typeof HUMAN_DISPOSITION_REASON_CORRECTIONS;
      correction: string;
    }> = [];
    const seenRoots = new Set<string>();
    const now = input.now ?? Date.now();

    for (const phrase of lexicalCandidates(input.text)) {
      try {
        const proof = await this.deps.subjectResolver.resolve({
          ownerUserId: input.ownerUserId,
          phrase,
        });
        if (proof.status !== 'verified' || seenRoots.has(proof.subjectRef)) continue;
        seenRoots.add(proof.subjectRef);
        const page = await this.deps.ledger.query(input.ownerUserId, {
          limit: MAX_ENTRIES_PER_ROOT,
          scanLimit: MAX_SCANNED_PER_ROOT,
          interactionKind: 'person_memory_proposal',
          subjectRef: proof.subjectRef,
        });
        const envelope = newestEnvelope(page.entries);
        if (
          !envelope ||
          envelope.interactionKind !== 'person_memory_proposal' ||
          envelope.invalidator.kind !== 'source_superseded'
        ) {
          continue;
        }
        const eligible = isHumanDispositionEnvelopeEligible(envelope, {
          subjectRef: proof.subjectRef,
          proposalLineage: { status: 'verified', rootProposalId: proof.subjectRef },
          now,
          invalidatorTruth: {
            kind: 'source_superseded',
            status: 'verified',
            supersessionKey: proof.currentSupersessionKey,
            superseded: envelope.invalidator.supersessionKey !== proof.currentSupersessionKey,
          },
        });
        if (!eligible) continue;
        const reason = envelope.feedback.reasonCode;
        corrections.push({
          reason,
          correction: HUMAN_DISPOSITION_REASON_CORRECTIONS[reason].correctionDirection,
        });
        if (corrections.length === MAX_ROOTS_PER_TURN) break;
      } catch {
        this.deps.logger?.warn(
          { reason: 'unprovable_exact_subject_feedback' },
          'F281 exact-subject feedback projection failed closed',
        );
      }
    }
    return renderContext(corrections);
  }
}
