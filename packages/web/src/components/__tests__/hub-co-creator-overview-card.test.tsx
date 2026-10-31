import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HubCoCreatorOverviewCard } from '../HubMemberOverviewCard';

/**
 * F322 B — the owner card's "ME" initials sit on the identity fill the user configured, so their ink comes from that fill.
 * The config chain accepts #RRGGBBAA (humanColorState, hexToOklch), so the card has to treat an opaque 8-digit colour as the
 * same fill as its 6-digit form (Sol6.1's review: #6666ffff fell back to the theme surface, 3.43:1, while #6666ff got black).
 */
const base = { name: 'You', aliases: [], mentionPatterns: ['@co-creator'] };
const initialsStyle = (primary: string) => {
  const html = renderToStaticMarkup(
    <HubCoCreatorOverviewCard coCreator={{ ...base, color: { primary, secondary: '#FFFFFF' } }} />,
  );
  const cell = html.match(/<div[^>]*style="([^"]*)"[^>]*>(?:(?!<\/div>)[\s\S])*ME<\/div>/);
  if (!cell) throw new Error(`no initials cell in ${html}`);
  return cell[1];
};

describe('the owner card initials', () => {
  it('writes black on a light-enough fill and white on a dark one', () => {
    expect(initialsStyle('#6666ff')).toContain('color:#000000');
    expect(initialsStyle('#6B5443')).toContain('color:#ffffff');
  });

  it('gives an opaque 8-digit fill the same ink as its 6-digit form, not the theme surface', () => {
    for (const [eight, six] of [
      ['#6666ffff', '#6666ff'],
      ['#6B5443FF', '#6B5443'],
      ['#E9DCCFff', '#E9DCCF'],
    ]) {
      const ink = initialsStyle(six).match(/(?:^|;)color:([^;]+)/)?.[1];
      expect(ink, six).toMatch(/^#/);
      expect(initialsStyle(eight), eight).toContain(`color:${ink}`);
      expect(initialsStyle(eight), eight).not.toContain('--cafe-surface');
    }
  });

  it('keeps the old theme-surface ink only where there is no readable opaque fill to write on', () => {
    expect(initialsStyle('#6666ff80')).toContain('var(--cafe-surface)');
  });
});
