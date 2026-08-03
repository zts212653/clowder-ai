import {
  buildHumanDispositionLedgerReceipt,
  type HumanDispositionLedgerEntry,
  type HumanDispositionLedgerReceipt,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { HumanDispositionProducerEntryLoader } from '../../human-disposition/HumanDispositionLedger.js';
import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';
import {
  type PersonMemoryDispositionLineageBinding,
  type PersonMemoryProposalDispositionLineageBinding,
  parseDispositionDecisionReceiptLocator,
  parseDispositionLineageBinding,
  parseDispositionLineageHandleLocator,
  parseProposalDispositionDecisionReceiptLocator,
  parseProposalDispositionLineageBinding,
  parseProposalDispositionLineageHandleLocator,
} from './person-memory-disposition-records.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import { parseStoredCandidate } from './person-memory-records.js';

const MAX_LINEAGE_HOPS = 32;

export interface EligiblePersonMemoryDispositionClosure {
  status: 'eligible';
  ownerUserId: string;
  closurePersonId: string;
  root: StoredPersonMemoryCandidate;
  current: StoredPersonMemoryCandidate;
  chain: StoredPersonMemoryCandidate[];
  bindingKey: string;
}

export interface EligiblePersonMemoryProposalDispositionClosure {
  status: 'proposal_purge_eligible';
  ownerUserId: string;
  root: StoredPersonMemoryCandidate;
  current: StoredPersonMemoryCandidate;
  chain: StoredPersonMemoryCandidate[];
  bindingKey: string;
}

export type PersonMemoryDispositionClosureResolution =
  | EligiblePersonMemoryDispositionClosure
  | EligiblePersonMemoryProposalDispositionClosure
  | { status: 'unbound_or_mixed_forget_dependency' }
  | { status: 'unknown' };

function candidatePersonId(candidate: StoredPersonMemoryCandidate): string | undefined {
  return candidate.materializedPersonId ?? candidate.targetPersonId;
}

function membershipKey(candidate: StoredPersonMemoryCandidate, personId: string): string {
  return candidate.materializedPersonId
    ? PersonMemoryKeys.personCandidates(candidate.ownerUserId, personId)
    : PersonMemoryKeys.targetCandidates(candidate.ownerUserId, personId);
}

function sameReceipt(left: HumanDispositionLedgerReceipt, right: HumanDispositionLedgerReceipt): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class PersonMemoryDispositionProofResolver implements HumanDispositionProducerEntryLoader {
  constructor(private readonly redis: RedisClient) {}

  private artifactMember(key: string): string {
    return `${this.redis.options.keyPrefix ?? ''}${key}`;
  }

  private async loadChain(
    ownerUserId: string,
    currentInput: StoredPersonMemoryCandidate,
  ): Promise<StoredPersonMemoryCandidate[] | null> {
    const chain: StoredPersonMemoryCandidate[] = [];
    const seen = new Set<string>();
    let current: StoredPersonMemoryCandidate | null = currentInput;

    while (current) {
      if (current.ownerUserId !== ownerUserId || seen.has(current.candidateId) || chain.length >= MAX_LINEAGE_HOPS) {
        return null;
      }
      seen.add(current.candidateId);
      chain.push(current);
      if (!current.replacesProposalId) break;
      const raw = await this.redis.get(PersonMemoryKeys.candidate(ownerUserId, current.replacesProposalId));
      try {
        current = parseStoredCandidate(raw);
      } catch {
        return null;
      }
      if (!current) return null;
    }
    return chain;
  }

  private async hasExactClosureMembership(
    ownerUserId: string,
    closurePersonId: string,
    bindingKey: string,
    chain: StoredPersonMemoryCandidate[],
  ): Promise<boolean> {
    for (let index = 0; index < chain.length; index += 1) {
      const candidate = chain[index];
      if (
        candidatePersonId(candidate) !== closurePersonId ||
        (candidate.dispositionLineageBindingKey !== undefined && candidate.dispositionLineageBindingKey !== bindingKey)
      ) {
        return false;
      }
      const child = chain[index - 1];
      if (child && child.replacesProposalId !== candidate.candidateId) return false;
      const candidateKey = PersonMemoryKeys.candidate(ownerUserId, candidate.candidateId);
      const [isMember, isArtifact] = await Promise.all([
        this.redis.sismember(membershipKey(candidate, closurePersonId), candidate.candidateId),
        this.redis.sismember(
          PersonMemoryKeys.personArtifacts(ownerUserId, closurePersonId),
          this.artifactMember(candidateKey),
        ),
      ]);
      if (isMember !== 1 || isArtifact !== 1) return false;
    }
    return true;
  }

  async resolveClosure(
    ownerUserId: string,
    currentInput: StoredPersonMemoryCandidate,
  ): Promise<PersonMemoryDispositionClosureResolution> {
    const chain = await this.loadChain(ownerUserId, currentInput);
    if (!chain) return { status: 'unknown' };
    const root = chain.at(-1);
    const closurePersonId = candidatePersonId(currentInput);
    if (!root) return { status: 'unknown' };
    const bindingKey = PersonMemoryKeys.dispositionLineageBinding(ownerUserId, root.candidateId);
    if (chain.every((candidate) => candidatePersonId(candidate) === undefined)) {
      return {
        status: 'proposal_purge_eligible',
        ownerUserId,
        root,
        current: currentInput,
        chain,
        bindingKey,
      };
    }
    if (!closurePersonId) return { status: 'unbound_or_mixed_forget_dependency' };
    const isExactClosure = await this.hasExactClosureMembership(ownerUserId, closurePersonId, bindingKey, chain);
    if (!isExactClosure) return { status: 'unbound_or_mixed_forget_dependency' };
    return {
      status: 'eligible',
      ownerUserId,
      closurePersonId,
      root,
      current: currentInput,
      chain,
      bindingKey,
    };
  }

  async loadBinding(
    closure: EligiblePersonMemoryDispositionClosure,
  ): Promise<PersonMemoryDispositionLineageBinding | null> {
    const binding = parseDispositionLineageBinding(await this.redis.get(closure.bindingKey));
    if (
      !binding ||
      binding.ownerUserId !== closure.ownerUserId ||
      binding.closurePersonId !== closure.closurePersonId ||
      binding.rootCandidateId !== closure.root.candidateId
    ) {
      return null;
    }
    const locator = parseDispositionLineageHandleLocator(
      await this.redis.get(
        PersonMemoryKeys.dispositionLineageHandleLocator(closure.ownerUserId, binding.opaqueLineageHandle),
      ),
    );
    if (!locator || locator.bindingKey !== closure.bindingKey || locator.closurePersonId !== closure.closurePersonId) {
      return null;
    }
    return binding;
  }

  async loadProposalBinding(
    closure: EligiblePersonMemoryProposalDispositionClosure,
  ): Promise<PersonMemoryProposalDispositionLineageBinding | null> {
    const binding = parseProposalDispositionLineageBinding(await this.redis.get(closure.bindingKey));
    if (
      !binding ||
      binding.ownerUserId !== closure.ownerUserId ||
      binding.purgeScope !== 'exact_proposal' ||
      binding.rootCandidateId !== closure.root.candidateId
    ) {
      return null;
    }
    const locator = parseProposalDispositionLineageHandleLocator(
      await this.redis.get(
        PersonMemoryKeys.dispositionLineageHandleLocator(closure.ownerUserId, binding.opaqueLineageHandle),
      ),
    );
    if (
      !locator ||
      locator.bindingKey !== closure.bindingKey ||
      locator.purgeScope !== 'exact_proposal' ||
      locator.rootCandidateId !== closure.root.candidateId
    ) {
      return null;
    }
    return binding;
  }

  async loadEntry(input: {
    ownerUserId: string;
    receipt: HumanDispositionLedgerReceipt;
  }): Promise<HumanDispositionLedgerEntry | null> {
    const locatorRaw = await this.redis.get(
      PersonMemoryKeys.dispositionDecisionReceiptLocator(input.ownerUserId, input.receipt.sourceRef),
    );
    const locator = parseDispositionDecisionReceiptLocator(locatorRaw);
    const proposalLocator = parseProposalDispositionDecisionReceiptLocator(locatorRaw);
    if (!locator && !proposalLocator) return null;
    const activeLocator = locator ?? proposalLocator;
    if (!activeLocator) return null;
    const candidate = parseStoredCandidate(await this.redis.get(activeLocator.candidateKey));
    if (
      !candidate ||
      candidate.ownerUserId !== input.ownerUserId ||
      candidate.dispositionLineageBindingKey !== activeLocator.bindingKey ||
      candidate.humanDispositionLedgerEntry === undefined
    ) {
      return null;
    }
    const closure = await this.resolveClosure(input.ownerUserId, candidate);
    if (proposalLocator) {
      if (
        closure.status !== 'proposal_purge_eligible' ||
        closure.bindingKey !== proposalLocator.bindingKey ||
        closure.root.candidateId !== proposalLocator.rootCandidateId
      ) {
        return null;
      }
      const binding = await this.loadProposalBinding(closure);
      if (
        !binding ||
        binding.latestDecisionReceiptHandle !== input.receipt.sourceRef ||
        binding.currentCandidateId !== candidate.candidateId ||
        binding.opaqueLineageHandle !== input.receipt.subjectRef
      ) {
        return null;
      }
      return sameReceipt(buildHumanDispositionLedgerReceipt(candidate.humanDispositionLedgerEntry), input.receipt)
        ? candidate.humanDispositionLedgerEntry
        : null;
    }
    if (
      closure.status !== 'eligible' ||
      !locator ||
      closure.bindingKey !== locator.bindingKey ||
      closure.closurePersonId !== locator.closurePersonId
    ) {
      return null;
    }
    const binding = await this.loadBinding(closure);
    if (
      !binding ||
      binding.latestDecisionReceiptHandle !== input.receipt.sourceRef ||
      binding.currentCandidateId !== candidate.candidateId ||
      binding.opaqueLineageHandle !== input.receipt.subjectRef
    ) {
      return null;
    }
    return sameReceipt(buildHumanDispositionLedgerReceipt(candidate.humanDispositionLedgerEntry), input.receipt)
      ? candidate.humanDispositionLedgerEntry
      : null;
  }
}
