import type { PersonIdentityDraft } from '@cat-cafe/shared';
import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';
import { normalizePrivateAlias } from './person-memory-keys.js';

export function candidateRepresentsPerson(
  candidate: StoredPersonMemoryCandidate,
  person: PersonIdentityDraft,
): boolean {
  const candidatePerson = candidate.personDraft;
  if (!candidatePerson) return false;

  const candidateEntityRef = candidatePerson.workspaceEntityLink?.entityRef;
  const proposedEntityRef = person.workspaceEntityLink?.entityRef;
  if (candidateEntityRef !== undefined || proposedEntityRef !== undefined) {
    return candidateEntityRef === proposedEntityRef;
  }

  const candidateAliases = new Set(
    [candidatePerson.displayName, ...candidatePerson.privateAliases].map(normalizePrivateAlias),
  );
  return [person.displayName, ...person.privateAliases]
    .map(normalizePrivateAlias)
    .some((alias) => candidateAliases.has(alias));
}
