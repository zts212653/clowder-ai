/** Limits wire text without splitting a UTF-16 surrogate pair. */
export function clipLiveText(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return text.slice(0, end);
}
