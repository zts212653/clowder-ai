export const TEXT_FOLD_THRESHOLD = 20;

export function shouldFoldText(text: string): boolean {
  if (!text) return false;
  return text.trimEnd().split('\n').length > TEXT_FOLD_THRESHOLD;
}
