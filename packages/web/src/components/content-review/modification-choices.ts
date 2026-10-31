import type { ContentModificationChoices } from '@cat-cafe/shared';
import { formatCatDisplayName } from '@/lib/cat-display-name';

/**
 * Same-breed cats share one display name ("缅因猫"), so the picker, the submit
 * button and the running status could not tell them apart. Fold the variant
 * label into the name once, where the catalogue enters the page.
 */
export function withDistinctCatNames(choices: ContentModificationChoices): ContentModificationChoices {
  return {
    ...choices,
    cats: choices.cats.map((cat) => ({
      ...cat,
      name: formatCatDisplayName({ displayName: cat.name, variantLabel: cat.variantLabel }),
    })),
  };
}
