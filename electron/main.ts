import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

const X_PRELOAD = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'electron', 'xpreload.js')
  : path.join(MAIN_DIST, 'xpreload.js')

let win: BrowserWindow | null

ipcMain.handle('get-x-preload-path', () => 'file://' + X_PRELOAD.replace(/\\/g, '/'))

app.on('web-contents-created', (_, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }
})

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 700,
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  win.webContents.on('will-attach-webview', (_event, webPreferences) => {
    console.log('WILL ATTACH WEBVIEW, setting preload to', X_PRELOAD)
    webPreferences.preload = X_PRELOAD
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = false
  })

  win.maximize()

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(createWindow)