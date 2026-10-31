/**
 * What colours are really in the room right now: the cats and connectors of the catalogue and the human, as the shell that
 * is showing paints them. Feeds the name role, the plate and the lineage ring (lib/readable-name-plate; Opus 5.5 3619).
 *
 * The human: the new shell (v2) paints the configured colour, or the cocoa it bakes in when there is none
 * (`CoCreatorHueInjector`, shell-v2.css); the classic shell never reads the config and keeps the human colour
 * cat-persona-tokens.css has always baked in. `undefined` while the catalogue request has not answered: nothing is known about the
 * room, and the caller falls back to its swept range until it is.
 */
import type { ActualColours } from './readable-name-plate';
import { NEUTRAL_HUE_CHROMA, readHueChroma, themeColourSources } from './theme-colour-sources';

/** shell-v2.css: the shared cocoa an unconfigured or unreadable human colour falls back to in the new shell. */
export const COCOA_HUMAN = { h: 58, c: 0.04 } as const;
/** cat-persona-tokens.css: the human colour the classic shell has always had. */
export const CLASSIC_HUMAN = { h: 40, c: 0.13 } as const;

export function actualColoursOf(input: {
  cats: ReadonlyArray<{ id?: string; color?: { primary?: string } }>;
  /** The catalogue request has answered. An empty answer (first run) is still an answer: connectors and the human paint. */
  loaded: boolean;
  shell: 'classic' | 'v2';
  /** The configured human colour (hex), if the config has one. */
  humanPrimary: string | null | undefined;
}): ActualColours | undefined {
  if (!input.loaded) return undefined;
  const cats = themeColourSources(input.cats).map((source) => readHueChroma(source.hex) ?? NEUTRAL_HUE_CHROMA);
  const human = input.shell === 'v2' ? (readHueChroma(input.humanPrimary ?? undefined) ?? COCOA_HUMAN) : CLASSIC_HUMAN;
  return { cats: cats.map((c) => ({ ...c })), human: { ...human } };
}
