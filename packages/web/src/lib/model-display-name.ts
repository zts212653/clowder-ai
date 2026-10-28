/** Human-readable model name — strip vendor prefix for display. */
export function formatModelName(model: string): string {
  if (!model || model === 'unknown') return '未知模型';
  // e.g. "claude-opus-4-6" → "Claude Opus 4.6", "claude-fable-5" → "Claude Fable 5"
  if (model.startsWith('claude-')) {
    const parts = model.replace('claude-', '').split('-');
    // Find where the version starts (first segment beginning with a digit)
    const versionStart = parts.findIndex((p) => /^\d/.test(p));
    if (versionStart > 0) {
      const name = parts
        .slice(0, versionStart)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const ver = parts.slice(versionStart).join('.');
      return `Claude ${name} ${ver}`;
    }
    // No numeric segment found — capitalize all parts
    return `Claude ${parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}`;
  }
  if (model.startsWith('gpt-')) {
    return `GPT ${model
      .slice(4)
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')}`;
  }
  if (model.startsWith('gemini-')) {
    return model
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return model;
}
