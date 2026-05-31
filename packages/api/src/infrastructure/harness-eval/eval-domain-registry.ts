import { z } from 'zod';

const evalDomainRegistryEntrySchema = z.object({
  domainId: z.enum(['eval:a2a', 'eval:memory', 'eval:sop', 'eval:capability-wakeup']),
  displayName: z.string().min(1),
  systemThreadId: z.string().min(1, 'systemThreadId is required'),
  evalCat: z.object({
    catId: z.string().min(1),
    handle: z.string().min(1),
    model: z.string().min(1),
  }),
  frequency: z.enum(['daily', 'weekly']),
  sourceAdapter: z.enum(['f167-runtime-eval', 'f200-f188-memory-eval', 'sop-trace-eval', 'capability-wakeup-eval']),
  threadPolicy: z.object({
    role: z.literal('working-home'),
    stateSot: z.literal('registry'),
    allowedContent: z.array(z.enum(['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'])).min(1),
  }),
  legacyScheduledTaskIds: z.array(z.string().min(1)),
  handoffTargetResolver: z.object({
    featureId: z.string().regex(/^F\d{3}$/, 'featureId must match F followed by 3 digits'),
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
