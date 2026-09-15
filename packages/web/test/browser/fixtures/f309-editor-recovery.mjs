import assert from 'node:assert/strict';
import path from 'node:path';
import { editorLayout } from './f309-editor-layout.mjs';

export async function setGenOfficeEnabled(page, enabled) {
  const action = enabled ? 'enable' : 'disable';
  const result = page.waitForResponse((response) =>
    new RegExp(`^/api/plugins/official/[^/]+/${action}$`).test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: `${enabled ? '启用' : '停用'} GenOffice`, exact: true }).click();
  const response = await result;
  assert.equal(response.status(), 200, `${action} must finish successfully before the next user step`);
  const { instance } = await response.json();
  assert.equal(instance.activationState, enabled ? 'enabled' : 'disabled');
  assert.equal(instance.runtimeState, enabled ? 'healthy' : 'stopped');
  await page.getByRole('button', { name: `${enabled ? '停用' : '启用'} GenOffice`, exact: true }).waitFor();
}

export async function appendParagraph(frame, page, text) {
  const editor = frame.locator('.ProseMirror[contenteditable="true"]').last();
  const tail = editor.locator(':scope > p').last();
  await tail.click();
  // Position only the native caret. GenOffice overrides navigation/formatting
  // shortcuts; all content changes below still use actual keyboard input.
  await tail.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await frame.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(
    await tail.evaluate((node) => {
      const selection = window.getSelection();
      if (!selection?.isCollapsed || !node.contains(selection.anchorNode)) return false;
      const remaining = document.createRange();
      remaining.selectNodeContents(node);
      remaining.setStart(selection.anchorNode, selection.anchorOffset);
      return remaining.toString().length === 0;
    }),
    'append must start from a collapsed caret at the end of the fixture tail paragraph',
  );
  await editor.press('Enter');
  await page.keyboard.insertText(text);
  await frame.getByText(text, { exact: true }).waitFor();
}

export async function verifyEditorRecovery({ page, frame, evidence, marker }) {
  await setGenOfficeEnabled(page, false);
  const unsavedText = 'Unsaved text after plugin disable';
  await appendParagraph(frame, page, unsavedText);
  const disabledSave = page.waitForResponse(
    (response) =>
      response.url().endsWith('/editor-bridge') && response.request().postDataJSON()?.operation === 'content.settle',
  );
  await frame.getByRole('button', { name: '保存 (⌘S)', exact: true }).click();
  assert.equal((await disabledSave).status(), 409);
  await page.getByTestId('content-editor-disconnected').waitFor();
  await frame.getByText(unsavedText, { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'disabled-unsaved-preserved.png'), fullPage: true });
  await setGenOfficeEnabled(page, true);
  await page.getByRole('button', { name: '重新打开', exact: true }).click();
  await page.getByRole('button', { name: '保留当前编辑', exact: true }).click();
  await frame.getByText(unsavedText, { exact: true }).waitFor();
  assert.equal(frame.isDetached(), false, 'cancel must preserve the original editor and draft');
  const oldSrc = frame.url();
  await page.getByRole('button', { name: '重新打开', exact: true }).click();
  await page.getByRole('button', { name: '丢弃修改并重新打开', exact: true }).click();
  await page.waitForFunction((oldSrc) => {
    const next = document.querySelector('[data-testid="content-editor-connected"] iframe');
    return next && next.src !== oldSrc;
  }, oldSrc);
  const recovered = await (
    await page.locator('[data-testid="content-editor-connected"] iframe').elementHandle()
  ).contentFrame();
  assert.ok(recovered);
  await recovered.getByText(marker, { exact: true }).waitFor();
  assert.equal(await recovered.getByText(unsavedText, { exact: true }).count(), 0);
  assert.ok((await editorLayout(recovered)).visible);
  await page.screenshot({ path: path.join(evidence, 'reenabled-explicit-reopen.png'), fullPage: true });
}
