import { realpath, stat } from 'node:fs/promises';
import { relative, resolve, win32 } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  activateProviderProfile,
  createProviderProfile,
  deleteProviderProfile,
  getProviderProfile,
  type ProviderProfileAuthType,
  type ProviderProfileMode,
  type ProviderProfileProvider,
  readProviderProfiles,
  resolveRuntimeProviderProfileById,
  updateProviderProfile,
} from '../config/provider-profiles.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import { buildProbeHeaders, isInvalidModelProbeError, readProbeError } from './provider-profiles-probe.js';

const MONOREPO_ROOT = findMonorepoRoot();

const protocolEnum = z.enum(['anthropic', 'openai', 'google']);
const authTypeEnum = z.enum(['oauth', 'api_key']);
const modeEnum = z.enum(['subscription', 'api_key']);

const projectQuerySchema = z.object({
  projectPath: z.string().optional(),
});

const createBodySchema = z
  .object({
    projectPath: z.string().optional(),
    provider: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    displayName: z.string().trim().min(1).optional(),
    mode: modeEnum.optional(),
    authType: authTypeEnum.optional(),
    protocol: protocolEnum.optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    modelOverride: z.string().optional(),
    models: z.array(z.string().trim().min(1)).optional(),
    setActive: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.name && !value.displayName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['displayName'],
        message: 'displayName or name is required',
      });
    }
  });

const updateBodySchema = z.object({
  projectPath: z.string().optional(),
  provider: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  mode: modeEnum.optional(),
  authType: authTypeEnum.optional(),
  protocol: protocolEnum.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  modelOverride: z.string().nullable().optional(),
  models: z.array(z.string().trim().min(1)).optional(),
});

const activateBodySchema = z.object({
  projectPath: z.string().optional(),
  provider: z.string().trim().min(1).optional(),
});

const testBodySchema = z.object({
  projectPath: z.string().optional(),
  provider: z.string().trim().min(1).optional(),
  protocol: protocolEnum.optional(),
});

async function resolveProjectRoot(projectPath?: string): Promise<string | null> {
  if (!projectPath) return resolveActiveProjectRoot();
  const validated = await validateProjectPath(projectPath);
  if (validated) return validated;

  // Workspace project switcher can provide sibling repo paths (outside homedir/tmp allowlist).
  // Allow paths under current workspace root while keeping realpath boundary checks.
  const workspaceRoot = resolve(MONOREPO_ROOT, '..');
  try {
    const [resolvedTarget, resolvedWorkspaceRoot] = await Promise.all([
      realpath(resolve(projectPath)),
      realpath(workspaceRoot),
    ]);
    const rel = relative(resolvedWorkspaceRoot, resolvedTarget);
    if (win32.isAbsolute(rel) || rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) return null;
    const info = await stat(resolvedTarget);
    return info.isDirectory() ? resolvedTarget : null;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function probeUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function resolveProviderSelector(selector: string | undefined, fallback: string): ProviderProfileProvider {
  return (selector?.trim() || fallback) as ProviderProfileProvider;
}

function inferProbeProtocol(
  baseUrl: string | undefined,
  selector: string | undefined,
  models: string[] | undefined = [],
  ...nameHints: Array<string | undefined>
): 'anthropic' | 'openai' | 'google' {
  const normalizedSelector = selector?.trim().toLowerCase();
  if (normalizedSelector === 'anthropic' || normalizedSelector === 'claude' || normalizedSelector === 'opencode') {
    return 'anthropic';
  }
  if (normalizedSelector === 'google' || normalizedSelector === 'gemini') {
    return 'google';
  }
  if (normalizedSelector === 'openai' || normalizedSelector === 'codex' || normalizedSelector === 'dare') {
    return 'openai';
  }

  const normalizedModels = models.map((model) => model.trim().toLowerCase()).filter(Boolean);
  if (normalizedModels.some((model) => model.includes('claude') || model.includes('anthropic'))) {
    return 'anthropic';
  }
  if (normalizedModels.some((model) => model.includes('gemini') || model.includes('google'))) {
    return 'google';
  }
  if (normalizedModels.some((model) => model.includes('gpt') || model.includes('o1') || model.includes('o3'))) {
    return 'openai';
  }

  const normalizedHints = nameHints.map((hint) => hint?.trim().toLowerCase() ?? '').filter(Boolean).join(' ');
  if (normalizedHints.includes('claude') || normalizedHints.includes('anthropic') || normalizedHints.includes('opencode')) {
    return 'anthropic';
  }
  if (normalizedHints.includes('gemini') || normalizedHints.includes('google')) {
    return 'google';
  }
  if (normalizedHints.includes('codex') || normalizedHints.includes('openai') || normalizedHints.includes('dare')) {
    return 'openai';
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl ?? '').toLowerCase();
  if (normalizedBaseUrl.includes('anthropic')) return 'anthropic';
  if (
    normalizedBaseUrl.includes('googleapis.com') ||
    normalizedBaseUrl.includes('generativelanguage') ||
    normalizedBaseUrl.includes('gemini')
  ) {
    return 'google';
  }
  return 'openai';
}

export interface ProviderProfilesRoutesOptions {
  fetchImpl?: typeof fetch;
}

export const providerProfilesRoutes: FastifyPluginAsync<ProviderProfilesRoutesOptions> = async (app, opts) => {
  const fetchImpl = opts.fetchImpl ?? fetch;

  app.get('/api/provider-profiles', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = projectQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parsed.error.issues };
    }
    const projectRoot = await resolveProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }

    const data = await readProviderProfiles(projectRoot);
    return {
      projectPath: projectRoot,
      ...data,
    };
  });

  app.post('/api/provider-profiles', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }

    const body = parsed.data;
    try {
      const profile = await createProviderProfile(projectRoot, {
        ...(body.provider != null ? { provider: body.provider } : {}),
        ...(body.name != null ? { name: body.name } : {}),
        ...(body.displayName != null ? { displayName: body.displayName } : {}),
        ...(body.mode != null ? { mode: body.mode as ProviderProfileMode } : {}),
        ...(body.authType != null ? { authType: body.authType as ProviderProfileAuthType } : {}),
        ...(body.protocol != null ? { protocol: body.protocol } : {}),
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.apiKey ? { apiKey: body.apiKey } : {}),
        ...(body.models != null ? { models: body.models } : {}),
        ...(body.setActive != null ? { setActive: body.setActive } : {}),
      });
      return {
        projectPath: projectRoot,
        profile,
      };
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.patch('/api/provider-profiles/:profileId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = updateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    const params = request.params as { profileId: string };

    try {
      const profile = await updateProviderProfile(
        projectRoot,
        resolveProviderSelector(parsed.data.provider, params.profileId),
        params.profileId,
        {
          ...(parsed.data.name != null ? { name: parsed.data.name } : {}),
          ...(parsed.data.displayName != null ? { displayName: parsed.data.displayName } : {}),
          ...(parsed.data.mode != null ? { mode: parsed.data.mode as ProviderProfileMode } : {}),
          ...(parsed.data.authType != null ? { authType: parsed.data.authType as ProviderProfileAuthType } : {}),
          ...(parsed.data.protocol != null ? { protocol: parsed.data.protocol } : {}),
          ...(parsed.data.baseUrl != null ? { baseUrl: parsed.data.baseUrl } : {}),
          ...(parsed.data.apiKey != null ? { apiKey: parsed.data.apiKey } : {}),
          ...(parsed.data.models != null ? { models: parsed.data.models } : {}),
        },
      );
      return { projectPath: projectRoot, profile };
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete('/api/provider-profiles/:profileId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = activateBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    const params = request.params as { profileId: string };

    try {
      await deleteProviderProfile(
        projectRoot,
        resolveProviderSelector(parsed.data.provider, params.profileId),
        params.profileId,
      );
      return { ok: true };
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/provider-profiles/:profileId/activate', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = activateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    const params = request.params as { profileId: string };

    try {
      await activateProviderProfile(
        projectRoot,
        resolveProviderSelector(parsed.data.provider, params.profileId),
        params.profileId,
      );
      return { ok: true, profileId: params.profileId };
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/provider-profiles/:profileId/test', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = testBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    const params = request.params as { profileId: string };

    let profile;
    try {
      profile = await getProviderProfile(
        projectRoot,
        resolveProviderSelector(parsed.data.provider, params.profileId),
        params.profileId,
      );
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (!profile) {
      reply.status(404);
      return { error: 'Profile not found' };
    }

    if (profile.authType !== 'api_key') {
      reply.status(400);
      return { error: 'Only api_key providers can be tested' };
    }

    const runtime = await resolveRuntimeProviderProfileById(projectRoot, params.profileId);
    if (!runtime || runtime.authType !== 'api_key' || !runtime.baseUrl || !runtime.apiKey) {
      reply.status(400);
      return { error: 'Only api_key providers can be tested' };
    }

    const baseUrl = normalizeBaseUrl(runtime.baseUrl);
    const probeProtocol =
      runtime.protocol ??
      inferProbeProtocol(
        runtime.baseUrl,
        parsed.data.protocol ?? parsed.data.provider,
        runtime.models,
        profile.displayName,
        profile.name,
        profile.provider,
        profile.id,
      );
    const modelProbePaths = probeProtocol === 'google' ? ['/v1beta/models', '/models', '/v1/models'] : ['/v1/models'];
    let modelsRes: Response | null = null;
    let modelsError: string | null = null;
    try {
      for (const path of modelProbePaths) {
        const next = await fetchImpl(probeUrl(baseUrl, path), {
          method: 'GET',
          headers: buildProbeHeaders(probeProtocol, runtime.apiKey),
        });
        modelsRes = next;
        if (next.ok) {
          return {
            ok: true,
            mode: 'api_key',
            status: next.status,
          };
        }
        modelsError = await readProbeError(next);
        if (next.status !== 404) break;
      }

      if (!modelsRes) {
        return {
          ok: false,
          mode: 'api_key',
          error: 'Provider test did not execute',
        };
      }

      if (probeProtocol === 'anthropic' && modelsRes.status === 404) {
        const messagesRes = await fetchImpl(probeUrl(baseUrl, '/v1/messages'), {
          method: 'POST',
          headers: {
            ...buildProbeHeaders(probeProtocol, runtime.apiKey),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-3-5-haiku-latest',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        });
        if (messagesRes.ok) {
          return {
            ok: true,
            mode: 'api_key',
            status: messagesRes.status,
          };
        }
        const messagesError = await readProbeError(messagesRes);
        if (messagesRes.status === 400 && isInvalidModelProbeError(messagesError)) {
          return {
            ok: true,
            mode: 'api_key',
            status: 200,
            message: 'baseUrl and apiKey are valid; gateway rejected the probe model identifier',
          };
        }
        return {
          ok: false,
          mode: 'api_key',
          status: messagesRes.status,
          error: messagesError,
        };
      }

      return {
        ok: false,
        mode: 'api_key',
        status: modelsRes.status,
        error: modelsError ?? (await readProbeError(modelsRes)),
      };
    } catch (err) {
      reply.status(500);
      return {
        ok: false,
        mode: 'api_key',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
};
