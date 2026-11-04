export function normalizeTags(tags) {
  return tags.reduce((result, item) => {
    const tag = item.trim();
    if (tag && !result.some((existing) => existing.toLowerCase() === tag.toLowerCase())) result.push(tag);
    return result;
  }, []);
}
