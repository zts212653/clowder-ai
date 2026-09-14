import { readFile } from 'node:fs/promises';
import type { MetricDefinition } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export interface EvaluationModelDefinition {
  id: string;
  label: string;
  ruleVersion: string;
  cycleTrigger: {
    cumulativeThreshold: number;
    counterexampleThreshold: number;
    cadenceDays: number;
    minimumIntervalMs: number;
  };
  metrics: MetricDefinition[];
}

export interface ObjectiveDefinition {
  id: string;
  label: string;
  statement: string;
  evaluationModelId: string;
  lifecycle: 'active' | 'retired';
}

export interface ObjectiveRegistry {
  registryVersion: 2;
  evaluationModels: EvaluationModelDefinition[];
  objectives: ObjectiveDefinition[];
}

export type ObjectiveRegistryResult = { ok: true; registry: ObjectiveRegistry } | { ok: false; error: string };

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const evaluator = z
  .object({
    kind: z.enum(['code', 'llm', 'replay']),
    ruleRef: slug,
  })
  .strict();
const trigger = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('distinct-counterexamples'),
      threshold: z.number().int().positive(),
      lookbackMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('minimum-sample'),
      minimum: z.number().int().positive(),
      windowMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cadence'),
      cadence: z.union([z.literal('daily'), z.literal('weekly'), z.string().regex(/^every-[1-9][0-9]*d$/)]),
    })
    .strict(),
]);
const verdictRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('counter-zero') }).strict(),
  z.object({ kind: z.literal('rate-maximum'), maximum: z.number().min(0).max(1) }).strict(),
  z.object({ kind: z.literal('rate-minimum'), minimum: z.number().min(0).max(1) }).strict(),
  z
    .object({
      kind: z.literal('semantic-label-maximum'),
      label: slug,
      maximum: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal('replay-zero-failure') }).strict(),
  z.object({ kind: z.literal('evidence-only') }).strict(),
]);
const metric = z
  .object({
    id: slug,
    label: z.string().trim().min(1),
    kind: z.enum(['counter', 'rate', 'semantic', 'replay']),
    evaluator,
    trigger,
    verdictRule,
  })
  .strict();
const cycleTrigger = z
  .object({
    cumulativeThreshold: z.number().int().min(200),
    counterexampleThreshold: z.number().int().min(3),
    cadenceDays: z.number().int().min(7),
    minimumIntervalMs: z.number().int().nonnegative(),
  })
  .strict();
const evaluationModel = z
  .object({
    id: slug,
    label: z.string().trim().min(1),
    ruleVersion: slug,
    cycleTrigger,
    metrics: z.array(metric).min(1),
  })
  .strict();
const objective = z
  .object({
    id: slug,
    label: z.string().trim().min(1),
    statement: z.string().trim().min(1),
    evaluationModelId: slug,
    lifecycle: z.enum(['active', 'retired']).default('active'),
  })
  .strict();
const registrySchema = z
  .object({
    registryVersion: z.literal(2),
    evaluationModels: z.array(evaluationModel).min(1),
    objectives: z.array(objective).min(1),
  })
  .strict();

function fail(error: string): ObjectiveRegistryResult {
  return { ok: false, error };
}

function validateRegistryCrossReferences(registry: ObjectiveRegistry): string | null {
  const modelIds = new Set<string>();
  for (const model of registry.evaluationModels) {
    if (modelIds.has(model.id)) return `duplicate evaluation model id "${model.id}"`;
    modelIds.add(model.id);
    const metricError = validateModelMetrics(model);
    if (metricError) return metricError;
  }

  const objectiveIds = new Set<string>();
  for (const definition of registry.objectives) {
    if (objectiveIds.has(definition.id)) return `duplicate objective id "${definition.id}"`;
    objectiveIds.add(definition.id);
    if (!modelIds.has(definition.evaluationModelId)) {
      return `objective "${definition.id}" references unknown evaluation model "${definition.evaluationModelId}"`;
    }
  }
  return null;
}

function validateModelMetrics(model: ObjectiveRegistry['evaluationModels'][number]): string | null {
  const metricIds = new Set<string>();
  for (const definition of model.metrics) {
    if (metricIds.has(definition.id)) {
      return `duplicate metric id "${definition.id}" in evaluation model "${model.id}"`;
    }
    metricIds.add(definition.id);
    const contractError = validateMetricContract(definition);
    if (contractError) return contractError;
  }
  return null;
}

function validateMetricContract(
  definition: ObjectiveRegistry['evaluationModels'][number]['metrics'][number],
): string | null {
  if (definition.kind === 'counter' && definition.trigger.kind !== 'distinct-counterexamples') {
    return `counter metric "${definition.id}" must use distinct-counterexamples trigger`;
  }
  if (definition.kind === 'rate' && definition.trigger.kind !== 'minimum-sample') {
    return `rate metric "${definition.id}" must use minimum-sample trigger`;
  }
  const requiredKind = requiredMetricKind(definition.verdictRule.kind);
  if (requiredKind && requiredKind !== definition.kind) {
    return `${definition.verdictRule.kind} verdict rule requires ${requiredKind} metric "${definition.id}"`;
  }
  return null;
}

function requiredMetricKind(
  ruleKind: ObjectiveRegistry['evaluationModels'][number]['metrics'][number]['verdictRule']['kind'],
) {
  if (ruleKind === 'counter-zero') return 'counter';
  if (ruleKind === 'rate-maximum' || ruleKind === 'rate-minimum') return 'rate';
  if (ruleKind === 'semantic-label-maximum') return 'semantic';
  if (ruleKind === 'replay-zero-failure') return 'replay';
  return null;
}

export function parseObjectiveRegistry(rawYaml: string): ObjectiveRegistryResult {
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(rawYaml);
  } catch (error) {
    return fail(`malformed registry YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = registrySchema.safeParse(parsedYaml);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return fail(`invalid objective registry v2: ${details}`);
  }
  const registry = parsed.data as ObjectiveRegistry;
  const crossReferenceError = validateRegistryCrossReferences(registry);
  if (crossReferenceError) return fail(crossReferenceError);
  return { ok: true, registry };
}

export async function loadObjectiveRegistry(registryPath: string): Promise<ObjectiveRegistryResult> {
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf-8');
  } catch (error) {
    return fail(`registry unreadable at ${registryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseObjectiveRegistry(raw);
}
