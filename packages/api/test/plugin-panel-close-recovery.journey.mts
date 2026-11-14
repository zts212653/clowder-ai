import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { buildPluginPanelBrowser } from './fixtures/plugin-panel-browser.mts';

const artifactRoot = resolve(process.env.FEEDBACK_JOURNEY_ARTIFACTS ?? '../../artifacts/plugin-panel-close');
await mkdir(artifactRoot, { recursive: true });
const assets = await buildPluginPanelBrowser();
await writeFile(join(artifactRoot, 'host.css'), assets.css);
const app = Fastify();
app.get('/api/session', async () => ({ userId: 'fixture', csrfToken: 'fixture-csrf' }));
app.get('/api/plugin-ui', async () => ({
  entries: [
    {
      pluginId: 'dev.close',
      instanceId: 'fixture',
      commandId: 'open',
      resourcePath: 'panel',
      generation: 'fixture',
      label: 'Close fixture',
    },
  ],
}));
app.get('/api/plugins/dev.close/panel', async (_, reply) =>
  reply.type('text/html').send(`
  <style>body{margin:0;background:#111;color:white}button{margin:0}</style>
  <button>Plugin primary action</button>
  <script>
    let requestId=0;
    window.send=type=>parent.postMessage({channel:'clowder-plugin-ui/v1',nonce:window.name,requestId:++requestId,type,value:true},'*');
    window.addEventListener('message',event=>{
      if(event.data.requestId===1 && event.data.result) window.ready=true;
      if(event.data.type==='before-close' && window.fast) setTimeout(()=>window.send('close'),30);
    });
    window.send('close.guard');
  </script>`),
);
app.get('/', async (_, reply) =>
  reply.type('text/html').send(`<!doctype html><html data-theme="light">
  <style>${assets.css}</style><body><aside id="rail"></aside>
  <script>document.documentElement.setAttribute('data-cat-cafe-api-origin',location.origin);${assets.script}</script></body></html>`),
);
app.get('/embed', async (_, reply) =>
  reply.type('text/html').send(`<!doctype html><html><body style="margin:0">
  <iframe title="Host without native modals" sandbox="allow-scripts allow-same-origin" src="/" style="width:100vw;height:100vh;border:0"></iframe>
  </body></html>`),
);
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}`;
const playwright = createRequire(import.meta.url)(process.env.FEEDBACK_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 980 } });
const errors: string[] = [];
page.on('pageerror', (error: Error) => errors.push(error.message));
const ledger = { sourceRoot: process.cwd(), url, pid: process.pid, cssSha256: assets.cssSha256, state: 'running' };
await writeFile(join(artifactRoot, 'instance-ledger.json'), JSON.stringify(ledger, null, 2));
const checks: string[] = [];
const themes: object[] = [];
try {
  await page.goto(`${url}/embed`);
  const host = page.frameLocator('iframe[title="Host without native modals"]');
  const hostFrame = page.frames().find((frame: { url(): string }) => frame.url() === `${url}/`)!;
  const open = async () => {
    await host.getByRole('button', { name: 'Close fixture', exact: true }).click();
    await host.locator('iframe').waitFor();
    const plugin = await (await host.locator('iframe').elementHandle()).contentFrame();
    await plugin.waitForFunction('window.ready===true');
    return plugin;
  };
  for (const theme of ['light', 'dark']) {
    const plugin = await open();
    await hostFrame.evaluate((value: string) => (document.documentElement.dataset.theme = value), theme);
    await plugin.evaluate((dark: boolean) => {
      document.body.style.background = dark ? '#fff' : '#111';
      document.body.style.color = dark ? '#000' : '#fff';
    }, theme === 'dark');
    await host.getByRole('button', { name: '关闭插件面板', exact: true }).click();
    await host.getByRole('button', { name: '仍然关闭', exact: true }).waitFor();
    const style = await host.locator('dialog').evaluate((dialog: HTMLDialogElement) => {
      const toolbar = dialog.firstElementChild as HTMLElement;
      const css = getComputedStyle(toolbar);
      return {
        background: css.backgroundColor,
        color: css.color,
        dialogBackground: getComputedStyle(dialog).backgroundColor,
        toolbarBottom: toolbar.getBoundingClientRect().bottom,
        iframeTop: dialog.querySelector('iframe')!.getBoundingClientRect().top,
      };
    });
    themes.push({ theme, ...style });
    await writeFile(join(artifactRoot, 'theme-observations.json'), JSON.stringify(themes, null, 2));
    assert.notEqual(style.background, 'rgba(0, 0, 0, 0)');
    assert.notEqual(style.dialogBackground, 'rgba(0, 0, 0, 0)');
    assert.ok(style.iframeTop >= style.toolbarBottom, 'Host controls must not cover plugin controls');
    await page.screenshot({ path: join(artifactRoot, `toolbar-${theme}.png`) });
    await host.getByRole('button', { name: '仍然关闭', exact: true }).click();
    const confirmation = host.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
    await confirmation.waitFor();
    await host.getByRole('button', { name: '继续等待', exact: true }).evaluate((button: HTMLButtonElement) => {
      if (document.activeElement !== button) throw Error('Cancel must receive focus');
    });
    await page.screenshot({ path: join(artifactRoot, `confirm-${theme}.png`) });
    await host.getByRole('button', { name: '继续等待', exact: true }).click();
    assert.equal(await host.locator('iframe').count(), 1);
    await host.getByRole('button', { name: '仍然关闭', exact: true }).click();
    await page.keyboard.press('Escape');
    await confirmation.waitFor({ state: 'detached' });
    assert.equal(await host.locator('iframe').count(), 1);
    await host.getByRole('button', { name: '仍然关闭', exact: true }).click();
    await host.getByRole('button', { name: '放弃并关闭', exact: true }).click();
    await host.locator('dialog').waitFor({ state: 'detached' });
    checks.push(`${theme} Host/opposite plugin: opaque controls, cancel/Escape/discard inside restricted embed`);
  }
  const fastPlugin = await open();
  await fastPlugin.evaluate('window.fast=true');
  await hostFrame.evaluate(() => {
    const changes: string[] = [];
    (window as typeof window & { closeChanges: string[] }).closeChanges = changes;
    new MutationObserver((records) =>
      records
        .flatMap((record) => Array.from(record.addedNodes))
        .forEach((node) => {
          if (/正在保存草稿|仍然关闭/.test(node.textContent ?? '')) changes.push(node.textContent ?? '');
        }),
    ).observe(document.querySelector('dialog')!, { childList: true, subtree: true });
  });
  await host.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  await host.locator('dialog').waitFor({ state: 'detached' });
  assert.deepEqual(await hostFrame.evaluate('window.closeChanges'), []);
  checks.push('30ms save never inserts slow-save/discard UI');
  const latePlugin = await open();
  await host.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  await host.getByRole('button', { name: '仍然关闭', exact: true }).click();
  await latePlugin.evaluate("window.send('close')");
  await host.locator('dialog').waitFor({ state: 'detached' });
  checks.push('late save completes while confirmation is open');
  const failedPlugin = await open();
  await host.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  await failedPlugin.evaluate("window.send('close.cancel')");
  await host.getByRole('status').filter({ hasText: '草稿未保存' }).waitFor();
  assert.equal(await host.getByRole('button', { name: '关闭插件面板', exact: true }).isEnabled(), true);
  await failedPlugin.evaluate("window.send('close')");
  checks.push('failed save immediately offers recovery');
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifactRoot, 'receipt.json'),
    JSON.stringify(
      { checks, themes, browserErrors: errors, cssSources: assets.cssSources, cssSha256: assets.cssSha256 },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await app.close();
  await writeFile(join(artifactRoot, 'instance-ledger.json'), JSON.stringify({ ...ledger, state: 'stopped' }, null, 2));
}
