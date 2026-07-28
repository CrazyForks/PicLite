/* eslint-disable @typescript-eslint/no-require-imports -- Electron loads this main process as CommonJS. */
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const sharp = require("sharp");
const jpegtranBinary = import("jpegtran-bin").then((module) => module.default);

const IMAGE_PATTERN = /\.(?:jpe?g|png|webp|avif|tiff?|gif)$/i;
const DEFAULT_WEB_URL = "https://piclite.pages.dev";

let mainWindow = null;
let activeWatcher = null;
let activeSettings = null;
const processing = new Set();
const selectedFolders = { input: "", output: "" };

function sendWatcherEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("watcher:event", {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    time: Date.now(),
    ...event,
  });
}

function unpackedBinary(binaryPath) {
  return app.isPackaged ? binaryPath.replace("app.asar", "app.asar.unpacked") : binaryPath;
}

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `图片优化进程退出，代码 ${code}`));
    });
  });
}

function extensionFor(inputPath, format) {
  if (format === "image/jpeg") return ".jpg";
  if (format === "image/png") return ".png";
  if (format === "image/webp") return ".webp";
  return path.extname(inputPath).toLowerCase();
}

async function availableOutputPath(inputPath, settings) {
  const outputDirectory = settings.outputFolder || path.join(settings.inputFolder, "PicLite");
  await fs.mkdir(outputDirectory, { recursive: true });
  const extension = extensionFor(inputPath, settings.format);
  const base = path.basename(inputPath, path.extname(inputPath));
  let candidate = path.join(outputDirectory, `${base}-piclite${extension}`);
  let counter = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(outputDirectory, `${base}-piclite-${counter}${extension}`);
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

async function optimizeWithSharp(inputPath, temporaryPath, settings) {
  const sourceExtension = path.extname(inputPath).toLowerCase();
  const outputExtension = extensionFor(inputPath, settings.format);
  const noResize = !settings.resize;
  const jpegPassThrough = settings.mode === "lossless"
    && noResize
    && [".jpg", ".jpeg"].includes(sourceExtension)
    && [".jpg", ".jpeg"].includes(outputExtension);

  if (jpegPassThrough) {
    const metadata = await sharp(inputPath).metadata();
    const copyMode = settings.stripMetadata && (!metadata.orientation || metadata.orientation === 1) ? "none" : "all";
    await run(unpackedBinary(await jpegtranBinary), ["-copy", copyMode, "-optimize", "-progressive", "-outfile", temporaryPath, inputPath]);
    return;
  }

  let pipeline = sharp(inputPath, { failOn: "none", animated: true }).rotate();
  if (settings.resize) {
    pipeline = pipeline.resize({
      width: Math.max(1, Number(settings.maxWidth) || 2560),
      height: Math.max(1, Number(settings.maxHeight) || 2560),
      fit: "inside",
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    });
  }
  if (!settings.stripMetadata) pipeline = pipeline.keepMetadata();

  if ([".jpg", ".jpeg"].includes(outputExtension)) {
    const quality = settings.mode === "lossless" ? 100 : settings.mode === "balanced" ? 88 : 74;
    pipeline = pipeline.jpeg({ quality, mozjpeg: true, progressive: true, chromaSubsampling: settings.mode === "lossless" ? "4:4:4" : "4:2:0" });
  } else if (outputExtension === ".png") {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true, palette: settings.mode === "small", quality: settings.mode === "small" ? 84 : 100, effort: 10 });
  } else if (outputExtension === ".webp") {
    pipeline = pipeline.webp(settings.mode === "lossless" ? { lossless: true, effort: 6 } : { quality: settings.mode === "balanced" ? 84 : 70, smartSubsample: true, effort: 6 });
  } else if (outputExtension === ".avif") {
    pipeline = pipeline.avif(settings.mode === "lossless" ? { lossless: true, effort: 9 } : { quality: settings.mode === "balanced" ? 68 : 52, effort: 8 });
  } else if ([".tif", ".tiff"].includes(outputExtension)) {
    pipeline = pipeline.tiff({ compression: "lzw", quality: settings.mode === "small" ? 78 : 100 });
  } else if (outputExtension === ".gif") {
    pipeline = pipeline.gif({ effort: 10, reuse: true });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  }
  await pipeline.toFile(temporaryPath);
}

async function processWatchedFile(inputPath, settings) {
  const normalized = path.resolve(inputPath);
  if (processing.has(normalized) || /-piclite(?:-\d+)?\.[^.]+$/i.test(inputPath)) return;
  processing.add(normalized);
  let temporaryPath = "";
  try {
    const outputPath = await availableOutputPath(inputPath, settings);
    temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp${path.extname(outputPath)}`);
    const original = await fs.stat(inputPath);
    await optimizeWithSharp(inputPath, temporaryPath, settings);
    const candidate = await fs.stat(temporaryPath);
    if (!settings.resize && settings.format === "keep" && candidate.size >= original.size) {
      await fs.copyFile(inputPath, temporaryPath);
    }
    await fs.rename(temporaryPath, outputPath);
    temporaryPath = "";
    const output = await fs.stat(outputPath);
    sendWatcherEvent({ type: "success", file: path.basename(inputPath), output: outputPath, originalBytes: original.size, outputBytes: output.size });
  } catch (error) {
    if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
    sendWatcherEvent({ type: "error", file: path.basename(inputPath), message: error instanceof Error ? error.message : "图片处理失败" });
  } finally {
    processing.delete(normalized);
  }
}

async function stopWatcher() {
  if (activeWatcher) await activeWatcher.close();
  activeWatcher = null;
  activeSettings = null;
  sendWatcherEvent({ type: "stopped", message: "文件夹监测已停止" });
}

async function startWatcher(settings) {
  if (!settings?.inputFolder) return { ok: false, error: "请选择来源文件夹" };
  const inputFolder = path.resolve(settings.inputFolder);
  if (!selectedFolders.input || inputFolder !== selectedFolders.input) {
    return { ok: false, error: "请通过文件夹选择器确认来源位置" };
  }
  if (settings.outputFolder && path.resolve(settings.outputFolder) !== selectedFolders.output) {
    return { ok: false, error: "请通过文件夹选择器确认输出位置" };
  }
  const inputStat = await fs.stat(inputFolder).catch(() => null);
  if (!inputStat?.isDirectory()) return { ok: false, error: "来源文件夹不存在" };
  if (activeWatcher) await activeWatcher.close();

  const outputFolder = path.resolve(settings.outputFolder || path.join(inputFolder, "PicLite"));
  const outputIsSeparate = outputFolder !== inputFolder;
  const { watch } = await import("chokidar");
  activeSettings = { ...settings, inputFolder, outputFolder: settings.outputFolder || "" };
  activeWatcher = watch(inputFolder, {
    ignoreInitial: true,
    depth: 8,
    awaitWriteFinish: { stabilityThreshold: 900, pollInterval: 120 },
    ignored: (candidate, stat) => {
      const resolved = path.resolve(candidate);
      if (outputIsSeparate && (resolved === outputFolder || resolved.startsWith(`${outputFolder}${path.sep}`))) return true;
      return Boolean(stat?.isFile() && !IMAGE_PATTERN.test(candidate));
    },
  });
  activeWatcher.on("add", (filePath) => { if (IMAGE_PATTERN.test(filePath)) void processWatchedFile(filePath, activeSettings); });
  activeWatcher.on("error", (error) => sendWatcherEvent({ type: "error", message: error.message }));
  sendWatcherEvent({ type: "started", message: `正在监测 ${inputFolder}` });
  return { ok: true };
}

function createWindow() {
  const webUrl = process.env.PICLITE_WEB_URL || DEFAULT_WEB_URL;
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 700,
    title: "PicLite 图轻",
    backgroundColor: "#f4f6f2",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(webUrl);
  const allowedOrigin = new URL(webUrl).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (["https:", "mailto:"].includes(new URL(url).protocol)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== allowedOrigin) event.preventDefault();
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

ipcMain.handle("dialog:select-folder", async (_event, kind) => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  if (result.canceled) return null;
  const folder = path.resolve(result.filePaths[0]);
  if (kind === "input" || kind === "output") selectedFolders[kind] = folder;
  return folder;
});
ipcMain.handle("watcher:start", async (_event, settings) => {
  try { return await startWatcher(settings); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "无法启动监测" }; }
});
ipcMain.handle("watcher:stop", async () => { await stopWatcher(); return { ok: true }; });
ipcMain.handle("watcher:state", () => ({ active: Boolean(activeWatcher), settings: activeSettings || undefined }));

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { if (activeWatcher) void activeWatcher.close(); });
