import { z } from 'zod';

const evalDomainRegistryEntrySchema = z.object({
  domainId: z.literal('eval:a2a'),
  displayName: z.string().min(1),
  systemThreadId: z.string().min(1, 'systemThreadId is required'),
  evalCat: z.object({
    catId: z.string().min(1),
    handle: z.string().min(1),
    model: z.string().min(1),
  }),
  frequency: z.literal('daily'),
  sourceAdapter: z.literal('f167-runtime-eval'),
  threadPolicy: z.object({
    role: z.literal('working-home'),
    stateSot: z.literal('registry'),
    allowedContent: z.array(z.enum(['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'])).min(1),
  }),
  legacyScheduledTaskIds: z.array(z.string().min(1)).min(1, 'legacyScheduledTaskIds must not be empty'),
  handoffTargetResolver: z.object({
    featureId: z.literal('F167'),
    ownerCatId: z.string().min(1),
    threadLookup: z.literal('feature-thread'),
  }),
  sla: z.object({
    acknowledgeHours: z.number().int().positive('acknowledgeHours must be positive'),
    reevalWithinHours: z.number().int().positive('reevalWithinHours must be positive'),
  }),
});

export type EvalDomainRegistryEntry = z.infer<typeof evalDomainRegistryEntrySchema>;

export function parseEvalDomainRegistryEntry(input: unknown): EvalDomainRegistryEntry {
  return evalDomainRegistryEntrySchema.parse(input);
}

export function parseEvalDomainRegistryFile(input: unknown): EvalDomainRegistryEntry {
  return parseEvalDomainRegistryEntry(input);
}
