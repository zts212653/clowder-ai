import type { MatrixEntry, ServiceRecommendation } from './recommendation-types.js';

/** Use display data attached to the selected entry; never match or translate free text. */
export function englishRecommendation(base: ServiceRecommendation, entry: MatrixEntry): ServiceRecommendation {
  const text = entry.display?.en;
  if (!text) throw new Error(`English recommendation display is missing for ${base.serviceId}`);
  return {
    ...base,
    models: base.models.map((model) => {
      const words = text.models?.[model.name];
      if (!words || (model.performance !== undefined && words.performance === undefined))
        throw new Error(`English recommendation display is missing for ${model.name}`);
      return {
        ...model,
        description: words.description,
        ...(model.performance !== undefined ? { performance: words.performance } : {}),
      };
    }),
    notes: base.notes.length ? requireNotes(text.notes, base.notes.length) : [],
    unsupported: base.unsupported ? requireUnsupported(text.unsupported) : undefined,
    customModelHint: base.customModelHint
      ? {
          ...base.customModelHint,
          requirement: requireHint(text.customModelHint).requirement,
          ...(base.customModelHint.unsupported !== undefined
            ? {
                unsupported: requireHint(text.customModelHint).unsupported ?? missing('custom model warning'),
              }
            : {}),
          ...(base.customModelHint.links
            ? {
                links: base.customModelHint.links.map((link, index) => ({
                  ...link,
                  label: requireHint(text.customModelHint).linkLabels?.[index] ?? missing('custom model link label'),
                })),
              }
            : {}),
        }
      : undefined,
  };
}
function missing(field: string): never {
  throw new Error(`English recommendation display is missing: ${field}`);
}
function requireNotes(notes: string[] | undefined, length: number): string[] {
  if (!notes || notes.length !== length) return missing('notes');
  return notes;
}
function requireUnsupported(value: MatrixEntry['unsupported']): NonNullable<MatrixEntry['unsupported']> {
  return value ?? missing('unsupported guidance');
}
function requireHint(value: NonNullable<MatrixEntry['display']>['en']['customModelHint']) {
  return value ?? missing('custom model guidance');
}
