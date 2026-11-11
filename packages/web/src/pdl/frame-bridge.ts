import { apiFetch } from '@/utils/api-client';

const segment = "(?:[A-Za-z0-9_.~!()*'-]|%(?!2[fF]|5[cC])[A-Fa-f0-9]{2})+";
const readRoutes = [
  /^\/api\/cats$/,
  /^\/api\/config\/cat-order$/,
  /^\/api\/threads\?limit=30$/,
  new RegExp('^/api/auto-dream/cats/' + segment + '/life-settings$'),
  new RegExp('^/api/auto-dream/diaries\\?catId=' + segment + '&limit=20$'),
  new RegExp('^/api/auto-dream/diaries/' + segment + '$'),
];
const writeRoutes = [
  new RegExp('^/api/auto-dream/cats/' + segment + '/life-settings/preview$'),
  /^\/api\/auto-dream\/life-settings\/decision$/,
  new RegExp('^/api/auto-dream/diaries/' + segment + '/engagement$'),
];
export async function frameRequest(message: unknown, frame: HTMLIFrameElement, event: MessageEvent): Promise<void> {
  if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
  const source = frame.contentWindow!;
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  if (message.type !== 'clowder-frame-request') return;
  const request = message as { id?: unknown; method?: unknown; path?: unknown; body?: unknown };
  if (typeof request.id !== 'string') return;
  const reply = (status: number, body: unknown) =>
    source.postMessage({ type: 'clowder-frame-response', id: request.id, status, body }, event.origin);
  const routes = request.method === 'GET' ? readRoutes : request.method === 'POST' ? writeRoutes : [];
  const path = request.path;
  if (
    typeof path !== 'string' ||
    !routes.some((route) => route.test(path)) ||
    new URL(path, window.location.origin).pathname !== path.split('?')[0]
  ) {
    reply(403, { error: 'Frame request is not allowed' });
    return;
  }
  try {
    const response = await apiFetch(path, {
      method: request.method as string,
      ...(request.method === 'POST'
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) }
        : {}),
    });
    reply(response.status, await response.json());
  } catch (error) {
    reply(502, { error: error instanceof Error ? error.message : String(error) });
  }
}

declare global {
  interface Window {
    clowderFrameRequest: typeof frameRequest;
  }
}
