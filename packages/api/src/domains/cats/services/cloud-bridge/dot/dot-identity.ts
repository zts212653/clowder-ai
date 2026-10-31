import { inheritFullyBlockedMcpCapabilitiesForNewCatsSync } from '../../../../../config/capabilities/capability-orchestrator.js';
import { toAllCatConfigs } from '../../../../../config/cat-config-loader.js';
import { createRuntimeCat, readRuntimeCatCatalog } from '../../../../../config/runtime-cat-catalog.js';
import { DOT_CAT_ID } from './dot-connection-state.js';

/** Called only by authenticated owner setup, never by an external subscription. */
export function ensureDotIdentity(projectRoot: string): boolean {
  const catalog = readRuntimeCatCatalog(projectRoot);
  const cats = toAllCatConfigs(catalog);
  const existing = cats[DOT_CAT_ID];
  if (existing) {
    if (
      existing.clientId !== 'openai' ||
      existing.provider !== 'openai-chatgpt-pro' ||
      existing.cli ||
      !existing.mentionPatterns.some((pattern) => pattern.trim().toLowerCase() === '@dot')
    ) {
      throw new Error('dot_identity_conflict');
    }
    return false;
  }
  if (
    Object.values(cats).some((cat) =>
      cat.mentionPatterns.some((pattern) => ['dot', '@dot'].includes(pattern.trim().toLowerCase())),
    )
  )
    throw new Error('dot_mention_conflict');
  const breed =
    catalog.breeds.find((entry) => entry.catId === 'gpt-pro') ??
    catalog.breeds.find((entry) => entry.id === 'maine-coon');
  if (!breed) throw new Error('dot_existing_breed_unavailable');
  createRuntimeCat(projectRoot, {
    catId: DOT_CAT_ID,
    breedId: breed.id,
    name: '砚砚',
    displayName: '砚砚 · dot',
    variantLabel: 'ChatGPT dot',
    nickname: '云端砚砚',
    avatar: '/avatars/gpt-pro.png',
    color: { primary: '#D4835A', secondary: '#F4E6DD' },
    mentionPatterns: ['@dot'],
    roleDescription: '在原对话相处与协作的长期云端家猫。',
    clientId: 'openai',
    carrier: 'app_server',
    defaultModel: 'ChatGPT dot',
    provider: 'openai-chatgpt-pro',
    mcpSupport: true,
  });
  inheritFullyBlockedMcpCapabilitiesForNewCatsSync(projectRoot, [DOT_CAT_ID], new Set(Object.keys(cats)));
  return true;
}
