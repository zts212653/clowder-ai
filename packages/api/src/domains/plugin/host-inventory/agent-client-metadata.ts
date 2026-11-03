import { z } from 'zod';
import { agentClientProfileSchema } from '../../cats/services/agents/session-contract/plugin-agent-provider.js';

/** Display metadata from admitted bytes, never an execution authority. */
export const agentClientMetadataSchema = z
  .union([
    z.strictObject({
      catalog: z.strictObject({
        configurationKey: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/)
          .nullable(),
        presets: z.array(agentClientProfileSchema).max(16),
        clients: z.array(agentClientProfileSchema.pick({ id: true, name: true }).partial({ name: true })).max(32),
        defaultClient: agentClientProfileSchema.extend({ name: z.string().min(1) }).optional(),
      }),
    }),
    z.strictObject({ error: z.string().min(1).max(512) }),
  ])
  .nullable();

export type PluginAgentClientMetadata = z.infer<typeof agentClientMetadataSchema>;
