import { readFile } from 'node:fs/promises';
import { realSurfaceApiResponse, THREAD_ID } from '../f307-real-surface-fixtures.mjs';

/** Isolated domain/preview reads for the actual Next/F307 focus journey; no live API or Redis. */
export async function routeFocusExitFixtures(context) {
  const html = await readFile(new URL('./f322-browser-owner.html', import.meta.url), 'utf8');
  await context.route('http://preview-5334.localhost:5334/browser-owner-probe', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
  );
  let draft = null;
  await context.route('**/api/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const response = realSurfaceApiResponse(request, false);
    if (url.pathname === '/api/preview/status') response.body = { available: true, gatewayPort: 5334 };
    if (url.pathname === '/api/preview/target-health') response.body = { reachable: true };
    if (url.pathname === `/api/threads/${THREAD_ID}/composer-draft`) {
      if (request.method() === 'PUT') {
        const input = JSON.parse(request.postData());
        draft = {
          version: 1,
          ownerUserId: 'fixture-owner',
          threadId: THREAD_ID,
          revision: input.expectedRevision + 1,
          text: input.text,
          updatedAt: Date.now(),
        };
      }
      response.body = request.method() === 'PUT' ? { draft } : { draft, revision: draft?.revision ?? 0 };
    }
    return route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
}
