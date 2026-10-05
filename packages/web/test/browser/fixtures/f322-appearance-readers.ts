/**
 * Entry for the appearance journey's token-reader cell: the Café's own producer, bundled for a blank page so the browser's
 * colour engine (not a mock) answers.
 */
import {
  readHostAppearance,
  resolveColorFromDocument,
} from '../../../src/components/collective/collective-appearance-producer';

(window as unknown as { __appearanceReaders: unknown }).__appearanceReaders = {
  readHostAppearance,
  resolveColorFromDocument,
};
