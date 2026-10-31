import { act } from 'react';
/** Reveal the one common menu before exercising its contextual actions. */
export async function openFileMenu(host: ParentNode) {
  if (host.querySelector('[role="menu"]')) return;
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!trigger) throw new Error('The shared file action trigger is missing');
  await act(async () => trigger.click());
}
