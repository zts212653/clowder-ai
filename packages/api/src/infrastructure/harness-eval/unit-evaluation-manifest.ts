import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ObjectiveRegistry } from './objective-registry.js';

const CANONICAL_UNIT_IDS = [
  'B1',
  'C1',
  ...Array.from({ length: 21 }, (_, index) => `D${index + 1}`),
  ...Array.from({ length: 7 }, (_, index) => `L${index + 1}`),
  'N1',
  'R1',
  'R2',
  ...Array.from({ length: 13 }, (_, index) => `S${index + 1}`),
].sort();

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const objectiveAttachment = z
  .object({
    objectiveId: slug,
    clauseId: slug.optional(),
  })
  .strict();
const unit = z
  .object({
    unitId: z.string().regex(/^(?:B1|C1|D(?:[1-9]|1[0-9]|2[01])|L[1-7]|N1|R[12]|S(?:[1-9]|1[0-3]))$/),
    hookId: slug,
    unitState: z.enum(['evaluable', 'not-ready']),
    notReadyReason: z.string().trim().min(1).optional(),
    objectives: z.array(objectiveAttachment).min(1),
  })
  .strict();
const manifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    registryVersion: z.literal(2),
    units: z.array(unit),
  })
  .strict();

export type UnitEvaluationManifest = z.infer<typeof manifestSchema>;
export type UnitEvaluationManifestResult =
  | { ok: true; manifest: UnitEvaluationManifest }
  | { ok: false; error: string };

const fail = (error: string): UnitEvaluationManifestResult => ({ ok: false, error });

export function parseUnitEvaluationManifest(
  rawYaml: string,
  registry: ObjectiveRegistry,
): UnitEvaluationManifestResult {
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(rawYaml);
  } catch (error) {
    return fail(`malformed unit evaluation manifest YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = manifestSchema.safeParse(parsedYaml);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return fail(`invalid unit evaluation manifest: ${details}`);
  }

  const objectiveIds = new Set(registry.objectives.map((objective) => objective.id));
  const seenUnits = new Set<string>();
  for (const definition of parsed.data.units) {
    if (seenUnits.has(definition.unitId)) return fail(`duplicate unit id "${definition.unitId}"`);
    seenUnits.add(definition.unitId);
    if (definition.unitState === 'not-ready' && !definition.notReadyReason) {
      return fail(`unit "${definition.unitId}" is not-ready but has no notReadyReason`);
    }
    if (definition.unitState === 'evaluable' && definition.notReadyReason) {
      return fail(`unit "${definition.unitId}" is evaluable but has notReadyReason`);
    }
    const seenAttachments = new Set<string>();
    for (const attachment of definition.objectives) {
      if (!objectiveIds.has(attachment.objectiveId)) {
        return fail(`unit "${definition.unitId}" references unknown objective "${attachment.objectiveId}"`);
      }
      const coordinate = `${attachment.objectiveId}:${attachment.clauseId ?? ''}`;
      if (seenAttachments.has(coordinate))
        return fail(`unit "${definition.unitId}" repeats attachment "${coordinate}"`);
      seenAttachments.add(coordinate);
    }
  }

  const actualUnits = [...seenUnits].sort();
  if (JSON.stringify(actualUnits) !== JSON.stringify(CANONICAL_UNIT_IDS)) {
    const missing = CANONICAL_UNIT_IDS.filter((unitId) => !seenUnits.has(unitId));
    const extra = actualUnits.filter((unitId) => !CANONICAL_UNIT_IDS.includes(unitId));
    return fail(
      `manifest must cover canonical 46 units exactly; missing=[${missing.join(',')}], extra=[${extra.join(',')}]`,
    );
  }
  return { ok: true, manifest: parsed.data };
}

export async function loadUnitEvaluationManifest(
  manifestPath: string,
  registry: ObjectiveRegistry,
): Promise<UnitEvaluationManifestResult> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    return fail(
      `unit evaluation manifest unreadable at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseUnitEvaluationManifest(raw, registry);
}
