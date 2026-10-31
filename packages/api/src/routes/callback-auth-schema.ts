import { z } from 'zod';

// Compatibility layer: enterprise-only callback routes still parse
// invocationId/callbackToken in body while shared routes migrate to the
// preHandler-based callbackAuth flow.
export const callbackAuthSchema = z.object({
  invocationId: z.string().min(1),
  callbackToken: z.string().min(1),
});
