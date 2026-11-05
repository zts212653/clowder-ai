export async function waitForRenderedReply(page, messageId, marker, { timeout = 20000 } = {}) {
  if (!/^[\w-]+$/.test(messageId)) throw new Error('Invalid persisted message identity');
  const reply = page.locator(`[data-message-id="${messageId}"]`).first().getByTestId('message-bubble');
  await reply.getByText(marker, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

// Persistence is compared byte-for-byte through the real API by the caller.
// Markdown source is not DOM text. Check authored output anchors in the exact
// persisted bubble; never use another message/header or a generic nonempty reply.
export async function waitForRenderedHistory(page, message, options) {
  if (!/^[\w-]+$/.test(message.id)) throw new Error('Invalid persisted message identity');
  const row = page.locator(`[data-message-id="${message.id}"]`).first();
  const bubble = row.getByTestId('message-bubble');
  await bubble.waitFor({ state: 'visible', ...options });
  const expand = row.locator('[data-reading-disclosure]').filter({ hasText: /^(展开（还有|Show more \()/ });
  for (const button of await expand.all()) await button.click();
  const markers = [...new Set(message.content.match(/LIVE_[\w]+|A2A_(?:PEER|FINAL)_[a-f0-9]+(?:=\d+)?/g) ?? [])];
  const plain = message.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/[`*_<>[\]#]/.test(line) && !/^([-+>]|\d+\.)\s/.test(line));
  const anchors = markers.length ? markers : plain ? [plain] : [];
  if (!anchors.length) throw new Error('History fixture needs an explicit rendered-content expectation');
  for (const anchor of anchors) await waitForRenderedReply(page, message.id, anchor, options);
  return { messageId: message.id, anchors };
}
