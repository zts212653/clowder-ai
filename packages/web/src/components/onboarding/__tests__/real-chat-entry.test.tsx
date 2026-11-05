import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { RealChatEntry } from '../RealChatEntry';

it('keeps keyboard focus in the first message after opening the legacy final step', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<RealChatEntry members={[]} onComplete={() => {}} />));
    expect(document.activeElement).toBe(container.querySelector('textarea'));
    expect(container.querySelector('[autofocus]')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
