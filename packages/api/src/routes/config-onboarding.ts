import type { UserPreferences } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { readUserPreferencesStrict, updateUserPreferences } from '../config/user-preferences-store.js';
import { resolveSessionUserId } from '../utils/request-identity.js';

const demoInput = z.object({ status: z.enum(['dismissed', 'completed']) }).strict();
const entryInput = z.object({ status: z.enum(['pending', 'dismissed', 'completed']) }).strict();

/** Personal receipts share the existing atomic preference owner, not the transient F155 session. */
export const configOnboardingRoutes: FastifyPluginAsync<{ projectRoot: string }> = async (app, { projectRoot }) => {
  const snapshot = (userId: string, version: string, preferences: UserPreferences) => ({
    userId,
    version,
    status: preferences.onboardingGuides?.[`${encodeURIComponent(userId)}:${version}`]?.status ?? 'not_started',
  });
  const register = (path: string, version: string, inputSchema: typeof entryInput | typeof demoInput) => {
    app.get(path, async (request, reply) => {
      const userId = resolveSessionUserId(request);
      if (!userId) return reply.code(401).send({ error: 'Authentication required' });
      try {
        return snapshot(userId, version, readUserPreferencesStrict(projectRoot));
      } catch (error) {
        request.log.warn({ err: error }, 'Onboarding preferences unavailable');
        return reply
          .code(503)
          .send({ code: 'preferences_unavailable', error: 'Unable to read preferences; retry later' });
      }
    });
    app.put(path, async (request, reply) => {
      const userId = resolveSessionUserId(request);
      if (!userId) return reply.code(401).send({ error: 'Authentication required' });
      const parsed = inputSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid onboarding receipt' });
      const key = `${encodeURIComponent(userId)}:${version}`;
      try {
        const next = updateUserPreferences(projectRoot, (current) => ({
          ...current,
          onboardingGuides: {
            ...current.onboardingGuides,
            [key]: {
              status:
                current.onboardingGuides?.[key]?.status === 'completed'
                  ? 'completed'
                  : current.onboardingGuides?.[key]?.status === 'dismissed' && parsed.data.status === 'pending'
                    ? 'dismissed'
                    : parsed.data.status,
              updatedAt: Date.now(),
            },
          },
        }));
        return snapshot(userId, version, next);
      } catch (error) {
        request.log.warn({ err: error }, 'Onboarding preferences unavailable');
        return reply
          .code(503)
          .send({ code: 'preferences_unavailable', error: 'Unable to save preferences; retry later' });
      }
    });
  };
  register('/api/config/onboarding', 'collaboration-v1', demoInput);
  register('/api/config/onboarding/entry', 'first-run-entry-v1', entryInput);
};
