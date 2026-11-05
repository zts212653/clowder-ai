import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { waitForNativeReady } from './native-team-startup-ready.mjs';

// Optional author-only Electron debugging endpoint. Ordinary fault-injection
// tests still use their own browser. Never enable this in delivered defaults.
export async function openJourneyBrowser(web) {
  const endpoint = process.env.CAT_CAFE_ONBOARDING_E2E_CDP;
  if (!endpoint) {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      return { browser, context, page: await context.newPage(), nativeRenderer: false };
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
  const debuggerUrl = new URL(endpoint);
  assert.ok(['localhost', '127.0.0.1'].includes(debuggerUrl.hostname));
  assert.ok(debuggerUrl.port && !['3003', '3004', '6399'].includes(debuggerUrl.port));
  const instance = process.env.CAT_CAFE_ONBOARDING_E2E_INSTANCE;
  assert.ok(instance && path.isAbsolute(instance), 'Supply the owned native instance directory');
  await waitForNativeReady(
    path.join(instance, 'data/logs/startup-state.json'),
    Number(process.env.CAT_CAFE_ONBOARDING_E2E_PID),
  );
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await fetch(new URL('/json/version', debuggerUrl), { signal: AbortSignal.timeout(500) })
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) break;
    await delay(200);
  }
  assert.ok(ready, 'The explicitly owned Electron debugger did not become ready');
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0];
    assert.ok(context, 'Expected the installed Electron renderer context');
    const renderDeadline = Date.now() + 150000;
    while (Date.now() < renderDeadline) {
      // Electron owns a separate, short-lived splash window. Never mistake it
      // for the product renderer or navigate it into the app ourselves.
      const page = context.pages().find((candidate) => new URL(candidate.url()).origin === web.origin);
      if (page) return { browser, context, page, nativeRenderer: true };
      await delay(100);
    }
    throw new Error('The installed app did not open its product renderer');
  } catch (error) {
    // Playwright's CDP browserProcess.close disconnects its transport; it does
    // not terminate the independently owned Electron installation.
    await browser.close();
    throw error;
  }
}
