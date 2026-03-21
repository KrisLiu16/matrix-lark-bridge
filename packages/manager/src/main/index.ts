import fixPath from 'fix-path';
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { WORKSPACE_ROOT } from '@mlb/shared';

// Fix PATH for macOS .app launch (GUI apps don't inherit shell PATH)
fixPath();
import { BridgeProcessManager } from './bridge-process-manager.js';
import { ConfigStore } from './config-store.js';
import { AutoStartManager } from './auto-start.js';
import { FeishuSetup } from './feishu-setup.js';
import { ClaudeSetup } from './claude-setup.js';
import { registerIPCHandlers } from './ipc-handlers.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let processManager: BridgeProcessManager;
let forceQuit = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 780,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#f8fafc', // slate-50
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // In development, load the dev server URL
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // macOS: hide window instead of closing (app stays in tray)
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !forceQuit) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  // Create a small tray icon (16x16 template image for macOS)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAA' +
    'AQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA' +
    'j0lEQVR4nGNgGAWjIUAIMP7//5+BgYFBhpGR8T8yn4GB' +
    'gYGJgYGBm5GR0YOBgcGHEUwzMDAwsDAyMvIwMjJaAMV9' +
    'GBkZJRkYGBjABjAyMv5jZGT8zcjI+I+RkfE/IyPjPwYG' +
    'BobfjIyMvxkZGX8xMjL+ZGBg+MHAwPCdgYHhGwMDwxcG' +
    'BoZPDAwMH4H4AwMDAwMAKf0bpAkYXokAAAAASUVORK5CYII='
  );
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('MLB Manager');

  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    } else {
      createWindow();
    }
  });
}

async function updateTrayMenu(): Promise<void> {
  if (!tray) return;

  const bridges = processManager ? await processManager.listBridges() : [];
  const runningCount = bridges.filter((b) => b.state === 'running').length;

  const statusLabel = runningCount > 0
    ? `${runningCount} bridge${runningCount > 1 ? 's' : ''} running`
    : 'No bridges running';

  const contextMenu = Menu.buildFromTemplate([
    { label: 'MLB Manager', enabled: false },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        forceQuit = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

app.whenReady().then(async () => {
  // Ensure workspace root directory exists
  if (!existsSync(WORKSPACE_ROOT)) {
    mkdirSync(WORKSPACE_ROOT, { recursive: true });
  }

  // Initialize modules
  processManager = new BridgeProcessManager();
  const configStore = new ConfigStore();
  const autoStart = new AutoStartManager();
  const feishuSetup = new FeishuSetup();
  const claudeSetup = new ClaudeSetup();

  // Register IPC handlers
  registerIPCHandlers(processManager, configStore, autoStart, feishuSetup, claudeSetup, () => mainWindow);

  // IPC handler for tray bridge count
  ipcMain.handle('app:get-running-count', async () => {
    const bridges = await processManager.listBridges();
    return bridges.filter((b) => b.state === 'running').length;
  });

  // Start process monitoring (check bridge PID status every 5s)
  processManager.startMonitoring();

  // Update tray menu periodically to reflect bridge status
  setInterval(() => { updateTrayMenu().catch(() => {}); }, 5000);

  // Create the system tray
  createTray();

  // Create the main window
  createWindow();

  app.on('activate', () => {
    // macOS: re-create window if dock icon is clicked and no windows are open
    if (mainWindow) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });
});

// macOS: keep app running when all windows are closed (tray stays active)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  forceQuit = true;
  // Bridge workers are detached processes; they continue running after Manager exits.
  // No cleanup needed -- that's by design.
});
