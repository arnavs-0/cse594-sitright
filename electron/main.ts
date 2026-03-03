import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, screen } from 'electron'
import path from 'node:path'

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null = null
let overlayWin: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

function createWindow() {
  win = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f172a',
    show: false,
  })

  win.once('ready-to-show', () => {
    win?.show()
  })

  // Minimize to tray instead of closing
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win?.hide()
    }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(process.env.DIST!, 'index.html'))
  }
}

function createTray() {
  // Create a simple 16x16 tray icon
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAIRlWElmTU0AKgAAAAgABQESAAMAAAABAAEAAAEaAAUAAAABAAAASgEbAAUAAAABAAAAUgEoAAMAAAABAAIAAIdpAAQAAAABAAAAWgAAAAAAAABIAAAAAQAAAEgAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAABCgAwAEAAAAAQAAABAAAAAAFOcNJAAAAAlwSFlzAAALEwAACxMBAJqcGAAAAVlpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IlhNUCBDb3JlIDYuMC4wIj4KICAgPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4KICAgICAgPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIKICAgICAgICAgICAgeG1sbnM6dGlmZj0iaHR0cDovL25zLmFkb2JlLmNvbS90aWZmLzEuMC8iPgogICAgICAgICA8dGlmZjpPcmllbnRhdGlvbj4xPC90aWZmOk9yaWVudGF0aW9uPgogICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KICAgPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KGV7hBwAAAMBJREFUOBFjYBhowIgswMTIyLgByP4HxECF/0E0kM+MrBjEBkpmBGJ+IOYHYn4gFgBiASQxkDQTkM0PVccPpIFq+YFYAKSWEaoOJIlsBkymIP0gN4DcAHIDPxCDbAMGA7IZgGyQl0BuAIUFP5IbQOGE7AZ+qJdAajAkQXEBNxDjUiAvFBNNMEM1w8xFVo/TxJACWYAsj+wFZCMRDsMEoxkweZibQO5B9gKeWwUgMxhrwM1EF0ARsEYhAABHfEh1g6Ih5QAAAABJRU5ErkJggg=='
  )

  tray = new Tray(icon.resize({ width: 16, height: 16 }))

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show SitRight',
      click: () => {
        win?.show()
        win?.focus()
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setToolTip('SitRight — Posture Monitor')
  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    win?.show()
    win?.focus()
  })
}

// ── Overlay window (screen-edge glow) ─────────────────────────
function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().bounds

  overlayWin = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  })

  // Allow clicks to pass through the overlay
  overlayWin.setIgnoreMouseEvents(true, { forward: true })

  // Ensure overlay stays above fullscreen apps on macOS
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')

  const overlayPath = app.isPackaged
    ? path.join(process.env.DIST!, 'overlay.html')
    : path.join(process.env.VITE_PUBLIC!, 'overlay.html')
  overlayWin.loadFile(overlayPath)

  overlayWin.on('closed', () => {
    overlayWin = null
  })
}

// IPC: desktop notifications from the renderer
ipcMain.handle('send-notification', (_event, title: string, body: string) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }
})

// IPC: overlay glow
ipcMain.handle('overlay-show', (_event, status: string) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay-update', status)
  }
})

ipcMain.handle('overlay-hide', () => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay-update', 'hide')
  }
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('ready', () => {
  createWindow()
  createTray()
  createOverlay()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    win?.show()
  }
})
