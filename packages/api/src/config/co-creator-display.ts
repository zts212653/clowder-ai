import { coCreatorDisplay } from '@cat-cafe/shared';
import { getCoCreatorConfig } from './cat-config-loader.js';

/** Resolve on use so saving the existing editor is visible without a restart. */
export function getCoCreatorDisplay() {
  return coCreatorDisplay(getCoCreatorConfig());
}
