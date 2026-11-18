import type { CatCafeConfig } from '@cat-cafe/shared';
import type { AgentAccessRoleMutation } from '@clowder-ai/agent-contract';
import { readLocalAccountSelection } from './local-account-selection.js';

export function planRoleAccountBinding(
  current: CatCafeConfig,
  selection: Extract<AgentAccessRoleMutation, { kind: 'bind' }>,
): CatCafeConfig {
  const { client } = selection;
  const targets = new Set(selection.targetIds);
  const previous = readLocalAccountSelection(current, client);
  const selectedRef = selection.scope === 'local' ? selection.accountRef : previous.accountRef;
  return {
    ...current,
    ...(selectedRef
      ? {
          selectedAccountRefs: { ...current.selectedAccountRefs, [client]: selectedRef },
        }
      : {}),
    breeds: current.breeds.map((breed) => ({
      ...breed,
      variants: breed.variants.map((variant) => {
        const id = variant.catId ?? breed.catId ?? '';
        if (targets.has(id))
          return {
            ...variant,
            accountRef: selection.accountRef,
            accountBindingMode: selection.accountRef === selectedRef ? ('follow' as const) : ('override' as const),
          };
        if (selection.scope === 'local') {
          const member = previous.members.find((m) => m.id === id);
          if (member)
            return {
              ...variant,
              // Inactive members keep their effective ref but retain explicit intent for re-enable.
              accountBindingMode: member.bindingMode === 'follow' ? ('follow' as const) : ('override' as const),
            };
        }
        return variant;
      }),
    })),
  };
}
