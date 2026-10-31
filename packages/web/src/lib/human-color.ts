/**
 * F322 B segment 1 (human message). What colour, if any, the config gives the people in the room.
 *
 * A fact about a config, not a default: a config with no colour, or one whose colour cannot be read, is `unconfigured`, and
 * nothing is written for it: the shared cocoa that shell-v2.css bakes in applies (DESIGN.md: no colour set -> cocoa, not a
 * neutral). Pure, so the hook that loads the config stays the only place that talks to the API.
 */
export type HumanColorState =
  | { status: 'unconfigured' }
  | { status: 'configured'; color: { primary: string; secondary: string } };

export function isReadableHex(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const hex = value.replace('#', '');
  return [3, 6, 8].includes(hex.length) && /^[0-9a-f]+$/i.test(hex);
}

export function humanColorState(
  config: { color?: { primary: string; secondary: string } } | undefined,
): HumanColorState {
  const color = config?.color;
  if (!color || !isReadableHex(color.primary)) return { status: 'unconfigured' };
  return { status: 'configured', color };
}
