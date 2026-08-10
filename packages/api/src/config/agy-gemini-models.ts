export const LEGACY_GEMINI_CONSUMER_CAT_IDS = new Set(['gemini', 'gemini25', 'gemini35']);

export const AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID = new Map([
  ['gemini', 'Gemini 3.1 Pro (High)'],
  ['gemini25', 'Gemini 3.5 Flash (High)'],
  ['gemini35', 'Gemini 3.6 Flash (High)'],
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
]);

export const GEMINI35_CAT_ID = 'gemini35';
export const GEMINI35_OLD_DEFAULT_MODELS = new Set(['gemini-3.5-flash', 'Gemini 3.5 Flash (High)']);
export const GEMINI35_OLD_NAME = '暹罗猫 Gemini 3.5 Flash';
export const GEMINI35_OLD_ROLE_DESCRIPTION = '暹罗猫 Gemini 3.5 Flash，视觉设计和创意顾问';
export const GEMINI35_OLD_VARIANT_LABEL = 'Gemini 3.5 Flash';

export function normalizeAgyGeminiModelSelector(model: string): string {
  const trimmed = model.trim();
  return AGY_GEMINI_MODEL_BY_LEGACY_MODEL_ID.get(trimmed) ?? trimmed;
}

export function resolveAgyGeminiDefaultModel(resolvedCatId: string, defaultModel: unknown): string | undefined {
  const model = typeof defaultModel === 'string' ? defaultModel.trim() : '';
  if (resolvedCatId === GEMINI35_CAT_ID && GEMINI35_OLD_DEFAULT_MODELS.has(model)) {
    return AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID.get(GEMINI35_CAT_ID);
  }
  if (!model.startsWith('gemini-')) return undefined;
  return AGY_GEMINI_MODEL_BY_LEGACY_MODEL_ID.get(model) ?? AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID.get(resolvedCatId);
}
