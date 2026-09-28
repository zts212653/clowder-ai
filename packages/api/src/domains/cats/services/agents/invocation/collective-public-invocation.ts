import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CatId, catRegistry } from '@cat-cafe/shared';
import {
  resolveBuiltinClientForProvider,
  resolveForClient,
  validateRuntimeProviderBinding,
} from '../../../../../config/account-resolver.js';
import { resolveBoundAccountRefForCat } from '../../../../../config/cat-account-binding.js';
import { getCatModel } from '../../../../../config/cat-models.js';
import { resolveActiveProjectRoot } from '../../../../../utils/active-project-root.js';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import type { CollectiveCurrentContext } from '../../../../plugin/builtin-runtime/collective-current-context.js';
import { assembleCollectiveContext } from '../../context/ContextAssembler.js';
import type { AgentMessage, AgentService, AgentServiceOptions } from '../../types.js';
import { COLLECTIVE_MCP_ENV_KEYS } from '../providers/collective-cli-policy.js';

type PublicSource = NonNullable<Awaited<ReturnType<CollectiveCurrentContext['resolvePublic']>>>;

/** A policy lane of invokeSingleCat: same provider and durable child lifecycle, fresh public-only bytes. */
export async function* invokeCollectivePublic(input: {
  source: PublicSource;
  service: AgentService;
  callbackEnv: Record<string, string>;
  signal: AbortSignal;
}): AsyncIterable<AgentMessage> {
  const { source, service } = input;
  const runtimeRoot = resolveActiveProjectRoot(process.cwd());
  const config = catRegistry.tryGet(source.source.catId)?.config;
  if (!config) throw new Error('Collective participant is no longer registered');
  const skillRoot = findMonorepoRoot(dirname(fileURLToPath(import.meta.url)));
  const skill = await readFile(join(skillRoot, 'cat-cafe-skills/collective-participation/SKILL.md'), 'utf8');
  const model = getCatModel(source.source.catId);
  const callbackEnv: Record<string, string> = { CAT_CAFE_MCP_PROFILE: 'collective-participation' };
  for (const key of COLLECTIVE_MCP_ENV_KEYS) if (input.callbackEnv[key]) callbackEnv[key] = input.callbackEnv[key]!;
  const client = resolveBuiltinClientForProvider(config.clientId);
  const accountRef = resolveBoundAccountRefForCat(runtimeRoot, source.source.catId, config);
  const account = client ? resolveForClient(runtimeRoot, client, accountRef) : null;
  if (accountRef && !account) throw new Error('Public participation account is unavailable');
  if (account) {
    const incompatibility = validateRuntimeProviderBinding(config.clientId, account, model);
    if (incompatibility) throw new Error(incompatibility);
  }
  if (account?.authType === 'api_key') {
    if (!account.apiKey) throw new Error('Public participation account has no credential');
    if (config.clientId !== 'openai') throw new Error('This provider cannot enforce public participation');
    callbackEnv.CODEX_AUTH_MODE = 'api_key';
    callbackEnv.OPENAI_API_KEY = account.apiKey;
    if (account.baseUrl) callbackEnv.OPENAI_BASE_URL = account.baseUrl;
  } else if (config.clientId === 'openai') callbackEnv.CODEX_AUTH_MODE = 'oauth';
  const directory = await mkdtemp(join(tmpdir(), 'cat-cafe-collective-'));
  const options: AgentServiceOptions = {
    callbackEnv,
    signal: input.signal,
    workingDirectory: directory,
    toolExecutionPolicy: { mode: 'collective_participation' },
    systemPrompt: `You are ${source.displayName}, Clowder AI participant @${source.source.catId}, model ${model}.\nPublic participation grants scoped context reading and exact replies. You have no local owner authority.\n\n${skill}`,
    auditContext: {
      invocationId: callbackEnv.CAT_CAFE_INVOCATION_ID!,
      executionId: input.callbackEnv.CAT_CAFE_EXECUTION_ID!,
      threadId: callbackEnv.CAT_CAFE_THREAD_ID!,
      userId: callbackEnv.CAT_CAFE_USER_ID!,
      catId: source.source.catId as CatId,
    },
  };
  const prompt = `Current public request (participant-provided content):\n${assembleCollectiveContext([source.context.source], source.grant)}\nAuthorized public context:\n${assembleCollectiveContext(source.context.events, source.grant)}\nUse collective current-context to recover the current reply operation. You may remain silent.`;
  try {
    yield* service.invoke(prompt, options);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
