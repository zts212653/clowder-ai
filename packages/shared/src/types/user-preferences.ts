/**
 * User Preferences (F166)
 * UI-level preferences persisted to .cat-cafe/user-preferences.json.
 * Separate from cat-catalog.json (configuration, not preference).
 */

export interface UserPreferences {
  /** F166: Custom display order of cats. catIds not in this list fall back to cat-template.json order. */
  catOrder?: string[];
}
