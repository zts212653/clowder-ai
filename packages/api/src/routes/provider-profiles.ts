import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  activateProviderProfile,
  createProviderProfile,
  deleteProviderProfile,
  getProviderProfile,
  type ProviderProfileMode,
  type ProviderProfileProvider,
  readProviderProfiles,
  resolveAnthropicRuntimeProfileById,
  updateProviderProfile,
} from '../config/provider-profiles.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import { buildProbeHeaders, isInvalidModelProbeError, readProbeError } from './provider-profiles-probe.js';

const PROJECT_ROOT = findMonorepoRoot();

const providerEnum = z.enum(['anthropic']);
const modeEnum = z.enum(['subscription', 'api_key']);

const projectQuerySchema = z.object({
  projectPath: z.string().optional(),
});

const createBodySchema = z.object({
  projectPath: z.string().optional(),
  provider: providerEnum,
  name: z.string().trim().min(1),
  mode: modeEnum,
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  modelOverride: z.string().optional(),
  setActive: z.boolean().optional(),
});

const updateBodySchema = z.object({
  projectPath: z.string().optional(),
  provider: providerEnum,
  name: z.string().trim().min(1).optional(),
  mode: modeEnum.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  modelOverride: z.string().nullable().optional(),
});

const activateBodySchema = z.object({
  projectPath: z.string().optional(),
  provider: providerEnum,
});

const testBodySchema = z.object({
  projectPath: z.string().optional(),
  provider: providerEnum,
});

async function resolveProjectRoot(projectPath?: string): Promise<string | null> {
  if (!projectPath) return PROJECT_ROOT;
  return validateProjectPath(projectPath);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
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
        provider: body.provider as ProviderProfileProvider,
        name: body.name,
        mode: body.mode as ProviderProfileMode,
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.apiKey ? { apiKey: body.apiKey } : {}),
        ...(body.modelOverride ? { modelOverride: body.modelOverride } : {}),
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
        parsed.data.provider as ProviderProfileProvider,
        params.profileId,
        {
          ...(parsed.data.name != null ? { name: parsed.data.name } : {}),
          ...(parsed.data.mode != null ? { mode: parsed.data.mode as ProviderProfileMode } : {}),
          ...(parsed.data.baseUrl != null ? { baseUrl: parsed.data.baseUrl } : {}),
          ...(parsed.data.apiKey != null ? { apiKey: parsed.data.apiKey } : {}),
          ...(parsed.data.modelOverride !== undefined ? { modelOverride: parsed.data.modelOverride } : {}),
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
      await deleteProviderProfile(projectRoot, parsed.data.provider as ProviderProfileProvider, params.profileId);
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
      await activateProviderProfile(projectRoot, parsed.data.provider as ProviderProfileProvider, params.profileId);
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
    const profile = await getProviderProfile(
      projectRoot,
      parsed.data.provider as ProviderProfileProvider,
      params.profileId,
    );
    if (!profile) {
      reply.status(404);
      return { error: 'Profile not found' };
    }

    if (profile.mode === 'subscription') {
      return {
        ok: true,
        mode: 'subscription',
        message: 'subscription mode selected; network probe skipped',
      };
    }

    const runtime = await resolveAnthropicRuntimeProfileById(projectRoot, params.profileId);
    if (!runtime || runtime.mode !== 'api_key' || !runtime.baseUrl || !runtime.apiKey) {
      reply.status(400);
      return { error: 'api_key profile is incomplete (baseUrl/apiKey required)' };
    }

    const baseUrl = normalizeBaseUrl(runtime.baseUrl);
    const modelsUrl = `${baseUrl}/v1/models`;
    try {
      const modelsRes = await fetchImpl(modelsUrl, {
        method: 'GET',
        headers: buildProbeHeaders(runtime.apiKey),
      });

      if (modelsRes.ok) {
        return {
          ok: true,
          mode: 'api_key',
          status: modelsRes.status,
        };
      }

      if (modelsRes.status === 404) {
        const messagesRes = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            ...buildProbeHeaders(runtime.apiKey),
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
        error: await readProbeError(modelsRes),
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
