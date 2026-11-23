export const LEGACY_GEMINI_CONSUMER_CAT_IDS = new Set(['gemini', 'gemini25', 'gemini35', 'gemini38']);

export const AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID = new Map([
  ['gemini', 'Gemini 3.1 Pro (High)'],
  ['gemini25', 'Gemini 3.5 Flash (High)'],
  ['gemini35', 'Gemini 3.6 Flash (High)'],
  ['gemini38', 'Gemini 3.8 Flash (High)'],
]);

export const AGY_GEMINI_MODEL_BY_LEGACY_MODEL_ID = new Map([
  ['gemini-2.5-pro', 'Gemini 3.1 Pro (High)'],
  ['gemini-2.5-pro-preview', 'Gemini 3.1 Pro (High)'],
  ['gemini-2.5-pro-exp', 'Gemini 3.1 Pro (High)'],
  ['gemini-2.5-flash', 'Gemini 3.5 Flash (High)'],
  ['gemini-2.5-flash-preview', 'Gemini 3.5 Flash (High)'],
  ['gemini-3.1-pro', 'Gemini 3.1 Pro (High)'],
  ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro (High)'],
  ['gemini-3.5-flash', 'Gemini 3.5 Flash (High)'],
  ['gemini-3.6-flash', 'Gemini 3.6 Flash (High)'],
  ['gemini-3.8-flash', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
]);

export const GEMINI35_CAT_ID = 'gemini35';
export const GEMINI35_LEGACY_DEFAULT_MODELS = new Set([
  'gemini-3.5-flash',
  'Gemini 3.5 Flash (High)',
  'gemini-3.8-flash',
  'gemini-3.8-flash-high',
  'Gemini 3.6 Flash (High)',
  'Gemini 3.8 Flash (High)',
]);
export const GEMINI35_LEGACY_NAMES = new Set(['暹罗猫 Gemini 3.5 Flash', '暹罗猫 Gemini 3.8 Flash']);
export const GEMINI35_LEGACY_ROLE_DESCRIPTIONS = new Set([
  '暹罗猫 Gemini 3.5 Flash，视觉设计和创意顾问',
  '暹罗猫 Gemini 3.8 Flash，视觉设计和创意顾问',
]);
export const GEMINI35_LEGACY_VARIANT_LABELS = new Set(['Gemini 3.5 Flash', 'Gemini 3.8 Flash']);

export interface AgyNativeKnownModel {
  readonly id: string;
  readonly label: string;
}

/**
 * Read-only reference catalog of known AGY Native model IDs exposed by AGY CLI.
 * Never spawns the CLI during read-side discovery; users can still enter custom IDs.
 */
export const AGY_NATIVE_KNOWN_MODELS: readonly AgyNativeKnownModel[] = [
  { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
  { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
  { id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)' },
  { id: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)' },
  { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
  { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
  { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
  { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
  { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
];

export function normalizeAgyGeminiModelSelector(model: string): string {
  const trimmed = model.trim();
  return AGY_GEMINI_MODEL_BY_LEGACY_MODEL_ID.get(trimmed) ?? trimmed;
}

export function resolveAgyGeminiDefaultModel(resolvedCatId: string, defaultModel: unknown): string | undefined {
  const model = typeof defaultModel === 'string' ? defaultModel.trim() : '';
  if (resolvedCatId === GEMINI35_CAT_ID && GEMINI35_LEGACY_DEFAULT_MODELS.has(model)) {
    return AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID.get(GEMINI35_CAT_ID);
  }
  if (!model.startsWith('gemini-')) return undefined;
  // Explicit modern AGY Gemini 4 / orchestrator model IDs must never be downgraded to legacy labels.
  if (/^gemini-4-|^gemini-pro-orchestrator-/i.test(model)) return undefined;
  return AGY_GEMINI_MODEL_BY_LEGACY_MODEL_ID.get(model) ?? AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID.get(resolvedCatId);
}
