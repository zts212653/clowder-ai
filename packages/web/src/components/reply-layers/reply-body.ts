/**
 * F322 B §1.16 layer 1: what the cat said is reading-column text (DESIGN.md「对话」: 15px on a 1.7 line), not the 14px / 1.625 the
 * markdown renderer inherits. Two things the renderer pins itself, both beaten here without `!important`:
 * - its root carries `text-sm` at the same specificity as a plain reading-size utility, so the winner would be CSS order,
 *   not intent (measured one token too small in Chromium while a class-presence test was green) — the
 *   `&.markdown-content` variant doubles the selector;
 * - every paragraph carries `leading-relaxed`, so the reading token's line height is set on descendants from the container.
 */
export const REPLY_BODY_CLASS = '[&.markdown-content]:text-reading [&_p]:leading-[inherit] [&_li]:leading-[inherit]';
