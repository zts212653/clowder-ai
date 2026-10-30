import { createHash } from 'node:crypto';
import { z } from 'zod';

export const L0_COMPILER_VERSION = 'member-l0/v1';
const frozenL0Schema = z
  .object({
    schemaVersion: z.literal(1),
    compilerVersion: z.literal(L0_COMPILER_VERSION),
    catId: z.string().min(1),
    projection: z.enum(['owner', 'public']),
    template: z.string().min(1),
    sections: z.record(z.string()).readonly(),
    variables: z.record(z.string()).readonly(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .readonly();

export type FrozenL0Input = z.infer<typeof frozenL0Schema>;
type L0InputContent = Omit<FrozenL0Input, 'inputDigest'>;

/** No paths, credentials, invocation tokens or timestamps enter this content key. */
export function freezeL0Input(content: L0InputContent): FrozenL0Input {
  const stable = {
    schemaVersion: content.schemaVersion,
    compilerVersion: content.compilerVersion,
    catId: content.catId,
    projection: content.projection,
    template: content.template,
    sections: Object.freeze(
      Object.fromEntries(Object.entries(content.sections).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    ),
    variables: Object.freeze(
      Object.fromEntries(Object.entries(content.variables).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    ),
  };
  return Object.freeze({ ...stable, inputDigest: createHash('sha256').update(JSON.stringify(stable)).digest('hex') });
}

/** Validate once at the JSON child boundary; internal consumers receive a typed immutable input. */
export function parseFrozenL0Input(value: unknown): FrozenL0Input {
  const result = frozenL0Schema.safeParse(value);
  if (!result.success) throw new Error('Frozen L0 input schema/compiler version is invalid');
  const parsed = result.data;
  const frozen = freezeL0Input(parsed);
  if (frozen.inputDigest !== parsed.inputDigest) throw new Error('Frozen L0 input digest mismatch');
  return frozen;
}

/** Inserted identity/profile text is opaque, including strings that resemble placeholders. */
export function renderFrozenL0Input(input: FrozenL0Input): string {
  const template = input.template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(input.sections, key) ? input.sections[key]! : match,
  );
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(input.variables, key) ? input.variables[key]! : match,
  );
}
