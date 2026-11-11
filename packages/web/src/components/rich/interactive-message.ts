import type { RichInteractiveBlock } from '@/stores/chat-types';

// ── Pure function (exported for testing) ────────────────────

export function buildSelectionMessage(
  interactiveType: string,
  options: Array<{ id: string; label: string; emoji?: string }>,
  selectedIds: string[],
  messageTemplate?: string,
  title?: string,
  customText?: string,
): string {
  if (interactiveType === 'confirm') {
    const confirmId = options.find((option) => option.id === '__confirm__')?.id ?? options[0]?.id ?? '__confirm__';
    const action = selectedIds[0] === confirmId ? '确认' : '取消';
    return title ? `${action} — ${title}` : action;
  }

  const selected = selectedIds.map((id) => options.find((o) => o.id === id)).filter(Boolean) as typeof options;
  const labels = selected.map((o) => (o.emoji ? `${o.emoji} ${o.label}` : o.label));

  // If a customInput option was selected and user typed text, use that text
  if (customText) {
    const base = labels.length > 0 ? `${labels.join(', ')}：${customText}` : customText;
    return title ? `${base}（${title}）` : base;
  }

  if (messageTemplate) {
    return messageTemplate.replace('{selection}', labels.join(', '));
  }

  const base = `我选了：${labels.join(', ')}`;
  return title ? `${base}（${title}）` : base;
}

// ── Pure function (exported for testing) ────────────────────

export function buildGroupMessage(
  blocks: RichInteractiveBlock[],
  selections: Map<string, string[]>,
  customTexts?: Map<string, string>,
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const selected = selections.get(block.id);
    if (!selected || selected.length === 0) continue;
    const ct = customTexts?.get(block.id);
    const msg = buildSelectionMessage(
      block.interactiveType,
      block.options,
      selected,
      block.messageTemplate,
      block.title,
      ct || undefined,
    );
    parts.push(msg);
  }
  return parts.join('\n');
}
