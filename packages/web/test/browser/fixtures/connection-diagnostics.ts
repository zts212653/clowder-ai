import { useToastStore } from '../../../src/stores/toastStore';
import { apiFetch } from '../../../src/utils/api-client';

const output = document.querySelector('#result');
document.querySelector('#send')?.addEventListener('click', () => {
  void apiFetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'fixture-private-body' }),
  })
    .then(() => {
      if (output) output.textContent = 'confirmed';
    })
    .catch((error: unknown) => {
      if (output) output.textContent = error instanceof Error ? error.name : 'unknown';
    });
});
useToastStore.subscribe((state) => {
  const notices = document.querySelector('#notices');
  if (notices) notices.textContent = state.toasts.map((toast) => toast.title).join('\n');
});
document.documentElement.dataset.ready = 'true';
