const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { pathToFileURL } = require('url');

let mainWindow;

/* Register a custom `theme://` scheme that maps to the theme/
 * folder inside the app bundle. This lets the user drop fonts
 * (or any other asset) into theme/ and reference them from CSS
 * with `url('theme://something.ttf')`. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'theme',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    title: 'mini',
    backgroundColor: '#1f1e1d',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Reload is intentionally disabled. Block every known reload shortcut
  // at the webContents level (menu item is also gone). To pick up code
  // changes the user must close and reopen the app.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const k = (input.key || '').toLowerCase();
    if (k === 'f5') return event.preventDefault();
    if ((input.meta || input.control) && k === 'r') return event.preventDefault();
  });
}

const macMenu = Menu.buildFromTemplate([
  {
    label: 'mini',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  },
  {
    label: 'File',
    submenu: [
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu', 'open') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu', 'save') },
      { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu', 'saveAs') },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z',
        click: () => mainWindow && mainWindow.webContents.send('app-cmd', 'undo') },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z',
        click: () => mainWindow && mainWindow.webContents.send('app-cmd', 'redo') },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  },
  {
    label: 'View',
    submenu: [
      { label: 'Toggle Fullscreen', role: 'togglefullscreen', accelerator: 'CmdOrCtrl+Shift+F' },
      { type: 'separator' },
      { label: 'Increase Font', accelerator: 'CmdOrCtrl+Plus',
        click: () => mainWindow && mainWindow.webContents.send('zoom', +0.1) },
      { label: 'Decrease Font', accelerator: 'CmdOrCtrl+-',
        click: () => mainWindow && mainWindow.webContents.send('zoom', -0.1) },
    ],
  },
]);

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: 'mini · Minimalist Markdown Editor',
    applicationVersion: app.getVersion(),
    copyright: 'Jose Antonio Lopez · https://github.com/jalopezsuarez/mini',
    authors: ['Jose Antonio Lopez · https://github.com/jalopezsuarez/mini'],
    credits: 'Jose Antonio Lopez · https://github.com/jalopezsuarez/mini',
    website: 'https://github.com/jalopezsuarez/mini',
  });

  const themeDir = path.join(__dirname, 'theme');
  protocol.handle('theme', (request) => {
    // theme:// is a standard scheme, so Chromium splits hostname / pathname:
    //   theme://copernicus.ttf       → hostname="copernicus.ttf", pathname="/"
    //   theme://sub/copernicus.ttf   → hostname="sub",            pathname="/copernicus.ttf"
    let rel;
    try {
      const u = new URL(request.url);
      rel = decodeURIComponent(u.hostname + (u.pathname === '/' ? '' : u.pathname));
    } catch {
      rel = decodeURIComponent(request.url.replace(/^theme:\/\//, '').replace(/\/$/, ''));
    }
    // sandbox: never let `..` climb out of the theme folder
    const safe = path.normalize('/' + rel).slice(1);
    const abs = path.join(themeDir, safe);
    if (!abs.startsWith(themeDir)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(abs).toString());
  });

  Menu.setApplicationMenu(macMenu);
  createWindow();

  // Offer to install the `mini` CLI shortcut on first run.
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingOpenPath) {
      try {
        const content = fs.readFileSync(pendingOpenPath, 'utf8');
        mainWindow.webContents.send('open-file-from-os', { path: pendingOpenPath, content });
      } catch (e) { console.warn('open-file failed', e); }
      pendingOpenPath = null;
    }
    maybeOfferCliInstall().catch((e) => console.warn('cli install offer failed', e));
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/* ============================================================
 * `mini` CLI shortcut — first-run install prompt
 * ============================================================ */

const CLI_PATH = '/usr/local/bin/mini';

function cliInstalledFlag() {
  return path.join(app.getPath('userData'), 'cli-asked.flag');
}

async function maybeOfferCliInstall() {
  if (!app.isPackaged) return;                   // skip in `npm start`
  if (fs.existsSync(cliInstalledFlag())) return; // already asked
  if (fs.existsSync(CLI_PATH)) {                 // already installed
    try { fs.writeFileSync(cliInstalledFlag(), '1'); } catch {}
    return;
  }

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Instalar comando "mini"',
    message: '¿Instalar el comando "mini" en el sistema?',
    detail: 'Crea /usr/local/bin/mini para que puedas lanzar la app desde el terminal escribiendo "mini" (o "mini archivo.md").',
    buttons: ['Instalar', 'Ahora no'],
    defaultId: 0,
    cancelId: 1,
  });

  try { fs.writeFileSync(cliInstalledFlag(), '1'); } catch {}
  if (response !== 0) return;

  try {
    await installCli();
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Listo',
      message: 'Comando "mini" instalado.',
      detail: 'Abre una nueva terminal y prueba: mini',
    });
  } catch (e) {
    dialog.showErrorBox('No se pudo instalar', String(e.message || e));
  }
}

function installCli() {
  // Robust launcher: open by bundle id so the script keeps working even
  // if the user moves mini.app elsewhere later.
  const script = `#!/bin/bash
exec open -b com.mini.app "$@"
`;
  // Try direct write first (works if /usr/local/bin is user-writable)
  try {
    fs.mkdirSync(path.dirname(CLI_PATH), { recursive: true });
    fs.writeFileSync(CLI_PATH, script, { mode: 0o755 });
    return Promise.resolve();
  } catch {/* fall through to elevated install */}

  // Elevate via osascript admin privileges
  const tmp = path.join(app.getPath('temp'), 'mini-cli-' + Date.now());
  fs.writeFileSync(tmp, script);
  fs.chmodSync(tmp, 0o755);

  const shell =
    `mkdir -p ${shq(path.dirname(CLI_PATH))} && ` +
    `mv ${shq(tmp)} ${shq(CLI_PATH)} && ` +
    `chmod 755 ${shq(CLI_PATH)}`;
  const osa = `do shell script "${shell.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;

  return new Promise((resolve, reject) => {
    exec(`osascript -e ${JSON.stringify(osa)}`, (err) => err ? reject(err) : resolve());
  });
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* macOS forwards `mini somefile.md` (or a Finder open) as open-file events. */
let pendingOpenPath = null;
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow && mainWindow.webContents) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      mainWindow.webContents.send('open-file-from-os', { path: filePath, content });
    } catch (e) { console.warn('open-file failed', e); }
  } else {
    pendingOpenPath = filePath;
  }
});

ipcMain.handle('open-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (canceled || !filePaths[0]) return null;
  const content = fs.readFileSync(filePaths[0], 'utf8');
  return { path: filePaths[0], content };
});

ipcMain.handle('save-file', async (_e, { path: filePath, content, forceDialog }) => {
  if (!filePath || forceDialog) {
    const { canceled, filePath: chosen } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filePath || 'untitled.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !chosen) return null;
    filePath = chosen;
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
});

ipcMain.handle('get-theme-css', async () => {
  const themeDir = path.join(__dirname, 'theme');
  const read = (n) => {
    const p = path.join(themeDir, n);
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
  };
  let fonts = [];
  try {
    fonts = fs.readdirSync(themeDir)
      .filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
      .sort();
  } catch {}
  return {
    source: read('theme.source.css'),
    editor: read('theme.editor.css'),
    fonts,
  };
});
