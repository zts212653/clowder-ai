const { app, BrowserWindow, Menu, ipcMain, screen, session, dialog, powerMonitor } = require('electron');
const { resolve, dirname } = require('node:path');
const { readFileSync, existsSync } = require('node:fs');
const { NativeHost } = require('./native-host.cjs');
const { HostApiHost } = require('./host-api.cjs');
const { DocumentAccess } = require('./document-access.cjs');
const { ScreenContext } = require('./screen-context.cjs');
const { saveSyntheticAudio, saveSyntheticMedia } = require('./synthetic-audio.cjs');
const { ORIGIN, allowMicrophone, allowDisplayCapture, validateOffer } = require('./policy.cjs');
const synthetic = process.argv.includes('--synthetic');
const hostApiUrl = process.env.F317_HOST_API_URL;
const root = resolve(__dirname, '../..');
const storage = resolve(
  root,
  `.cat-cafe/f317-live/${hostApiUrl ? 'host-' : ''}${synthetic ? 'synthetic-safe' : 'human'}`,
);
const memoryEntry =
  process.env.F317_MEMORY_MCP ||
  (process.env.CAT_CAFE_MCP_SERVER_PATH && resolve(dirname(process.env.CAT_CAFE_MCP_SERVER_PATH), 'memory.js'));
if (!hostApiUrl && (!memoryEntry || !existsSync(memoryEntry)))
  throw new Error('F317_MEMORY_MCP must point to the existing Clowder AI memory server');
app.setName('砚砚 Live');
app.setPath('userData', resolve(storage, 'electron-profile'));
let win;
let server;
let armed = false;
let quitting = false;
let accessDialogPending = false;
let armGeneration = 0;
const documents = new DocumentAccess({
  storage,
  sourceRoot: process.env.F317_SOURCE_REPO || root,
  hostOrigin: hostApiUrl ? new URL(hostApiUrl).origin : undefined,
});
const screenContext = new ScreenContext();
const stopScreen = async () => {
  screenContext.stop();
  if (!win?.isDestroyed()) win?.webContents.send('live:event', { type: 'screen-stopped' });
  if (host.child) await host.request('screen', { observation: null }).catch(() => {});
};
const host = hostApiUrl
  ? new HostApiHost({ apiUrl: hostApiUrl, allowHomeReads: documents.allowed() })
  : new NativeHost({
      storage,
      memoryEntry,
      node: process.env.F317_NODE_BIN || 'node',
      allowHomeReads: !synthetic && documents.allowed(),
      sourceRoot: process.env.F317_SOURCE_REPO,
    });
const isSurface = (event) => event.sender === win?.webContents && event.senderFrame?.url === `${ORIGIN}/`;
function resize(expanded) {
  const before = win.getBounds();
  const area = screen.getDisplayMatching(before).workArea;
  const width = expanded ? 380 : 320;
  const height = expanded ? 590 : 350;
  win.setBounds({
    x: Math.max(area.x, Math.min(before.x + before.width - width, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(before.y + before.height - height, area.y + area.height - height)),
    width,
    height,
  });
}
host.on('event', (event) => {
  if (!win?.isDestroyed()) win?.webContents.send('live:event', event);
});
app.whenReady().then(async () => {
  server = await (await import('./server.mjs')).startServer(Number(new URL(ORIGIN).port));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(
      contents === win?.webContents &&
        !synthetic &&
        (allowMicrophone({ url: contents.getURL(), permission, mediaTypes: details.mediaTypes, armed }) ||
          allowDisplayCapture({
            url: contents.getURL(),
            permission,
            mediaTypes: details.mediaTypes,
            armed,
            selectionId: screenContext.active ? undefined : screenContext.selectionId,
          })),
    ),
  );
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: true });
  powerMonitor.on('lock-screen', () => void stopScreen());
  powerMonitor.on('suspend', () => void stopScreen());
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, origin, details) =>
      contents === win?.webContents &&
      !synthetic &&
      origin === ORIGIN &&
      (allowMicrophone({ url: contents.getURL(), permission, mediaTypes: [details.mediaType], armed }) ||
        allowDisplayCapture({
          url: contents.getURL(),
          permission,
          armed,
          selectionId: screenContext.active ? undefined : screenContext.selectionId,
        })),
  );
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: area.x + area.width - 344,
    y: area.y + area.height - 374,
    width: 320,
    height: 350,
    title: synthetic ? `砚砚 Live · ${hostApiUrl ? 'Host ' : ''}合成输入验证` : '砚砚 Live · 语音实验',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    webPreferences: {
      preload: resolve(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== `${ORIGIN}/`) event.preventDefault();
  });
  win.webContents.on('render-process-gone', () => {
    armed = false;
    void stopScreen();
    void host.stop().catch(() => {});
  });
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMain) => {
    if (isMain) {
      armed = false;
      void stopScreen();
      void host.stop().catch(() => {});
    }
  });
  ipcMain.handle('live:info', (event) => {
    if (!isSurface(event)) throw new Error('Invalid surface');
    return {
      synthetic,
      documentsAllowed: host.allowHomeReads,
      hostBacked: Boolean(host.hostBacked),
      hostOrigin: hostApiUrl ? new URL(hostApiUrl).origin : undefined,
    };
  });
  ipcMain.handle('live:documents', async (event) => {
    if (!isSurface(event) || (synthetic && !host.hostBacked) || accessDialogPending)
      throw new Error('Invalid access request');
    accessDialogPending = true;
    try {
      const result = await documents.confirm((options) => dialog.showMessageBox(win, options), Boolean(host.child));
      host.allowHomeReads = result.allowed;
      if (result.changed) host.record({ type: 'document-access', allowed: result.allowed, source: 'native-dialog' });
      if (result.changed && !result.allowed) {
        win.webContents.send('live:event', { type: 'document-access-revoked' });
        await host.stop();
      }
      return result;
    } finally {
      accessDialogPending = false;
    }
  });
  ipcMain.handle('live:arm', async (event) => {
    if (!isSurface(event)) throw new Error('Invalid surface');
    const generation = ++armGeneration;
    if (host.hostBacked) await host.prepare();
    if (generation !== armGeneration || quitting) throw new Error('语音准备已取消');
    armed = true;
  });
  ipcMain.handle('live:screen-request', (event) => {
    if (!isSurface(event) || !armed || synthetic || !host.child) throw new Error('请先开始语音');
    return screenContext.request();
  });
  ipcMain.handle('live:screen-start', async (event, selectionId, label) => {
    if (!isSurface(event) || !armed || !screenContext.start(selectionId, label)) throw new Error('共享请求已失效');
    if (host.hostBacked) await host.request('screen-open', { selectionId, label });
  });
  ipcMain.handle('live:screen-frame', async (event, selectionId, frame) => {
    if (!isSurface(event) || !armed || !screenContext.accept(selectionId, frame)) throw new Error('共享画面已失效');
    await host.request('screen', { selectionId, observation: screenContext.current() });
  });
  ipcMain.handle('live:screen-stop', async (event) => {
    if (!isSurface(event)) return;
    screenContext.stop();
    if (host.child) await host.request('screen', { observation: null }).catch(() => {});
  });
  ipcMain.handle('live:start', async (event, sdp) => {
    if (!isSurface(event) || !armed) throw new Error('Click to start first');
    validateOffer(sdp);
    host.launch();
    return host.request('start', { sdp });
  });
  ipcMain.handle('live:stop', async (event) => {
    if (!isSurface(event)) return;
    ++armGeneration;
    armed = false;
    await stopScreen();
    await host.stop();
  });
  ipcMain.handle('live:text', (event, text, clientMessageId) => {
    if (!isSurface(event) || typeof text !== 'string' || text.length > 8000) throw new Error('Invalid message');
    if (host.hostBacked && (typeof clientMessageId !== 'string' || !/^[a-f0-9-]{36}$/i.test(clientMessageId)))
      throw new Error('Invalid message identity');
    host.record({ type: 'typed-input', text });
    return host.request('text', { text, clientMessageId });
  });
  ipcMain.on('live:resize', (event, expanded) => {
    if (isSurface(event)) resize(expanded === true);
  });
  ipcMain.on('live:record', (event, value) => {
    if (
      !isSurface(event) ||
      !value ||
      !['transcript', 'transcript-boundary', 'media', 'transport', 'stopping', 'stopped', 'error'].includes(value.type)
    )
      return;
    if (synthetic) saveSyntheticMedia(storage, value);
    host.record(value);
  });
  ipcMain.handle('live:fixture', (event) => {
    if (!isSurface(event) || !synthetic) throw new Error('Synthetic verification only');
    return readFileSync(resolve(storage, 'input.wav')).toString('base64');
  });
  ipcMain.handle('live:audio-evidence', (event, base64) => {
    if (!isSurface(event) || !synthetic) throw new Error('Raw human audio is not retained');
    saveSyntheticAudio(storage, base64);
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: app.name, submenu: [{ label: '显示砚砚', click: () => win.show() }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    ]),
  );
  await win.loadURL(`${ORIGIN}/`);
  console.log(
    `F317 Live ready ${ORIGIN}; mode=${synthetic ? 'synthetic' : 'click-to-talk'}; evidence=${host.logPath || 'Host thread'}`,
  );
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  armed = false;
  void host
    .stop()
    .catch(() => {})
    .finally(() => {
      server?.close();
      app.quit();
    });
});
