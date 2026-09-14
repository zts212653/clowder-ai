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
const unitId = z.string().regex(/^[A-Z]+\d+$/);

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const objectiveAttachment = z
  .object({
    objectiveId: slug,
  })
  .strict();
const unit = z
  .object({
    unitId,
    hookId: slug,
    unitState: z.enum(['evaluable', 'not-ready']),
    notReadyReason: z.string().trim().min(1).optional(),
    /**
     * Which scope this unit belongs to. Omitted means `baseline`: the set the
     * installer ships. A unit this line authors later — a governance card's new
     * segment, a local experiment — is `local`, and must say so. Promotion from
     * local to baseline is an explicit act (extend CANONICAL_UNIT_IDS upstream),
     * never a side effect of appending a manifest row, so an installed package
     * and this instance cannot silently drift into the same list.
     */
    origin: z.enum(['baseline', 'local']).optional(),
    objectives: z.array(objectiveAttachment).length(1),
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

  const validationError = validateManifest(parsed.data, registry);
  if (validationError) return fail(validationError);
  return { ok: true, manifest: parsed.data };
}

function validateManifest(manifest: UnitEvaluationManifest, registry: ObjectiveRegistry): string | null {
  const objectiveIds = new Set(
    registry.objectives.filter((objective) => objective.lifecycle === 'active').map((objective) => objective.id),
  );
  const seenUnits = new Set<string>();
  for (const definition of manifest.units) {
    if (seenUnits.has(definition.unitId)) return `duplicate unit id "${definition.unitId}"`;
    seenUnits.add(definition.unitId);
    const unitError = validateUnit(definition, objectiveIds);
    if (unitError) return unitError;
  }

  const missing = CANONICAL_UNIT_IDS.filter((unitId) => !seenUnits.has(unitId));
  if (missing.length > 0) return `manifest must cover canonical 46 units; missing=[${missing.join(',')}]`;
  return validateScopes(manifest);
}

/** Baseline and local evolution are different scopes; neither may pass as the other. */
function validateScopes(manifest: UnitEvaluationManifest): string | null {
  const baseline = new Set(CANONICAL_UNIT_IDS);
  for (const definition of manifest.units) {
    const isBaselineId = baseline.has(definition.unitId);
    const declared = definition.origin ?? 'baseline';
    if (isBaselineId && declared !== 'baseline') {
      return `unit "${definition.unitId}" ships in the baseline and cannot declare origin "${declared}"`;
    }
    if (!isBaselineId && declared !== 'local') {
      return `unit "${definition.unitId}" is not in the shipped baseline and must declare origin: local`;
    }
  }
  return null;
}

function validateUnit(definition: UnitEvaluationManifest['units'][number], objectiveIds: Set<string>): string | null {
  if (definition.unitState === 'not-ready' && !definition.notReadyReason) {
    return `unit "${definition.unitId}" is not-ready but has no notReadyReason`;
  }
  if (definition.unitState === 'evaluable' && definition.notReadyReason) {
    return `unit "${definition.unitId}" is evaluable but has notReadyReason`;
  }
  for (const attachment of definition.objectives) {
    if (!objectiveIds.has(attachment.objectiveId)) {
      return `unit "${definition.unitId}" references unknown objective "${attachment.objectiveId}"`;
    }
  }
  return null;
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
