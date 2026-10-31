// Explicit native design candidate; never boots the production ServiceManager.
const { app, BrowserWindow, Menu, Tray, ipcMain, screen, session } = require('electron');
const path = require('node:path');
const { createDesktopTray } = require('../desktop-update-menu');

const origin = 'http://127.0.0.1:3381';
app.setName('Clowder AI Companion Design');
app.setPath('userData', path.resolve(__dirname, '../../.cat-cafe/f317-design-profile'));
let panel;
let pointWindow;
let tray;
let server;
const panelSender = (event) => event.sender === panel?.webContents && event.senderFrame?.url === `${origin}/`;

function closePoint() {
  if (pointWindow && !pointWindow.isDestroyed()) pointWindow.close();
  pointWindow = null;
}

function pickPoint() {
  closePoint();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  pointWindow = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'point-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pointWindow.setAlwaysOnTop(true, 'screen-saver');
  pointWindow.loadFile(path.join(__dirname, 'point.html'));
  pointWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pointWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  pointWindow.on('blur', closePoint);
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  server = await (await import('./server.mjs')).startServer();
  const area = screen.getPrimaryDisplay().workArea;
  panel = new BrowserWindow({
    x: area.x + area.width - 156,
    y: area.y + area.height - 176,
    width: 128,
    height: 152,
    title: '砚砚 · 桌面伴随体验稿',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    minWidth: 128,
    minHeight: 152,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.webContents.on('will-navigate', (event, url) => {
    if (url !== `${origin}/`) event.preventDefault();
  });
  panel.loadURL(`${origin}/`);
  tray = createDesktopTray({
    Menu,
    Tray,
    iconPath: path.join(__dirname, '../assets/icon.png'),
    getMainWindow: () => panel,
    onManualUpdate: () => {},
    onQuit: () => app.quit(),
    showAbout: () => panel.show(),
  });
  tray?.setToolTip('桌面伴随 · 体验稿 · 未采集');
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示砚砚体验稿',
        click: () => {
          panel.show();
          panel.focus();
        },
      },
      { label: '隐藏浮窗', click: () => panel.hide() },
      { type: 'separator' },
      { label: '退出体验稿', click: () => app.quit() },
    ]),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'quit' }] },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      { label: '体验稿', submenu: [{ role: 'reload', label: '重新载入体验稿' }] },
    ]),
  );
  ipcMain.on('design:resize', (event, mode) => {
    if (!panelSender(event)) return;
    const sizes = {
      compact: [128, 152],
      narrow: [320, Math.min(760, area.height - 70)],
      normal: [392, Math.min(760, area.height - 70)],
    };
    if (!sizes[mode]) return;
    const previous = panel.getBounds();
    const desktop = screen.getDisplayMatching(previous).workArea;
    const [width, height] = sizes[mode];
    panel.setBounds({
      x: Math.max(desktop.x, Math.min(previous.x + previous.width - width, desktop.x + desktop.width - width)),
      y: Math.max(desktop.y, Math.min(previous.y + previous.height - height, desktop.y + desktop.height - height)),
      width,
      height,
    });
  });
  ipcMain.on('design:point', (event) => {
    if (panelSender(event)) pickPoint();
  });
  ipcMain.on('design:clear-point', (event) => {
    if (panelSender(event)) closePoint();
  });
  ipcMain.on('design:point-cancel', (event) => {
    if (event.sender === pointWindow?.webContents) closePoint();
  });
  ipcMain.on('design:selected', (event, point) => {
    if (event.sender !== pointWindow?.webContents || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    const { x, y, width, height } = pointWindow.getBounds();
    if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return;
    panel.webContents.send('design:point-selected', { x: x + point.x, y: y + point.y });
    closePoint();
  });
  console.log('F317 design candidate ready on http://127.0.0.1:3381; no capture/provider/backend.');
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  closePoint();
  tray?.destroy();
  server?.close();
});
