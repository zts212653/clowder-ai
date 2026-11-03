export function normalizeTags(tags) {
  const seen = new Set();
  return tags.flatMap((item) => {
    const tag = item.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) return [];
    seen.add(key);
    return [tag];
  });
}
