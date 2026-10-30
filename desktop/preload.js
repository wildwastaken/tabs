// Exposes a minimal, Ultimate-Guitar-only bridge to the tabs site.
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("tabsDesktop", {
  fetchTabPage: url => ipcRenderer.invoke("ug:fetch-page", url),
  openTabPage: url => ipcRenderer.invoke("ug:open-page", url),
})
