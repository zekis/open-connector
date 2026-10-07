import { app, BrowserWindow, dialog, Menu, nativeImage, screen, session, shell, Tray } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayUrl, isExternalUrl, isGatewayUrl } from "./navigation.mjs";
import { readWindowState, saveWindowState } from "./window-state.mjs";

const smokeTest = process.argv.includes("--smoke-test");
if (smokeTest) app.disableHardwareAcceleration();
app.setPath(
  "userData",
  smokeTest ? join(app.getPath("temp"), "ocgw-desktop-smoke") : join(app.getPath("appData"), "OCGW"),
);
app.setName("OCGW");
app.setAppUserModelId("org.openconnector.ocgw.desktop");
let window;
let tray;
let quitting = false;

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function openExternal(url) {
  if (!isExternalUrl(url)) return;
  try {
    await shell.openExternal(url);
  } catch {
    if (!smokeTest) dialog.showErrorBox("Unable to open link", "Open this link in your browser instead.");
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => app.quit());
  void app
    .whenReady()
    .then(startDesktop)
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
}

async function startDesktop() {
  const statePath = join(app.getPath("userData"), "window-state.json");
  const state = readWindowState(statePath, screen.getAllDisplays());
  const icon = nativeImage.createFromPath(fileURLToPath(new URL("./assets/icon.png", import.meta.url)));
  const browserSession = session.fromPartition(smokeTest ? "persist:ocgw-smoke" : "persist:ocgw");
  let microphoneAllowed = false;
  browserSession.setPermissionCheckHandler(
    (contents, permission, origin, details) =>
      microphoneAllowed &&
      permission === "media" &&
      details.mediaType === "audio" &&
      isGatewayUrl(origin) &&
      Boolean(contents && isGatewayUrl(contents.getURL())),
  );
  browserSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (
      smokeTest ||
      !contents ||
      !isGatewayUrl(contents.getURL()) ||
      !isGatewayUrl(details.requestingUrl) ||
      permission !== "media" ||
      !details.mediaTypes?.length ||
      details.mediaTypes.some((type) => type !== "audio")
    ) {
      callback(false);
      return;
    }
    const answer = await dialog.showMessageBox(window, {
      type: "question",
      title: "OCGW microphone",
      message: "Allow OCGW to use your microphone for voice input?",
      buttons: ["Allow", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    microphoneAllowed = answer.response === 0;
    callback(microphoneAllowed);
  });
  window = new BrowserWindow({
    ...state,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: "OCGW",
    icon,
    backgroundColor: "#111827",
    webPreferences: {
      session: browserSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  if (state.maximized && !smokeTest) window.maximize();
  const reload = () => {
    void window.loadURL(gatewayUrl).catch(() => {});
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "OCGW",
        submenu: [
          { label: "Home", click: reload },
          { label: "Open in browser", click: () => void openExternal(gatewayUrl) },
          { type: "separator" },
          { label: "Hide to tray", click: () => window.hide() },
          { label: "Quit OCGW", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
  tray = new Tray(icon.resize({ width: 24, height: 24 }));
  tray.setToolTip("OCGW — Open Connector Gateway");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open OCGW", click: showWindow },
      { label: "Reload", click: reload },
      { type: "separator" },
      { label: "Quit OCGW", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", showWindow);
  window.on("close", (event) => {
    saveWindowState(statePath, window);
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("minimize", () => window.hide());
  window.on("session-end", () => {
    quitting = true;
    saveWindowState(statePath, window);
  });
  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle("OCGW");
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, url) => {
    if (!isGatewayUrl(url)) {
      event.preventDefault();
      void openExternal(url);
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isGatewayUrl(url)) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isGatewayUrl(url)) void window.loadURL(url).catch(() => {});
    else void openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || smokeTest) return;
    void dialog
      .showMessageBox(window, {
        type: "warning",
        title: "OCGW is unavailable",
        message: "Check your connection, then choose Retry.",
        buttons: ["Retry", "Close"],
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) reload();
      });
  });
  window.once("ready-to-show", () => {
    if (!smokeTest) window.show();
  });
  if (smokeTest) {
    const timeout = setTimeout(() => {
      console.error("Desktop smoke test timed out");
      app.exit(1);
    }, 45000);
    try {
      await window.loadURL(gatewayUrl);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (document.querySelector('input[type="password"]')) { clearInterval(timer); resolve(true); }
          else if (Date.now() - started > 20000) { clearInterval(timer); reject(new Error('Login screen did not render')); }
        }, 100);
      })`);
      const result = await window.webContents.executeJavaScript(
        "({url:location.href, node:typeof window.require, text:document.body.innerText.slice(0,400)})",
      );
      if (!isGatewayUrl(result.url) || result.node !== "undefined")
        throw new Error("Unexpected renderer isolation or URL");
      const screenshot = join(app.getPath("temp"), "ocgw-desktop-smoke.png");
      writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
      window.close();
      if (window.isDestroyed() || window.isVisible()) throw new Error("Close-to-tray failed");
      console.log(
        JSON.stringify({ ...result, screenshot, persistentSession: browserSession.isPersistent(), closeToTray: true }),
      );
      clearTimeout(timeout);
      app.quit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  } else reload();
}
