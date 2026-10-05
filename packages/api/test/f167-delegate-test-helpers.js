/**
 * F167 × F322 — Shared test infrastructure for approved-child delegation tests.
 *
 * Constants, mock factories, and helpers used across the split test suites.
 * Extracted to keep individual test files under the 350-line hard limit.
 */

// ── shared constants ──

export const TASK_ID = 'task-f322';
export const SUBJECT_REF = `subject:task:${TASK_ID}`;
export const OWNER_CAT = 'codex-astra';
export const OWNER_THREAD = 'thread-owner';
export const CHILD_CAT = 'codex6-sol';
export const CHILD_THREAD = 'thread-child';
export const TENANT = 'user-1';
export const PROPOSAL_ID = 'prop-f322-child';
export const SOURCE_CAT = OWNER_CAT; // the cat that proposed the child thread

/** F167 R5: default development scope for tests. All delegation tests need scope. */
export const DEV_SCOPE = {
  featureRef: 'feature:F322',
  phaseKey: 'B',
  workUnitRef: 'feature-phase:F322:B',
  acceptedSourceRef: 'file:docs/features/F322.md',
  acceptedRevision: 'a'.repeat(40),
};

export const APPROVED_DELEGATE = {
  catId: CHILD_CAT,
  threadId: CHILD_THREAD,
  evidenceRef: `proposal:prop-f322-child:approved:thread:${CHILD_THREAD}`,
};

// ── simple helpers ──

export function ownerFreshness(overrides = {}) {
  return {
    status: 'verified',
    evidenceRef: `task:${TASK_ID}:active:100`,
    freshnessKey: `task:${TASK_ID}`,
    ownerCatId: OWNER_CAT,
    holderThreadId: OWNER_THREAD,
    tenantScope: TENANT,
    ...overrides,
  };
}

export function holderSnapshot(overrides = {}) {
  return {
    holderCatIds: [OWNER_CAT],
    targetThreadId: OWNER_THREAD,
    tenantScope: TENANT,
    ...overrides,
  };
}

export function makeTask(overrides = {}) {
  return {
    id: TASK_ID,
    status: 'doing',
    ownerCatId: OWNER_CAT,
    threadId: OWNER_THREAD,
    userId: TENANT,
    updatedAt: 100,
    developmentScope: DEV_SCOPE,
    ...overrides,
  };
}

export function admissionRequest(overrides = {}) {
  return {
    tenantScope: TENANT,
    actorCatId: CHILD_CAT,
    sourceThreadId: CHILD_THREAD,
    targetThreadId: CHILD_THREAD,
    holderCatIds: [CHILD_CAT],
    dispatchId: 'dispatch:f322-child-1',
    evidenceRef: 'message:f322-req-1',
    now: 200,
    action: {
      subjectRef: SUBJECT_REF,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'existing_standing',
      groundingEvidenceRef: 'message:f322-grounding',
      terminalPredicate: { kind: 'task_done' },
    },
    ...overrides,
  };
}

// ── proposal helpers ──

export function makeProposal(overrides = {}) {
  return {
    proposalId: PROPOSAL_ID,
    status: 'approved',
    createdThreadId: CHILD_THREAD,
    sourceThreadId: OWNER_THREAD,
    createdBy: TENANT,
    preferredCats: [CHILD_CAT],
    approvedDevelopmentScope: DEV_SCOPE,
    ...overrides,
  };
}

export function makeProposalStore(proposal) {
  return {
    async get(id) {
      return id === proposal?.proposalId ? proposal : null;
    },
  };
}

export function makeBindingProvider({ taskId = TASK_ID, tenantScope = TENANT, binding = null } = {}) {
  return {
    async getBindingForTask(reqTaskId, _taskThreadId, reqTenant) {
      if (reqTaskId === taskId && reqTenant === tenantScope) {
        return binding;
      }
      return null;
    },
  };
}

export function makeProposalListItem(overrides = {}) {
  return {
    proposalId: PROPOSAL_ID,
    status: 'approved',
    createdThreadId: CHILD_THREAD,
    createdBy: TENANT,
    sourceCatId: SOURCE_CAT,
    subjectTaskId: TASK_ID,
    ...overrides,
  };
}

export function makeProposalLister(proposals = []) {
  return {
    async listByThread(_threadId, _limit) {
      return proposals;
    },
  };
}

// ── mock lease store factory ──

export function mockLeaseStore() {
  return {
    claimedLease: null,
    async claim(input) {
      this.claimedLease = input;
      return {
        outcome: 'claimed',
        lease: {
          leaseId: input.leaseId,
          key: `${input.tenantScope}|${SUBJECT_REF}|implement|implementer`,
          tenantScope: input.tenantScope,
          subjectRef: SUBJECT_REF,
          actionFamily: 'implement',
          successorSlot: 'implementer',
          mode: 'single',
          holderCatIds: input.holderCatIds,
          generation: 1,
          dispatchId: input.dispatchId,
          evidenceRefs: input.evidenceRefs,
          status: 'active',
          holderOutcomes: {},
          createdAt: 100,
          terminalPredicate: input.terminalPredicate,
        },
      };
    },
    async get() {
      return null;
    },
    async replace() {
      return { outcome: 'replaced' };
    },
    async commitOutcome() {},
    async returnToPredecessor() {
      return { outcome: 'returned' };
    },
    async markReturnDelivered() {
      return { outcome: 'delivered' };
    },
    async continueFreshRevision() {
      return { outcome: 'continued' };
    },
  };
}

// ── mock truth store factory (for resolver-level tests) ──

export function mockTruthLeaseStore() {
  return {
    async getSubjectTerminal() {
      return null;
    },
    async markSubjectTerminal(input) {
      return { subjectRef: input.subjectRef, state: input.state, observedAt: input.now };
    },
    async clearSubjectTerminal() {},
  };
}

export function mockCommunityStore() {
  return {
    async get() {
      return null;
    },
  };
}
