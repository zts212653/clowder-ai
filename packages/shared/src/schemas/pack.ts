/**
 * F129: Pack System Zod Schemas
 * Fail-closed validation — unknown fields rejected via .strict()
 * High-risk fields use bounded enums, not arbitrary strings.
 *
 * See: docs/features/F129-pack-system-multi-agent-mod.md (AC-A1, AC-A8)
 */

import { z } from 'zod';

// ─── Shared enums ────────────────────────────────────────────────────

export const PackTypeSchema = z.enum(['domain', 'scenario', 'style', 'bridge', 'capability']);
export const ConstraintSeveritySchema = z.enum(['block', 'warn']);
export const PackScopeSchema = z.enum(['all-cats', 'specific-breeds']);
export const MaskActivationSchema = z.enum(['always', 'on-demand']);
export const ResolverTypeSchema = z.enum(['code', 'agent', 'hybrid']);
export const WorkflowActionSchema = z.enum([
  'search-knowledge',
  'apply-mask',
  'check-guardrail',
  'notify-user',
  'switch-mode',
  'log-event',
]);

// ─── Bounded string helpers ──────────────────────────────────────────
// AC-A8: high-risk fields only allow bounded string (not arbitrary length)

const boundedString = (max: number) => z.string().min(1).max(max);
const packNameRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// ─── Pack Manifest (pack.yaml) ───────────────────────────────────────

export const PackCompatibilitySchema = z
  .object({
    catCafeVersion: z.string().max(50).optional(),
  })
  .strict();

export const PackManifestSchema = z
  .object({
    name: boundedString(100).regex(packNameRegex, 'Pack name must be lowercase alphanumeric with hyphens'),
    version: boundedString(20),
    description: boundedString(500),
    packType: PackTypeSchema,
    author: boundedString(100).optional(),
    license: boundedString(50).optional(),
    compatibility: PackCompatibilitySchema.optional(),
  })
  .strict();

// ─── Guardrails (guardrails.yaml) ────────────────────────────────────

export const PackConstraintSchema = z
  .object({
    id: boundedString(100),
    scope: PackScopeSchema,
    breeds: z.array(boundedString(50)).max(20).optional(),
    rule: boundedString(500),
    severity: ConstraintSeveritySchema,
  })
  .strict();

export const PackGuardrailsSchema = z
  .object({
    constraints: z.array(PackConstraintSchema).max(50),
  })
  .strict();

// ─── Defaults (defaults.yaml) ────────────────────────────────────────

export const PackBehaviorSchema = z
  .object({
    id: boundedString(100),
    scope: PackScopeSchema,
    breeds: z.array(boundedString(50)).max(20).optional(),
    behavior: boundedString(500),
    overridable: z.literal(true),
  })
  .strict();

export const PackDefaultsSchema = z
  .object({
    behaviors: z.array(PackBehaviorSchema).max(50),
  })
  .strict();

// ─── Masks (masks/*.yaml) ────────────────────────────────────────────

export const PackMaskSchema = z
  .object({
    id: boundedString(100),
    name: boundedString(100),
    roleOverlay: boundedString(300),
    personalityOverlay: boundedString(300).optional(),
    expertise: z.array(boundedString(100)).max(10).optional(),
    activation: MaskActivationSchema,
  })
  .strict();

// ─── Workflows (workflows/*.yaml) ────────────────────────────────────

export const PackWorkflowStepSchema = z
  .object({
    action: WorkflowActionSchema,
    params: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  })
  .strict();

export const PackWorkflowSchema = z
  .object({
    id: boundedString(100),
    name: boundedString(200),
    trigger: boundedString(200),
    steps: z.array(PackWorkflowStepSchema).min(1).max(20),
  })
  .strict();

// ─── World Driver (world-driver.yaml) ────────────────────────────────

export const PackWorldDriverSchema = z
  .object({
    stateSchema: z.record(z.unknown()).optional(),
    roles: z.array(boundedString(100)).max(20).optional(),
    actions: z.array(boundedString(100)).max(50).optional(),
    resolver: ResolverTypeSchema,
    canonRules: z.array(boundedString(500)).max(30).optional(),
    memoryPolicy: boundedString(200).optional(),
  })
  .strict();

// ─── Inferred types (for consumers that prefer schema-derived types) ─

export type PackManifestInput = z.input<typeof PackManifestSchema>;
export type PackGuardrailsInput = z.input<typeof PackGuardrailsSchema>;
export type PackDefaultsInput = z.input<typeof PackDefaultsSchema>;
export type PackMaskInput = z.input<typeof PackMaskSchema>;
export type PackWorkflowInput = z.input<typeof PackWorkflowSchema>;
export type PackWorldDriverInput = z.input<typeof PackWorldDriverSchema>;
