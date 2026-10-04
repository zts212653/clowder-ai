import type { HumanDispositionFeedbackInput, HumanDispositionReasonCode } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanDispositionFeedbackDialog } from '../HumanDispositionFeedbackDialog';

const REASON_CODES = ['not_important', 'wrong_lane', 'bad_evidence', 'wrong', 'other'] as const;

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('HumanDispositionFeedbackDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onCancel: ReturnType<typeof vi.fn<() => void>>;
  let onSubmit: ReturnType<typeof vi.fn<(feedback: HumanDispositionFeedbackInput | undefined) => void>>;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onCancel = vi.fn();
    onSubmit = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(
    overrides: Partial<{
      open: boolean;
      reasonCodes: readonly HumanDispositionReasonCode[];
      subjectLabel: string;
      submitting: boolean;
      error: string | null;
    }> = {},
  ) {
    await act(async () => {
      root.render(
        <HumanDispositionFeedbackDialog
          open={overrides.open ?? true}
          reasonCodes={overrides.reasonCodes ?? REASON_CODES}
          subjectLabel={overrides.subjectLabel ?? '记住人物：黄挺'}
          submitting={overrides.submitting ?? false}
          error={overrides.error ?? null}
          onCancel={onCancel}
          onSubmit={onSubmit}
        />,
      );
    });
  }

  it('opens as an accessible dialog with no implicit reason and focuses the first option', async () => {
    await render();

    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('记住人物：黄挺');
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(REASON_CODES.length);
    expect([...radios].every((radio) => !radio.checked)).toBe(true);
    expect(document.activeElement).toBe(radios[0]);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="feedback-submit"]')?.disabled).toBe(true);
  });

  it('submits a structured reason and validates trimmed other detail at the 500-character boundary', async () => {
    await render();
    const wrong = container.querySelector<HTMLInputElement>('input[value="wrong"]');
    await act(async () => wrong?.click());
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="feedback-submit"]');
    expect(submit?.disabled).toBe(false);
    await act(async () => submit?.click());
    expect(onSubmit).toHaveBeenLastCalledWith({ reasonCode: 'wrong' });

    const other = container.querySelector<HTMLInputElement>('input[value="other"]');
    await act(async () => other?.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="feedback-other-detail"]');
    expect(textarea).not.toBeNull();
    expect(submit?.disabled).toBe(true);

    await act(async () => setTextareaValue(textarea!, '  需要人工复核  '));
    expect(submit?.disabled).toBe(false);
    await act(async () => submit?.click());
    expect(onSubmit).toHaveBeenLastCalledWith({ reasonCode: 'other', detail: '需要人工复核' });

    await act(async () => setTextareaValue(textarea!, '好'.repeat(500)));
    expect(submit?.disabled).toBe(false);
    expect(container.querySelector('[data-testid="feedback-detail-count"]')?.textContent).toContain('500 / 500');
  });

  it('keeps skip available but blocks cancel, backdrop, escape, and duplicate submit while submitting', async () => {
    await render();
    const skip = container.querySelector<HTMLButtonElement>('[data-testid="feedback-skip"]');
    await act(async () => skip?.click());
    expect(onSubmit).toHaveBeenCalledWith(undefined);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    await render({ submitting: true });
    const backdrop = container.querySelector<HTMLElement>('[data-testid="feedback-dialog-backdrop"]');
    await act(async () => backdrop?.click());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="feedback-skip"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="feedback-cancel"]')?.disabled).toBe(true);
  });

  describe('what the user already picked and typed outlives a background refresh of the same question', () => {
    const pickOtherAndType = async (text: string) => {
      await act(async () => container.querySelector<HTMLInputElement>('input[value="other"]')?.click());
      const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="feedback-other-detail"]');
      if (!textarea) throw new Error('picking "other" should have opened the detail field');
      await act(async () => {
        textarea.focus();
        setTextareaValue(textarea, text);
      });
      return textarea;
    };

    it('keeps the reason, the text and the focus when the same reasons come back as a fresh array', async () => {
      await render();
      const textarea = await pickOtherAndType('不是他本人说的');
      expect(document.activeElement).toBe(textarea);

      await render({ reasonCodes: [...REASON_CODES] });

      expect(container.querySelector<HTMLInputElement>('input[value="other"]')?.checked).toBe(true);
      expect(container.querySelector<HTMLTextAreaElement>('[data-testid="feedback-other-detail"]')?.value).toBe(
        '不是他本人说的',
      );
      expect(document.activeElement).toBe(container.querySelector('[data-testid="feedback-other-detail"]'));
    });

    it('keeps what was typed when the subject line is refreshed under the open dialog, and shows the new line', async () => {
      await render();
      await pickOtherAndType('先写在这里');

      await render({ subjectLabel: '记住人物：黄挺（已更新）' });

      expect(container.querySelector<HTMLTextAreaElement>('[data-testid="feedback-other-detail"]')?.value).toBe(
        '先写在这里',
      );
      expect(container.querySelector('[role="dialog"]')?.textContent).toContain('记住人物：黄挺（已更新）');
    });

    it('drops a picked reason that is no longer offered, so it cannot be submitted, and keeps the text', async () => {
      await render();
      await pickOtherAndType('保留这句话');

      await render({ reasonCodes: ['not_important', 'wrong'] });

      expect(container.querySelector('input[value="other"]')).toBeNull();
      expect([...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].some((r) => r.checked)).toBe(
        false,
      );
      expect(container.querySelector<HTMLButtonElement>('[data-testid="feedback-submit"]')?.disabled).toBe(true);
      await render({ reasonCodes: REASON_CODES });
      await act(async () => container.querySelector<HTMLInputElement>('input[value="other"]')?.click());
      expect(container.querySelector<HTMLTextAreaElement>('[data-testid="feedback-other-detail"]')?.value).toBe(
        '保留这句话',
      );
    });

    it('still starts clean every time it is opened', async () => {
      await render();
      await pickOtherAndType('上一次写的');
      await render({ open: false });
      await render();
      expect([...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every((r) => !r.checked)).toBe(
        true,
      );
      await act(async () => container.querySelector<HTMLInputElement>('input[value="other"]')?.click());
      expect(container.querySelector<HTMLTextAreaElement>('[data-testid="feedback-other-detail"]')?.value).toBe('');
      expect(document.activeElement).toBe(container.querySelector('input[type="radio"]'));
    });
  });

  describe('a card that its host has hidden or made inert stops reacting to the keyboard', () => {
    const pressEscape = () =>
      act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

    it.each([
      'hidden',
      'inert',
    ])('ignores Escape while an ancestor is %s, and works again once it is back', async (attribute) => {
      await render();
      container.setAttribute(attribute, '');
      await pressEscape();
      expect(onCancel).not.toHaveBeenCalled();
      container.removeAttribute(attribute);
      await pressEscape();
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps an actionable route error visible in the dialog', async () => {
    await render({ error: '拒绝失败：提案状态已变化' });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('提案状态已变化');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
