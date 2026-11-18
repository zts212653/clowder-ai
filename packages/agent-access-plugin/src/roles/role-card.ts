import type { CatCafeConfig, CatConfig, RosterEntry } from '@cat-cafe/shared';

import type { AgentAccessRoleStore } from '@clowder-ai/agent-contract';
import { builtInAgentClients } from '../discovery/agent-client-catalog.js';
import { toAllCatConfigs } from './role-projection.js';
import { roleConfigurationRevision } from './write-role.js';

export async function readRoles(store: AgentAccessRoleStore) {
  const { source } = await store.readCatalog();
  const catalog = JSON.parse(source) as CatCafeConfig;
  return Object.values(toAllCatConfigs(catalog)).map((cat) => ({
    ...projectRoleCard(
      cat,
      catalog.version === 2 ? (catalog.roster[cat.id] ?? null) : null,
      roleConfigurationRevision(catalog, cat.id, cat),
    ),
    client: {
      id: cat.clientId,
      label: builtInAgentClients.find((client) => client.id === cat.clientId)?.label ?? cat.clientId,
      type: cat.agentProvider ? 'plugin' : cat.clientId === 'a2a' ? 'cloud' : 'legacy',
    },
  }));
}

export function projectRoleCard(cat: CatConfig, roster: RosterEntry | null, revision?: string) {
  return {
    id: cat.id,
    name: cat.name,
    displayName: cat.displayName,
    nickname: cat.nickname,
    avatar: cat.avatar,
    ...(cat.banner ? { banner: cat.banner } : {}),
    color: cat.color,
    mentionPatterns: cat.mentionPatterns,
    breedId: cat.breedId,
    relationshipKey: cat.relationshipKey,
    accountRef: cat.accountRef,
    accountBindingMode: cat.accountBindingMode,
    configurationSource: cat.configurationSource,
    agentProvider: cat.agentProvider,
    configurationRevision: revision,
    clientId: cat.clientId,
    defaultModel: cat.defaultModel,
    carrier: cat.carrier,
    roleDescription: cat.roleDescription,
    personality: cat.personality,
    identitySources: cat.identitySources,
    teamStrengths: cat.teamStrengths,
    caution: cat.caution,
    restrictions: cat.restrictions ? [...cat.restrictions] : [],
    strengths: cat.strengths,
    sessionChain: cat.sessionChain,
    voiceConfig: cat.voiceConfig,
    provider: cat.provider,
    variantLabel: cat.variantLabel ?? undefined,
    isDefaultVariant: cat.isDefaultVariant ?? undefined,
    breedDisplayName: cat.breedDisplayName ?? undefined,
    executionApproval: cat.executionApproval,
    mcpSupport: cat.mcpSupport,
    roster: roster
      ? {
          family: roster.family,
          roles: [...roster.roles],
          lead: roster.lead,
          available: roster.available,
          evaluation: roster.evaluation,
        }
      : null,
  };
}
