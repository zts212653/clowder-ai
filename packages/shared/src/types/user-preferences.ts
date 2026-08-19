/**
 * User Preferences (F166)
 * UI-level preferences persisted to .cat-cafe/user-preferences.json.
 * Separate from cat-catalog.json (configuration, not preference).
 */

import type { MessageWorkDisposition } from './queue-receipt.js';

export type MessageDispositionPreferenceSource = 'thread' | 'global' | 'product';

export interface MessageDispositionPreferences {
  /** Owner-wide fallback. Missing inherits the product default. */
  global?: MessageWorkDisposition;
  /** Per-thread override. Missing entry inherits global/product. */
  threads?: Record<string, MessageWorkDisposition>;
  /** Monotonic JIT-onboarding receipt. */
  onboardingSeen?: boolean;
}

export interface MessageDispositionPreferenceSnapshot {
  productDefault: MessageWorkDisposition;
  global: MessageWorkDisposition | null;
  thread: MessageWorkDisposition | null;
  effective: MessageWorkDisposition;
  source: MessageDispositionPreferenceSource;
  onboardingSeen: boolean;
}

export interface UserPreferences {
  /** F166: Custom display order of cats. catIds not in this list fall back to cat-template.json order. */
  catOrder?: string[];
  /** F264: author-declared current-work/next-work preference inheritance. */
  messageDisposition?: MessageDispositionPreferences;
}
