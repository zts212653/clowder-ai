const trial = (status) => ({ kind: 'decision-trial', status });
const dimensionLabels = {
  'relationship-stance': '关系立场',
  'cognitive-honesty': '认知诚实',
  'architecture-aesthetics': '架构美学',
  'visual-quality': '视觉品质',
  'authentic-expression': '真实表达',
  'system-philosophy': '系统哲学',
  'creative-craft': '创作工艺',
};
function readable(snapshot) {
  if (snapshot?.kind !== 'f221-preview') return null;
  const { fields, digest, proposalId, nonce, expiresAt } = snapshot.snapshot ?? {};
  if (
    !fields ||
    fields.id !== proposalId ||
    !/^[0-9a-f]{64}$/.test(digest ?? '') ||
    !/^[0-9a-f]{48}$/.test(nonce ?? '') ||
    !Number.isSafeInteger(expiresAt) ||
    !['public', 'sensitive'].includes(fields.privacy) ||
    !Object.hasOwn(dimensionLabels, fields.dimension) ||
    typeof fields.quote !== 'string' ||
    typeof fields.takeaway !== 'string' ||
    typeof fields.scene !== 'string' ||
    typeof fields.publication !== 'string'
  )
    return null;
  try {
    if (JSON.parse(fields.publication).state !== 'anchored') return null;
    const tags = JSON.parse(fields.tags);
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) return null;
    if (
      fields.scene.length +
        fields.quote.length +
        fields.takeaway.length +
        fields.tags.length +
        fields.dimension.length >
      1800
    )
      return null;
  } catch {
    return null;
  }
  return snapshot.snapshot;
}

/** Host-owned native button trial. It does not call any producer writer. */
async function inspectF221({ dialog, win, read, confirm, current, now = Date.now }) {
  if (!dialog?.showMessageBox || !current()) return trial('unavailable');
  const first = readable(await read());
  if (!first || !current() || now() > first.expiresAt) return trial('unavailable');
  const privacy = first.fields.privacy === 'sensitive' ? '敏感' : '公开';
  const tags = JSON.parse(first.fields.tags).join('、') || '无';
  const shown = await dialog.showMessageBox(win, {
    type: 'question',
    title: '品味提案 · 确认演练',
    message: '请核对这条品味提案',
    detail: `场景：${first.fields.scene}\n原话：${first.fields.quote}\n提炼：${first.fields.takeaway || '无'}\n维度：${dimensionLabels[first.fields.dimension]}\n标签：${tags}\n隐私：${privacy}\n\n若真实批准，这些内容会进入可复用的品味档案。本窗口只演练确认，不会提交或写入。`,
    buttons: ['取消', '批准演练（不提交）', '拒绝演练（不提交）'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (!current() || now() > first.expiresAt) return trial('stale');
  if (shown.response !== 1 && shown.response !== 2) return trial('dismissed');
  const action = shown.response === 1 ? 'approve' : 'reject';
  const receipt = await confirm(first.nonce, action);
  if (
    !current() ||
    now() > first.expiresAt ||
    receipt?.kind !== 'f221-trial-receipt' ||
    receipt.origin !== 'host-native-dialog' ||
    receipt.nonce !== first.nonce ||
    receipt.action !== action ||
    receipt.digest !== first.digest ||
    receipt.proposalId !== first.proposalId
  )
    return trial('stale');
  return trial('trial_confirmed');
}

module.exports = { inspectF221 };
