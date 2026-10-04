import {
  castCollectiveBindingVoteRequestSchema,
  createCollectiveBindingVoteRequestSchema,
  settleCollectiveBindingVoteRequestSchema,
  withdrawCollectiveBindingVoteRequestSchema,
} from '@cat-cafe/shared';
import {
  castCollectiveBindingVote,
  createCollectiveBindingVote,
  projectCollectiveBindingVote,
  withdrawCollectiveBindingVote,
} from './collaboration-binding-vote.js';
import { settleCollectiveBindingVote } from './collaboration-binding-vote-settlement.js';
import { byCreation, requireHumanCommand } from './collaboration-command-helpers.js';
import { requireHumanAuthBinding, requireMembership, resolveSession } from './identity-store.js';
import type { PersistentServiceState } from './persistence.js';

export class CollectiveBindingVoteStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}

  async create(sessionToken: string, unsafeInput: unknown) {
    const input = createCollectiveBindingVoteRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return createCollectiveBindingVote(state, input, human, this.now());
    });
  }

  async cast(sessionToken: string, unsafeInput: unknown) {
    const input = castCollectiveBindingVoteRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return castCollectiveBindingVote(state, input, human, this.now());
    });
  }

  async withdraw(sessionToken: string, unsafeInput: unknown) {
    const input = withdrawCollectiveBindingVoteRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return withdrawCollectiveBindingVote(state, input, human, this.now());
    });
  }

  async settle(sessionToken: string, unsafeInput: unknown) {
    const input = settleCollectiveBindingVoteRequestSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const human = requireHumanCommand(state, sessionToken, input);
      return settleCollectiveBindingVote(state, input, human, this.now());
    });
  }

  list(sessionToken: string, collectiveId: string) {
    const state = this.persistence.snapshot();
    const { human } = resolveSession(state, sessionToken);
    requireHumanAuthBinding(state, human.humanId);
    requireMembership(state, collectiveId, human.humanId);
    return {
      bindingVotes: Object.values(state.bindingVotes)
        .filter((vote) => vote.collectiveId === collectiveId)
        .sort(byCreation)
        .map((vote) => projectCollectiveBindingVote(state, vote, this.now())),
      decisions: Object.values(state.decisions)
        .filter((decision) => decision.collectiveId === collectiveId)
        .sort(byCreation)
        .map((decision) => structuredClone(decision)),
    };
  }
}
