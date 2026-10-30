// tabs desktop app (macOS).
//
// Loads the hosted tabs site in a window and gives it a small bridge
// (see preload.js) so Ultimate Guitar pages are loaded from this Mac's own
// connection instead of a hosting provider's server.

const { app, BrowserWindow, ipcMain, net, shell } = require("electron")
const path = require("node:path")

const APP_URL = process.env.TABS_APP_URL || "https://allenstabs.netlify.app"
const APP_ORIGIN = new URL(APP_URL).origin
const PAGE_TIMEOUT_MS = 2 * 60 * 1000

let mainWindow = null

function isUltimateGuitarUrl(input) {
  try {
    const url = new URL(String(input))
    const host = url.hostname.toLowerCase()
    return (
      url.protocol === "https:" &&
      (host === "ultimate-guitar.com" || host.endsWith(".ultimate-guitar.com"))
    )
  } catch {
    return false
  }
}

function isAppUrl(input) {
  try {
    return new URL(input).origin === APP_ORIGIN
  } catch {
    return false
  }
}

// Only the tabs site itself may use the bridge.
function assertTrustedSender(event) {
  const senderUrl = event.senderFrame && event.senderFrame.url
  if (!senderUrl || !isAppUrl(senderUrl)) {
    throw new Error("Untrusted sender")
  }
}

// Runs inside a loaded Ultimate Guitar page; mirrors the "Send to tabs" bookmarklet.
const EXTRACT_TAB_SCRIPT = `(() => {
  try {
    const el = document.querySelector(".js-store")
    const data = JSON.parse(el.getAttribute("data-content"))
    const page = (data.store || data).page.data
    const content = page.tab_view.wiki_tab.content
    if (content) {
      return { song: page.tab.song_name, artist: page.tab.artist_name, content }
    }
  } catch (e) {}
  const pre = document.querySelector("pre")
  if (pre && pre.innerText.trim()) {
    const h1 = document.querySelector("h1")
    const song = h1 ? h1.innerText.replace(/\\s+(chords|tab|tabs|ukulele|bass)\\s*$/i, "") : ""
    return { song, artist: "", content: pre.innerText }
  }
  return null
})()`

// Plain page request from this Mac (Chromium network stack, the user's own connection).
async function fetchTabPage(url) {
  const response = await net.fetch(url, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  })
  return {
    ok: response.ok,
    status: response.status,
    html: response.ok ? await response.text() : "",
  }
}

// Fallback: show the page in a normal visible window. The user sees whatever
// Ultimate Guitar shows (including any check they need to complete), and the
// song is read once the page has loaded.
function openTabPage(url) {
  return new Promise((resolve, reject) => {
    const pageWindow = new BrowserWindow({
      parent: mainWindow || undefined,
      width: 1100,
      height: 800,
      title: "Loading from Ultimate Guitar…",
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    pageWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))

    let settled = false
    let pollTimer = null
    const finish = (error, tab) => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(timeout)
      if (!pageWindow.isDestroyed()) pageWindow.close()
      if (error) reject(error)
      else resolve(tab)
    }
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for the Ultimate Guitar page")),
      PAGE_TIMEOUT_MS
    )

    const tryExtract = async () => {
      if (settled || pageWindow.isDestroyed()) return
      try {
        const tab = await pageWindow.webContents.executeJavaScript(EXTRACT_TAB_SCRIPT, true)
        if (tab && tab.content) finish(null, tab)
      } catch {
        // page still navigating; try again on the next tick
      }
    }

    pageWindow.webContents.on("did-finish-load", () => {
      tryExtract()
      clearInterval(pollTimer)
      pollTimer = setInterval(tryExtract, 1000)
    })
    pageWindow.on("closed", () => finish(new Error("Window closed before the song loaded")))
    pageWindow.loadURL(url)
  })
}

ipcMain.handle("ug:fetch-page", async (event, url) => {
  assertTrustedSender(event)
  if (!isUltimateGuitarUrl(url)) throw new Error("Not an Ultimate Guitar URL")
  return fetchTabPage(url)
})

ipcMain.handle("ug:open-page", async (event, url) => {
  assertTrustedSender(event)
  if (!isUltimateGuitarUrl(url)) throw new Error("Not an Ultimate Guitar URL")
  return openTabPage(url)
})

function showLoadError(description) {
  const html = `<!doctype html><meta charset="utf-8"><title>tabs</title>
<body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f1f5f9;color:#0f172a">
<div style="text-align:center;max-width:420px">
<h2 style="margin:0 0 8px">Can't reach tabs</h2>
<p style="color:#475569">${String(description).replace(/[<>&]/g, "")}<br>Check your internet connection.</p>
<button onclick="location.href=${JSON.stringify(APP_URL)}" style="font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer">Try again</button>
</div></body>`
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "tabs",
    backgroundColor: "#f1f5f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  // Links to other sites open in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: "deny" }
  })
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url) || url.startsWith("data:")) return
    event.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) showLoadError(description)
  })
  mainWindow.on("closed", () => {
    mainWindow = null
  })

  mainWindow.loadURL(APP_URL)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    createMainWindow()
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
}
