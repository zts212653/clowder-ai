/**
 * Locale-aware Markdown loading for the docs viewer.
 *
 * Chinese pages live beside their English source as `*.zh-CN.md`. When a
 * translation is absent, the viewer deliberately falls back to the canonical
 * English path. The injected fetch function keeps this module shared by the
 * browser and behavioral tests.
 */

export function localizedDocCandidates(path, lang) {
  if (typeof path !== 'string' || !path) return [];
  if (lang !== 'zh' || !/\.md$/i.test(path) || /\.zh-CN\.md$/i.test(path)) return [path];
  return [path.replace(/\.md$/i, '.zh-CN.md'), path];
}

export async function fetchLocalizedMarkdown(path, lang, fetchDocument) {
  if (typeof fetchDocument !== 'function') throw new TypeError('fetchDocument must be a function');

  const candidates = localizedDocCandidates(path, lang);
  let lastError = new Error(`No document candidates for ${String(path)}`);

  for (const candidate of candidates) {
    try {
      const response = await fetchDocument(candidate);
      if (!response?.ok) {
        lastError = new Error(`${response?.status ?? 'fetch failed'}: ${candidate}`);
        continue;
      }
      return { path: candidate, markdown: await response.text() };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
}
