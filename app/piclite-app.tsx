"use client";
/* eslint-disable @next/next/no-img-element -- Blob URLs are created and revoked locally. */

import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { register as registerGlobalShortcut, unregisterAll as unregisterAllGlobalShortcuts } from "@tauri-apps/plugin-global-shortcut";

type CompressionMode = "lossless" | "balanced" | "small";
type OutputFormat = "keep" | "image/jpeg" | "image/png" | "image/webp";
type ViewName = "workspace" | "watcher" | "gallery" | "preferences";
type PreviewMode = "compare" | "original" | "result";
type ItemStatus = "ready" | "processing" | "done" | "error";
type ExportMode = "download" | "overwrite" | "same-folder" | "fixed-folder";
type WatermarkLayout = "tile" | "single";
type ThemeMode = "system" | "light" | "dark";
type UiDensity = "auto" | "comfortable" | "compact";
type ShortcutPreferenceKey = "shortcutShow" | "shortcutPaste" | "shortcutDock";
type PetVariant = "green" | "black";
type PetInteraction = "jump" | "squash" | "shake";

type WritableFileLike = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
};

type FileHandleLike = {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<WritableFileLike>;
  requestPermission?: (options: { mode: "readwrite" }) => Promise<"granted" | "denied" | "prompt">;
};

type DirectoryHandleLike = {
  name: string;
  getFileHandle: (name: string, options: { create: boolean }) => Promise<FileHandleLike>;
};

type NativeImage = { name: string; type: string; path: string; data: Uint8Array };
type NativeExportItem = { sourcePath?: string; outputName: string; data: Uint8Array };
type ImageSourceInput = { file: File; fileHandle?: FileHandleLike; sourcePath?: string };
type UploadProvider = "webdav" | "s3" | "r2" | "oss" | "ftp" | "sftp";
type DockLayout = "pet" | "compact" | "full";

type UploadSettings = {
  provider: UploadProvider;
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  username: string;
  port: number;
  remotePath: string;
  publicBaseUrl: string;
  keyPath: string;
  pathStyle: boolean;
};

type StoredUploadProfile = UploadSettings & { secret: string };

type NativeUploadPayload = UploadSettings & {
  secret: string;
  fileName: string;
  mimeType: string;
  data: Uint8Array;
};

type SystemFontInfo = {
  family: string;
  path: string;
  faceIndex: number;
};

type WatcherEvent = {
  id: string;
  type: "success" | "error" | "started" | "stopped";
  file?: string;
  output?: string;
  originalBytes?: number;
  outputBytes?: number;
  message?: string;
  time: number;
};

type WatcherSettings = {
  inputFolder: string;
  outputFolder: string;
  mode: CompressionMode;
  quality: number;
  scale: number;
  format: OutputFormat;
  resize: boolean;
  maxWidth: number;
  maxHeight: number;
  stripMetadata: boolean;
  preventLarger: boolean;
};

type NativeBridge = {
  platform: string;
  windowLabel: string;
  readClipboardImage: () => Promise<{ data: Uint8Array } | null>;
  copyImageData: (data: Uint8Array) => Promise<void>;
  copyCompressedData: (data: Uint8Array, fileName: string) => Promise<string>;
  copyImagePath: (path: string) => Promise<void>;
  selectImages: () => Promise<NativeImage[]>;
  readImagesFromPaths: (paths: string[]) => Promise<NativeImage[]>;
  selectFolder: (kind: "input" | "output" | "export") => Promise<string | null>;
  exportImages: (payload: { mode: Exclude<ExportMode, "download">; suffix: string; fixedFolder?: string; items: NativeExportItem[] }) => Promise<{ ok: boolean; paths?: string[]; error?: string }>;
  startWatcher: (settings: WatcherSettings) => Promise<{ ok: boolean; error?: string }>;
  stopWatcher: () => Promise<{ ok: boolean }>;
  getWatcherState: () => Promise<{ active: boolean; settings?: WatcherSettings }>;
  quickCompressPaths: (paths: string[], settings: QuickCompressSettings) => Promise<QuickCompressResult[]>;
  revealPath: (path: string) => Promise<void>;
  uploadImage: (payload: NativeUploadPayload) => Promise<{ url: string; remotePath: string }>;
  loadUploadProfile: () => Promise<StoredUploadProfile | null>;
  saveUploadProfile: (profile: StoredUploadProfile) => Promise<void>;
  listSystemFonts: () => Promise<SystemFontInfo[]>;
  readSystemFont: (path: string, faceIndex: number) => Promise<{ data: Uint8Array }>;
  updateDesktopPreferences: (preferences: { minimizeToTray: boolean }) => Promise<void>;
  setWindowTheme: (theme: ThemeMode) => Promise<void>;
  startDragging: () => Promise<void>;
  startResizeDragging: (direction: "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West") => Promise<void>;
  showMainWindow: () => Promise<void>;
  showDropzoneWindow: () => Promise<void>;
  configureDropzoneWindow: (width: number, height: number) => Promise<void>;
  setAlwaysOnTop: (enabled: boolean) => Promise<void>;
  hideCurrentWindow: () => Promise<void>;
  quitApplication: () => Promise<void>;
  onFileDrop: (callback: (event: { type: "over" | "drop" | "leave" | "error"; paths?: string[]; error?: string }) => void) => () => void;
  onTrayAction: (callback: (action: string) => void) => () => void;
  onWatcherEvent: (callback: (event: WatcherEvent) => void) => () => void;
};

declare global {
  interface Window {
    picLite?: NativeBridge;
    showOpenFilePicker?: (options: { multiple: boolean; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileHandleLike[]>;
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandleLike>;
    queryLocalFonts?: () => Promise<Array<{ family: string; fullName: string; postscriptName: string }>>;
  }
}

type ImageItem = {
  id: string;
  file: File;
  name: string;
  type: string;
  width: number;
  height: number;
  originalBytes: number;
  sourceUrl: string;
  outputUrl?: string;
  outputBlob?: Blob;
  outputBytes?: number;
  outputType?: string;
  outputWidth?: number;
  outputHeight?: number;
  status: ItemStatus;
  error?: string;
  keptOriginal?: boolean;
  sizeGuardQuality?: number;
  fileHandle?: FileHandleLike;
  sourcePath?: string;
};

type WatermarkSettings = {
  enabled: boolean;
  text: string;
  layout: WatermarkLayout;
  fontFamily: string;
  fontScale: number;
  color: string;
  opacity: number;
  rotation: number;
  density: number;
  positionX: number;
  positionY: number;
  shadow: boolean;
  shadowBlur: number;
  shadowColor: string;
};

type CompressionSettings = {
  mode: CompressionMode;
  quality: number;
  scale: number;
  format: OutputFormat;
  resize: boolean;
  width: number;
  height: number;
  lockRatio: boolean;
  stripMetadata: boolean;
  preventLarger: boolean;
  watermark: WatermarkSettings;
};

type DesktopPreferences = {
  exportMode: Exclude<ExportMode, "download">;
  exportSuffix: string;
  exportFolder: string;
  confirmOverwrite: boolean;
  preventLarger: boolean;
  theme: ThemeMode;
  dockTheme: ThemeMode;
  density: UiDensity;
  minimizeToTray: boolean;
  launchAtStartup: boolean;
  shortcutsEnabled: boolean;
  shortcutShow: string;
  shortcutPaste: string;
  shortcutDock: string;
  dockLayout: DockLayout;
  floatingResultSeconds: number;
  petVariant: PetVariant;
  petScale: number;
};

type SavedPreset = {
  id: string;
  name: string;
  settings: CompressionSettings;
  custom?: boolean;
};

type QuickCompressSettings = {
  quality: number;
  scale: number;
  format: OutputFormat;
  stripMetadata: boolean;
  preventLarger: boolean;
  exportMode: Exclude<ExportMode, "download">;
  exportSuffix: string;
  fixedFolder?: string;
};

type QuickCompressResult = {
  source: string;
  output?: string;
  originalBytes?: number;
  outputBytes?: number;
  keptOriginal: boolean;
  error?: string;
};

type GalleryRecord = {
  id: string;
  name: string;
  createdAt: number;
  originalBytes: number;
  outputBytes: number;
  width: number;
  height: number;
  mimeType: string;
  blob: Blob;
  sourcePath?: string;
  outputPath?: string;
  remoteUrl?: string;
};

type GalleryViewItem = GalleryRecord & { previewUrl: string };

const DEFAULT_SETTINGS: CompressionSettings = {
  mode: "lossless",
  quality: 100,
  scale: 100,
  format: "keep",
  resize: false,
  width: 1920,
  height: 1080,
  lockRatio: true,
  stripMetadata: true,
  preventLarger: true,
  watermark: {
    enabled: false,
    text: "PicLite",
    layout: "tile",
    fontFamily: "Microsoft YaHei",
    fontScale: 4.5,
    color: "#ffffff",
    opacity: 28,
    rotation: -28,
    density: 55,
    positionX: 82,
    positionY: 88,
    shadow: true,
    shadowBlur: 7,
    shadowColor: "#000000",
  },
};

const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
  exportMode: "same-folder",
  exportSuffix: "-piclite",
  exportFolder: "",
  confirmOverwrite: true,
  preventLarger: true,
  theme: "system",
  dockTheme: "system",
  density: "auto",
  minimizeToTray: true,
  launchAtStartup: false,
  shortcutsEnabled: true,
  shortcutShow: "CommandOrControl+Alt+P",
  shortcutPaste: "CommandOrControl+Alt+V",
  shortcutDock: "CommandOrControl+Alt+D",
  dockLayout: "pet",
  floatingResultSeconds: 10,
  petVariant: "green",
  petScale: 100,
};

const DEFAULT_UPLOAD_SETTINGS: UploadSettings = {
  provider: "webdav",
  endpoint: "",
  bucket: "",
  region: "auto",
  accessKey: "",
  username: "",
  port: 22,
  remotePath: "piclite",
  publicBaseUrl: "",
  keyPath: "",
  pathStyle: true,
};

function loadStoredDesktopPreferences(): DesktopPreferences {
  if (typeof window === "undefined") return DEFAULT_DESKTOP_PREFERENCES;
  try {
    const saved = window.localStorage.getItem("piclite.desktopPreferences.v1");
    return saved
      ? { ...DEFAULT_DESKTOP_PREFERENCES, ...JSON.parse(saved) } as DesktopPreferences
      : DEFAULT_DESKTOP_PREFERENCES;
  } catch {
    return DEFAULT_DESKTOP_PREFERENCES;
  }
}

function loadUploadSettings(): UploadSettings {
  if (typeof window === "undefined") return DEFAULT_UPLOAD_SETTINGS;
  try {
    const saved = window.localStorage.getItem("piclite.uploadSettings.v1");
    return saved ? { ...DEFAULT_UPLOAD_SETTINGS, ...JSON.parse(saved) } as UploadSettings : DEFAULT_UPLOAD_SETTINGS;
  } catch {
    return DEFAULT_UPLOAD_SETTINGS;
  }
}

function resolveTheme(theme: ThemeMode) {
  return theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
}

function shortcutFromKeyboardEvent(event: ReactKeyboardEvent<HTMLElement>) {
  const key = event.key;
  if (["Control", "Meta", "Alt", "Shift"].includes(key)) return null;
  if (key === "Escape") return "escape";
  if (key === "Backspace" || key === "Delete") return "";
  const modifiers: string[] = [];
  if (event.metaKey || event.ctrlKey) modifiers.push("CommandOrControl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (!modifiers.length) return null;
  const normalizedKey = key.length === 1 ? key.toUpperCase() : key.replace(/^Arrow/, "");
  return [...modifiers, normalizedKey].join("+");
}

function shortcutLabel(value: string, platform: string) {
  if (!value) return "未设置";
  const labels = value.split("+").map((part) => {
    if (part === "CommandOrControl") return platform === "darwin" ? "⌘" : "Ctrl";
    if (part === "Alt") return platform === "darwin" ? "⌥" : "Alt";
    if (part === "Shift") return platform === "darwin" ? "⇧" : "Shift";
    return part;
  });
  return labels.join(platform === "darwin" ? "  " : " + ");
}

function presetSettings(mode: CompressionMode, quality: number, scale = 100): CompressionSettings {
  return { ...DEFAULT_SETTINGS, mode, quality, scale, watermark: { ...DEFAULT_SETTINGS.watermark } };
}

const BUILT_IN_PRESETS: SavedPreset[] = [
  { id: "lossless", name: "无损优先", settings: presetSettings("lossless", 100) },
  { id: "balanced", name: "智能平衡", settings: presetSettings("balanced", 82) },
  { id: "small", name: "更小体积", settings: presetSettings("small", 45, 75) },
];

function loadStoredSettings() {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const saved = window.localStorage.getItem("piclite.compressionSettings.v2");
    if (!saved) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(saved) as Partial<CompressionSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed, watermark: { ...DEFAULT_SETTINGS.watermark, ...parsed.watermark } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadStoredPresets() {
  if (typeof window === "undefined") return BUILT_IN_PRESETS;
  try {
    const saved = window.localStorage.getItem("piclite.customPresets.v1");
    const custom = saved ? JSON.parse(saved) as SavedPreset[] : [];
    return [...BUILT_IN_PRESETS, ...custom.filter((preset) => preset.custom)];
  } catch {
    return BUILT_IN_PRESETS;
  }
}

const DEFAULT_WATCHER_SETTINGS: WatcherSettings = {
  inputFolder: "",
  outputFolder: "",
  mode: "lossless",
  quality: 100,
  scale: 100,
  format: "keep",
  resize: false,
  maxWidth: 2560,
  maxHeight: 2560,
  stripMetadata: true,
  preventLarger: true,
};

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const GALLERY_DB_NAME = "piclite-gallery";
const GALLERY_STORE_NAME = "images";

function openGalleryDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(GALLERY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(GALLERY_STORE_NAME)) request.result.createObjectStore(GALLERY_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("图库无法打开"));
  });
}

async function galleryPut(record: GalleryRecord) {
  const database = await openGalleryDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(GALLERY_STORE_NAME, "readwrite");
    transaction.objectStore(GALLERY_STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("图库写入失败"));
  });
  database.close();
}

async function galleryList() {
  const database = await openGalleryDb();
  const records = await new Promise<GalleryRecord[]>((resolve, reject) => {
    const request = database.transaction(GALLERY_STORE_NAME, "readonly").objectStore(GALLERY_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as GalleryRecord[]);
    request.onerror = () => reject(request.error || new Error("图库读取失败"));
  });
  database.close();
  return records.sort((left, right) => right.createdAt - left.createdAt);
}

async function galleryDelete(id: string) {
  const database = await openGalleryDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(GALLERY_STORE_NAME, "readwrite");
    transaction.objectStore(GALLERY_STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("图库删除失败"));
  });
  database.close();
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function savedPercent(original = 0, output = 0) {
  if (!original || !output) return 0;
  return Math.round((1 - output / original) * 100);
}

function sizeChangeLabel(original = 0, output = 0) {
  const saved = savedPercent(original, output);
  if (saved > 0) return `−${saved}%`;
  if (saved < 0) return `+${Math.abs(saved)}%`;
  return "0%";
}

function modeFromQuality(quality: number): CompressionMode {
  if (quality >= 100) return "lossless";
  if (quality >= 55) return "balanced";
  return "small";
}

function formatScale(scale: number) {
  return `${scale < 1 ? scale.toFixed(1) : Math.round(scale)}%`;
}

function outputExtension(type: string, originalName: string) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  return originalName.split(".").pop()?.toLowerCase() || "png";
}

function mimeFromName(name: string) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "avif") return "image/avif";
  if (extension === "gif") return "image/gif";
  return "application/octet-stream";
}

function outputName(item: ImageItem, suffix = "-piclite") {
  const base = item.name.replace(/\.[^.]+$/, "");
  return `${base}${suffix}.${outputExtension(item.outputType || item.type, item.name)}`;
}

function cleanSuffix(value: string) {
  const safe = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\.+$/g, "");
  if (!safe) return "-piclite";
  return safe.startsWith("-") || safe.startsWith("_") ? safe : `-${safe}`;
}

async function getDimensions(file: File) {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

async function stripPngMetadata(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 12 || !signature.every((value, index) => bytes[index] === value)) return file;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [bytes.slice(0, 8)];
  const removable = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const end = offset + 12 + length;
    if (end > bytes.length) return file;
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (!removable.has(type)) chunks.push(bytes.slice(offset, end));
    offset = end;
    if (type === "IEND") break;
  }
  return new Blob(chunks.map((chunk) => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer), { type: "image/png" });
}

async function stripJpegMetadata(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return file;
  const segments: Uint8Array[] = [bytes.slice(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return file;
    const marker = bytes[offset + 1];
    if (marker === 0xda) {
      segments.push(bytes.slice(offset));
      break;
    }
    if (marker === 0xd9) {
      segments.push(bytes.slice(offset, offset + 2));
      break;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) return file;
    const removable = marker === 0xfe || marker === 0xe1 || marker === 0xed;
    if (!removable) {
      segments.push(bytes.slice(offset, end));
    } else if (marker === 0xe1) {
      const orientation = readExifOrientation(bytes, offset, end);
      if (orientation > 1) segments.push(minimalOrientationSegment(orientation));
    }
    offset = end;
  }
  return new Blob(segments.map((segment) => segment.buffer.slice(segment.byteOffset, segment.byteOffset + segment.byteLength) as ArrayBuffer), { type: "image/jpeg" });
}

function readExifOrientation(bytes: Uint8Array, offset: number, end: number) {
  const payload = offset + 4;
  if (payload + 14 > end || String.fromCharCode(...bytes.slice(payload, payload + 6)) !== "Exif\0\0") return 1;
  const tiff = payload + 6;
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) break;
    if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
  }
  return 1;
}

function minimalOrientationSegment(orientation: number) {
  const segment = new Uint8Array(36);
  segment.set([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0);
  const view = new DataView(segment.buffer);
  const tiff = 10;
  view.setUint16(tiff, 0x4d4d, false);
  view.setUint16(tiff + 2, 42, false);
  view.setUint32(tiff + 4, 8, false);
  view.setUint16(tiff + 8, 1, false);
  view.setUint16(tiff + 10, 0x0112, false);
  view.setUint16(tiff + 12, 3, false);
  view.setUint32(tiff + 14, 1, false);
  view.setUint16(tiff + 18, Math.min(8, Math.max(1, orientation)), false);
  view.setUint32(tiff + 22, 0, false);
  return segment;
}

async function optimizeLosslessly(file: File) {
  if (file.type === "image/jpeg") return stripJpegMetadata(file);
  if (file.type === "image/png") return stripPngMetadata(file);
  return file;
}

function getTargetDimensions(item: Pick<ImageItem, "width" | "height">, settings: CompressionSettings) {
  let ratio = Math.min(1, Math.max(0.001, settings.scale / 100));
  if (settings.resize && settings.lockRatio) {
    const maxWidth = Math.max(1, settings.width || item.width);
    const maxHeight = Math.max(1, settings.height || item.height);
    ratio = Math.min(ratio, maxWidth / item.width, maxHeight / item.height);
  }

  if (settings.resize && !settings.lockRatio) {
    return {
      width: Math.max(1, Math.round(Math.min(item.width * ratio, settings.width || item.width))),
      height: Math.max(1, Math.round(Math.min(item.height * ratio, settings.height || item.height))),
    };
  }

  return {
    width: Math.max(1, Math.round(item.width * ratio)),
    height: Math.max(1, Math.round(item.height * ratio)),
  };
}

function quantizePngPixels(context: CanvasRenderingContext2D, width: number, height: number, quality: number) {
  if (quality >= 100) return;
  const normalized = Math.min(1, Math.max(0, (quality - 1) / 99));
  const levels = Math.max(2, Math.round(2 + 254 * normalized ** 3));
  const step = 255 / (levels - 1);
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = Math.round(pixels[index] / step) * step;
    pixels[index + 1] = Math.round(pixels[index + 1] / step) * step;
    pixels[index + 2] = Math.round(pixels[index + 2] / step) * step;
  }
  context.putImageData(imageData, 0, 0);
}

function applyWatermark(context: CanvasRenderingContext2D, width: number, height: number, watermark: WatermarkSettings) {
  const text = watermark.text.trim();
  if (!watermark.enabled || !text) return;

  const fontSize = Math.max(8, Math.min(width, height) * (watermark.fontScale / 100));
  context.save();
  context.globalAlpha = Math.min(1, Math.max(0.01, watermark.opacity / 100));
  context.fillStyle = watermark.color;
  context.font = `${fontSize}px "${watermark.fontFamily.replaceAll('"', "")}", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  if (watermark.shadow) {
    context.shadowColor = watermark.shadowColor;
    context.shadowBlur = watermark.shadowBlur;
    context.shadowOffsetX = Math.max(1, watermark.shadowBlur * 0.2);
    context.shadowOffsetY = Math.max(1, watermark.shadowBlur * 0.2);
  }

  const angle = watermark.rotation * Math.PI / 180;
  if (watermark.layout === "single") {
    context.translate(width * watermark.positionX / 100, height * watermark.positionY / 100);
    context.rotate(angle);
    context.fillText(text, 0, 0);
  } else {
    const diagonal = Math.hypot(width, height);
    const measured = Math.max(fontSize * 2, context.measureText(text).width);
    const density = Math.min(1, Math.max(0, watermark.density / 100));
    // A non-linear curve gives the low end real breathing room: 0% is deliberately
    // sparse enough for one or two marks on ordinary photos, while 100% stays dense.
    const sparse = (1 - density) ** 2;
    const stepX = measured + fontSize * (1.05 + sparse * 18);
    const stepY = fontSize * (1.45 + sparse * 14);
    context.translate(width / 2, height / 2);
    context.rotate(angle);
    let row = 0;
    for (let y = -diagonal; y <= diagonal; y += stepY) {
      const offset = row % 2 ? stepX / 2 : 0;
      for (let x = -diagonal - offset; x <= diagonal; x += stepX) context.fillText(text, x + offset, y);
      row += 1;
    }
  }
  context.restore();
}

type DecodedGifFrame = {
  image: {
    duration?: number | null;
    close: () => void;
  };
};

type GifDecoder = {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount?: number } | null };
  decode: (options: { frameIndex: number }) => Promise<DecodedGifFrame>;
  close: () => void;
};

type GifDecoderConstructor = new (options: { data: ArrayBuffer; type: string }) => GifDecoder;

async function animatedGifCompress(item: ImageItem, settings: CompressionSettings) {
  const Decoder = (window as unknown as { ImageDecoder?: GifDecoderConstructor }).ImageDecoder;
  if (!Decoder) throw new Error("动态 GIF 实时压缩需要最新版 Chrome、Edge 或桌面客户端");

  const { width, height } = getTargetDimensions(item, settings);
  const decoder = new Decoder({ data: await item.file.arrayBuffer(), type: "image/gif" });
  await decoder.tracks.ready;
  const frameCount = decoder.tracks.selectedTrack?.frameCount || 1;
  const encoder = GIFEncoder();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!context) {
    decoder.close();
    throw new Error("当前浏览器无法创建 GIF 画布");
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const colors = Math.max(2, Math.min(256, Math.round(2 + 254 * (settings.quality / 100) ** 1.45)));

  try {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const { image } = await decoder.decode({ frameIndex });
      context.clearRect(0, 0, width, height);
      context.drawImage(image as unknown as CanvasImageSource, 0, 0, width, height);
      applyWatermark(context, width, height, settings.watermark);
      const rgba = context.getImageData(0, 0, width, height).data;
      const palette = quantize(rgba, colors, { format: "rgba4444", oneBitAlpha: true });
      const indexed = applyPalette(rgba, palette, "rgba4444");
      const transparentIndex = palette.findIndex((color) => color[3] === 0);
      encoder.writeFrame(indexed, width, height, {
        palette,
        delay: Math.max(20, Math.round((image.duration || 100_000) / 1000)),
        repeat: 0,
        transparent: transparentIndex >= 0,
        transparentIndex: Math.max(0, transparentIndex),
      });
      image.close();
    }
    encoder.finish();
    return { blob: new Blob([new Uint8Array(encoder.bytes())], { type: "image/gif" }), width, height };
  } finally {
    decoder.close();
  }
}

async function canvasCompress(item: ImageItem, settings: CompressionSettings) {
  const bitmap = await createImageBitmap(item.file);
  const { width, height } = getTargetDimensions(item, settings);

  const sameSize = width === item.width && height === item.height;
  if (settings.quality >= 100 && settings.format === "keep" && sameSize && !settings.watermark.enabled) {
    bitmap.close();
    const blob = settings.stripMetadata ? await optimizeLosslessly(item.file) : item.file;
    return { blob, width, height };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("当前浏览器无法创建图片画布");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  let outputType = settings.format === "keep" ? item.type : settings.format;
  if (!["image/jpeg", "image/png", "image/webp"].includes(outputType)) outputType = "image/png";
  if (outputType === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  applyWatermark(context, width, height, settings.watermark);

  const quality = Math.min(1, Math.max(0.01, settings.quality / 100));
  if (outputType === "image/png") quantizePngPixels(context, width, height, settings.quality);
  const result = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outputType, quality));
  if (!result) throw new Error("当前浏览器不支持所选输出格式");
  if (settings.quality >= 100 && settings.format === "keep" && sameSize && !settings.watermark.enabled && result.size >= item.originalBytes) {
    const blob = settings.stripMetadata ? await optimizeLosslessly(item.file) : item.file;
    return { blob, width, height };
  }
  return { blob: result, width, height };
}

type CompressionResult = { blob: Blob; width: number; height: number; keptOriginal?: boolean; sizeGuardQuality?: number };

async function compressImage(item: ImageItem, settings: CompressionSettings): Promise<CompressionResult> {
  const encodeCandidate = (candidateSettings: CompressionSettings) => item.type === "image/gif" && candidateSettings.format === "keep"
    ? animatedGifCompress(item, candidateSettings)
    : canvasCompress(item, candidateSettings);
  const candidate = await encodeCandidate(settings);
  const hasVisualTransform = candidate.width !== item.width
    || candidate.height !== item.height
    || settings.format !== "keep"
    || settings.watermark.enabled;

  if (settings.preventLarger && candidate.blob.size >= item.originalBytes) {
    if (hasVisualTransform && settings.quality > 1) {
      const qualitySteps = Array.from(new Set([
        settings.quality - 4,
        settings.quality - 8,
        settings.quality - 14,
        settings.quality - 22,
        settings.quality - 32,
        settings.quality - 44,
        settings.quality - 58,
        settings.quality - 72,
        1,
      ].map((quality) => Math.max(1, Math.round(quality))))).filter((quality) => quality < settings.quality);

      for (const quality of qualitySteps) {
        const guardedCandidate = await encodeCandidate({ ...settings, quality });
        if (guardedCandidate.blob.size < item.originalBytes) {
          return { ...guardedCandidate, sizeGuardQuality: quality };
        }
      }
    }
    return { blob: item.file, width: item.width, height: item.height, keptOriginal: true };
  }
  return candidate;
}

async function createDemoFile() {
  const canvas = document.createElement("canvas");
  canvas.width = 1800;
  canvas.height = 1125;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建演示图片");
  const gradient = context.createLinearGradient(0, 0, 1800, 1125);
  gradient.addColorStop(0, "#16271f");
  gradient.addColorStop(0.48, "#397865");
  gradient.addColorStop(1, "#d7ff72");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1800, 1125);
  context.globalAlpha = 0.22;
  for (let index = 0; index < 18; index += 1) {
    context.beginPath();
    context.arc(180 + index * 110, 160 + (index % 4) * 230, 96 + (index % 3) * 26, 0, Math.PI * 2);
    context.fillStyle = index % 2 ? "#ffffff" : "#07140f";
    context.fill();
  }
  context.globalAlpha = 1;
  context.fillStyle = "#f5ffe0";
  context.font = "700 138px Arial";
  context.fillText("PicLite", 120, 860);
  context.fillStyle = "#132119";
  context.font = "600 46px Arial";
  context.fillText("清晰，轻一点。", 125, 945);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("无法生成演示图片");
  return new File([blob], "piclite-demo.png", { type: "image/png" });
}

function IconButton({ label, symbol, onClick, disabled }: { label: string; symbol: string; onClick?: () => void; disabled?: boolean }) {
  return <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}><span aria-hidden="true">{symbol}</span></button>;
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function TrayDropDock({ bridge }: { bridge: NativeBridge }) {
  const initialSettings = useMemo(loadStoredSettings, []);
  const initialPreferences = useMemo(loadStoredDesktopPreferences, []);
  const [quality, setQuality] = useState(initialSettings.quality);
  const [scale, setScale] = useState(initialSettings.scale);
  const [dockTheme, setDockTheme] = useState<ThemeMode>(initialPreferences.dockTheme);
  const [dockLayout, setDockLayout] = useState<DockLayout>(initialPreferences.dockLayout);
  const [floatingResultSeconds, setFloatingResultSeconds] = useState(initialPreferences.floatingResultSeconds);
  const [petVariant, setPetVariant] = useState<PetVariant>(initialPreferences.petVariant);
  const [petScale, setPetScale] = useState(initialPreferences.petScale);
  const [petInteraction, setPetInteraction] = useState<PetInteraction | null>(null);
  const [petBubble, setPetBubble] = useState<string | null>(null);
  const [petMenuOpen, setPetMenuOpen] = useState(false);
  const [petAlwaysOnTop, setPetAlwaysOnTop] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<QuickCompressResult[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("每次都从原图重算");
  const lastPathsRef = useRef<string[]>([]);
  const historyRef = useRef<Array<{ quality: number; scale: number; results: QuickCompressResult[] }>>([]);
  const resultSettingsRef = useRef({ quality: initialSettings.quality, scale: initialSettings.scale });
  const autoHideTimerRef = useRef<number | null>(null);
  const previewUrlsRef = useRef<Record<string, string>>({});
  const petPointerRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const petInteractionIndexRef = useRef(0);
  const petInteractionTimerRef = useRef<number | null>(null);
  const petBubbleTimerRef = useRef<number | null>(null);
  const petClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("dropzone-root");
    return () => {
      document.documentElement.classList.remove("dropzone-root");
      Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
      if (autoHideTimerRef.current) window.clearTimeout(autoHideTimerRef.current);
      if (petInteractionTimerRef.current) window.clearTimeout(petInteractionTimerRef.current);
      if (petBubbleTimerRef.current) window.clearTimeout(petBubbleTimerRef.current);
      if (petClickTimerRef.current) window.clearTimeout(petClickTimerRef.current);
    };
  }, []);

  const saveDockResults = useCallback(async (next: QuickCompressResult[]) => {
    const completed = next.filter((result) => result.output && !result.error);
    if (!completed.length) return;
    try {
      const images = await bridge.readImagesFromPaths(completed.map((result) => result.output!));
      const nextPreviews: Record<string, string> = {};
      for (const image of images) {
        const result = completed.find((candidate) => candidate.output === image.path);
        const blob = new Blob([new Uint8Array(image.data)], { type: image.type || mimeFromName(image.name) });
        if (result) nextPreviews[result.source] = URL.createObjectURL(blob);
        const dimensions = await getDimensions(new File([blob], image.name, { type: blob.type }));
        await galleryPut({
          id: `dock:${result?.source || image.path}`,
          name: image.name,
          createdAt: Date.now(),
          originalBytes: result?.originalBytes || blob.size,
          outputBytes: result?.outputBytes || blob.size,
          width: dimensions.width,
          height: dimensions.height,
          mimeType: blob.type,
          blob,
          sourcePath: result?.source,
          outputPath: image.path,
        });
      }
      Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current = nextPreviews;
      setPreviewUrls(nextPreviews);
    } catch { /* 图库失败不影响快速压缩 */ }
  }, [bridge]);

  const runCompression = useCallback(async (paths: string[], nextQuality = quality, nextScale = scale, remember = true) => {
    if (!paths.length || isProcessing) return;
    if (remember && results.length) {
      historyRef.current.push({ ...resultSettingsRef.current, results });
      historyRef.current = historyRef.current.slice(-12);
    }
    lastPathsRef.current = paths;
    setIsProcessing(true);
    setNotice("正在从原图重新计算…");
    Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = {};
    setPreviewUrls({});
    setResults(paths.map((source) => ({ source, keptOriginal: false })));
    try {
      let preferences = DEFAULT_DESKTOP_PREFERENCES;
      try {
        const stored = window.localStorage.getItem("piclite.desktopPreferences.v1");
        if (stored) preferences = { ...preferences, ...JSON.parse(stored) };
      } catch { /* 使用安全默认值 */ }
      const next = await bridge.quickCompressPaths(paths, {
        quality: nextQuality,
        scale: nextScale,
        format: initialSettings.format,
        stripMetadata: initialSettings.stripMetadata,
        preventLarger: preferences.preventLarger,
        exportMode: preferences.exportMode === "overwrite" ? "same-folder" : preferences.exportMode,
        exportSuffix: preferences.exportSuffix,
        fixedFolder: preferences.exportFolder || undefined,
      });
      setResults(next);
      resultSettingsRef.current = { quality: nextQuality, scale: nextScale };
      setNotice(`已按 ${nextQuality}% 画质 · ${formatScale(nextScale)} 尺寸生成`);
      void saveDockResults(next);
    } catch (error) {
      setResults(paths.map((source) => ({ source, keptOriginal: false, error: error instanceof Error ? error.message : "压缩失败" })));
    } finally {
      setIsProcessing(false);
    }
  }, [bridge, initialSettings.format, initialSettings.stripMetadata, isProcessing, quality, results, saveDockResults, scale]);

  const clearAutoHide = useCallback(() => {
    if (autoHideTimerRef.current) window.clearTimeout(autoHideTimerRef.current);
    autoHideTimerRef.current = null;
  }, []);

  const scheduleAutoHide = useCallback(() => {
    clearAutoHide();
    if (!floatingResultSeconds || isProcessing || !results.some((result) => result.output || result.error)) return;
    autoHideTimerRef.current = window.setTimeout(() => {
      if (dockLayout !== "pet") {
        void bridge.hideCurrentWindow();
        return;
      }
      Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current = {};
      setPreviewUrls({});
      setResults([]);
      setNotice("双击选图，单击和我玩");
    }, floatingResultSeconds * 1000);
  }, [bridge, clearAutoHide, dockLayout, floatingResultSeconds, isProcessing, results]);

  useEffect(() => {
    const width = results.length ? (dockLayout === "full" ? 390 : 320) : dockLayout === "pet" ? Math.max(190, Math.min(390, Math.round(205 * petScale / 100))) : dockLayout === "compact" ? 280 : 340;
    const height = results.length ? (dockLayout === "full" ? 300 : 228) : dockLayout === "pet" ? Math.max(190, Math.min(420, Math.round(220 * petScale / 100))) : dockLayout === "compact" ? 158 : 220;
    void bridge.configureDropzoneWindow(width, height);
  }, [bridge, dockLayout, petScale, results.length]);

  useEffect(() => {
    scheduleAutoHide();
    return clearAutoHide;
  }, [clearAutoHide, scheduleAutoHide]);

  const chooseDockImages = useCallback(async () => {
    clearAutoHide();
    try {
      const images = await bridge.selectImages();
      if (images.length) await runCompression(images.map((image) => image.path));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "选择图片失败");
    }
  }, [bridge, clearAutoHide, runCompression]);

  useEffect(() => bridge.onFileDrop((event) => {
    if (event.type === "error") {
      setResults([{ source: "悬浮压缩坞", keptOriginal: false, error: event.error || "文件拖放监听不可用" }]);
      return;
    }
    setIsDragging(event.type === "over");
    if (event.type === "drop" && event.paths?.length) void runCompression(event.paths);
  }), [bridge, runCompression]);

  useEffect(() => bridge.onWatcherEvent((event) => {
    if (event.type !== "success" || !event.output || !event.file) return;
    const next: QuickCompressResult = {
      source: event.file,
      output: event.output,
      originalBytes: event.originalBytes,
      outputBytes: event.outputBytes,
      keptOriginal: event.originalBytes === event.outputBytes,
    };
    lastPathsRef.current = [event.file];
    setResults([next]);
    setNotice("文件夹监控已完成压缩");
    void saveDockResults([next]);
  }), [bridge, saveDockResults]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyDockTheme = () => {
      document.documentElement.dataset.theme = resolveTheme(dockTheme);
      document.documentElement.style.colorScheme = resolveTheme(dockTheme);
    };
    applyDockTheme();
    document.documentElement.dataset.density = "comfortable";
    media.addEventListener("change", applyDockTheme);
    return () => media.removeEventListener("change", applyDockTheme);
  }, [dockTheme]);

  useEffect(() => {
    const syncPreferences = (event: StorageEvent) => {
      if (event.key !== "piclite.desktopPreferences.v1") return;
      const preferences = loadStoredDesktopPreferences();
      setDockTheme(preferences.dockTheme);
      setDockLayout(preferences.dockLayout);
      setFloatingResultSeconds(preferences.floatingResultSeconds);
      setPetVariant(preferences.petVariant);
      setPetScale(preferences.petScale);
    };
    window.addEventListener("storage", syncPreferences);
    return () => window.removeEventListener("storage", syncPreferences);
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("piclite.compressionSettings.v2");
      const current = saved ? JSON.parse(saved) as Partial<CompressionSettings> : {};
      window.localStorage.setItem("piclite.compressionSettings.v2", JSON.stringify({ ...DEFAULT_SETTINGS, ...current, quality, scale, watermark: { ...DEFAULT_SETTINGS.watermark, ...current.watermark } }));
    } catch { /* 本次悬浮窗仍可继续使用 */ }
  }, [quality, scale]);

  const toggleDockTheme = useCallback(() => {
    const next = resolveTheme(dockTheme) === "dark" ? "light" : "dark";
    setDockTheme(next);
    try {
      const preferences = loadStoredDesktopPreferences();
      window.localStorage.setItem("piclite.desktopPreferences.v1", JSON.stringify({ ...preferences, dockTheme: next }));
    } catch { /* 主题至少对当前窗口立即生效 */ }
  }, [dockTheme]);

  const updatePetPreferences = useCallback((patch: Partial<Pick<DesktopPreferences, "petScale" | "petVariant">>) => {
    const nextScale = patch.petScale === undefined ? petScale : Math.max(60, Math.min(180, Math.round(patch.petScale)));
    const nextVariant = patch.petVariant ?? petVariant;
    setPetScale(nextScale);
    setPetVariant(nextVariant);
    try {
      const preferences = loadStoredDesktopPreferences();
      window.localStorage.setItem("piclite.desktopPreferences.v1", JSON.stringify({ ...preferences, petScale: nextScale, petVariant: nextVariant }));
    } catch { /* 当前桌宠仍会立即更新 */ }
  }, [petScale, petVariant]);

  const triggerPetInteraction = useCallback(() => {
    const interactions: PetInteraction[] = ["jump", "squash", "shake"];
    const messages = ["喵！今天也要轻一点", "别戳啦，我在压图", "这张还能再瘦一点", "摸鱼被发现了喵", "双击我可以选图片", "尺寸小，快乐大！"];
    const next = interactions[petInteractionIndexRef.current % interactions.length];
    petInteractionIndexRef.current += 1;
    if (petInteractionTimerRef.current) window.clearTimeout(petInteractionTimerRef.current);
    if (petBubbleTimerRef.current) window.clearTimeout(petBubbleTimerRef.current);
    setPetMenuOpen(false);
    setPetInteraction(null);
    setPetBubble(messages[Math.floor(Math.random() * messages.length)]);
    window.requestAnimationFrame(() => setPetInteraction(next));
    petInteractionTimerRef.current = window.setTimeout(() => setPetInteraction(null), 760);
    petBubbleTimerRef.current = window.setTimeout(() => setPetBubble(null), 1900);
  }, []);

  const handlePetPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    setPetMenuOpen(false);
    petPointerRef.current = { x: event.clientX, y: event.clientY, moved: false };
  }, []);

  const handlePetPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = petPointerRef.current;
    if (!pointer || pointer.moved || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 5) return;
    pointer.moved = true;
    petPointerRef.current = null;
    setPetMenuOpen(false);
    void bridge.startDragging();
  }, [bridge]);

  const handlePetPointerUp = useCallback(() => {
    const pointer = petPointerRef.current;
    petPointerRef.current = null;
    if (!pointer || pointer.moved) return;
    if (petClickTimerRef.current) window.clearTimeout(petClickTimerRef.current);
    petClickTimerRef.current = window.setTimeout(triggerPetInteraction, 220);
  }, [triggerPetInteraction]);

  const handlePetDoubleClick = useCallback(() => {
    if (petClickTimerRef.current) window.clearTimeout(petClickTimerRef.current);
    petClickTimerRef.current = null;
    setPetMenuOpen(false);
    void chooseDockImages();
  }, [chooseDockImages]);

  const handlePetWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    updatePetPreferences({ petScale: petScale + (event.deltaY < 0 ? 5 : -5) });
  }, [petScale, updatePetPreferences]);

  const togglePetAlwaysOnTop = useCallback(async () => {
    const next = !petAlwaysOnTop;
    try {
      await bridge.setAlwaysOnTop(next);
      setPetAlwaysOnTop(next);
      setPetMenuOpen(false);
    } catch {
      setNotice("置顶设置失败");
    }
  }, [bridge, petAlwaysOnTop]);

  const undoCompression = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    setQuality(previous.quality);
    setScale(previous.scale);
    setResults(previous.results);
    resultSettingsRef.current = { quality: previous.quality, scale: previous.scale };
    setNotice("已撤回到上一次结果");
  }, []);

  const copyLatestResult = useCallback(async () => {
    const result = results.find((candidate) => candidate.output && !candidate.error);
    if (!result?.output) return;
    try {
      await bridge.copyImagePath(result.output);
      setNotice("结果图已复制，可直接粘贴");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "复制失败");
    }
  }, [bridge, results]);

  const startDockDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    void bridge.startDragging();
  }, [bridge]);

  const startDockResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    void bridge.startResizeDragging("SouthEast");
  }, [bridge]);

  const latestOutput = results.find((result) => result.output && !result.error)?.output;

  return (
    <main className={`drop-dock layout-${dockLayout} ${results.length ? "has-results" : "is-idle"} ${isDragging ? "dragging" : ""}`} onPointerEnter={clearAutoHide} onPointerLeave={scheduleAutoHide}>
      <header data-tauri-drag-region onPointerDown={startDockDrag}>
        <span className="dock-brand" data-tauri-drag-region><i data-tauri-drag-region>✦</i><b data-tauri-drag-region>{results.length ? "压缩结果" : "PicLite"}</b></span>
        <span className="dock-actions">
          <button type="button" title={resolveTheme(dockTheme) === "dark" ? "切换浅色" : "切换深色"} onClick={toggleDockTheme}>{resolveTheme(dockTheme) === "dark" ? "☀" : "☾"}</button>
          <button type="button" title="打开主窗口" onClick={() => void bridge.showMainWindow()}>↗</button>
          <button type="button" title="隐藏压缩坞" onClick={() => void bridge.hideCurrentWindow()}>×</button>
        </span>
      </header>
      <section className="dock-body">
        {!results.length ? (
          dockLayout === "pet" ? (
            <div
              className={`pet-stage ${petMenuOpen ? "menu-open" : ""}`}
              style={{ "--pet-scale": petScale / 100 } as CSSProperties}
              title="拖动移动 · 单击互动 · 双击选图 · 滚轮缩放"
              onPointerDown={handlePetPointerDown}
              onPointerMove={handlePetPointerMove}
              onPointerUp={handlePetPointerUp}
              onPointerCancel={() => { petPointerRef.current = null; }}
              onDoubleClick={handlePetDoubleClick}
              onWheel={handlePetWheel}
              onContextMenu={(event) => { event.preventDefault(); petPointerRef.current = null; setPetMenuOpen(true); }}
            >
              {petBubble && <span className="pet-speech" role="status">{petBubble}</span>}
              {isDragging && <span className="pet-drop-hint">松开压缩图片</span>}
              <img className={`piclite-pet interaction-${petInteraction || "idle"}`} src={`/piclite-pet-${petVariant}.png`} alt={petVariant === "green" ? "绿色猫咪桌宠" : "黑色猫咪桌宠"} draggable={false} />
              {petMenuOpen && <div className="pet-context-menu" role="menu" onPointerDown={(event) => event.stopPropagation()}>
                <strong>PicLite 桌宠</strong>
                <div className="pet-variant-buttons"><button className={petVariant === "green" ? "active" : ""} type="button" onClick={() => updatePetPreferences({ petVariant: "green" })}>绿猫</button><button className={petVariant === "black" ? "active" : ""} type="button" onClick={() => updatePetPreferences({ petVariant: "black" })}>黑猫</button></div>
                <div className="pet-size-buttons"><button type="button" aria-label="缩小桌宠" onClick={() => updatePetPreferences({ petScale: petScale - 10 })}>－</button><button type="button" onClick={() => updatePetPreferences({ petScale: 100 })}>{petScale}%</button><button type="button" aria-label="放大桌宠" onClick={() => updatePetPreferences({ petScale: petScale + 10 })}>＋</button></div>
                <button type="button" onClick={() => void togglePetAlwaysOnTop()}>{petAlwaysOnTop ? "✓ 始终置顶" : "○ 始终置顶"}</button>
                <button type="button" onClick={() => void chooseDockImages()}>选择图片压缩</button>
                <button type="button" onClick={() => void bridge.showMainWindow()}>打开主窗口</button>
                <button className="danger" type="button" onClick={() => void bridge.quitApplication()}>退出 PicLite</button>
              </div>}
            </div>
          ) : (
            <button className="dock-empty" type="button" onClick={() => void chooseDockImages()} title="点击选择图片，也可以直接拖入">
              <span className="dock-orbit"><i /><i /><b>＋</b></span>
              <div><strong>{isDragging ? "松开开始压缩" : "点击或拖入图片"}</strong><small>输出到源文件旁 · 不覆盖原图</small></div>
            </button>
          )
        ) : (
          <div className="dock-results">
            {results.slice(0, 2).map((result) => (
              <div className={result.error ? "error" : result.output ? "done" : "working"} key={result.source}>
                {previewUrls[result.source] ? <img src={previewUrls[result.source]} alt="" /> : <span>{result.error ? "!" : result.output ? "✓" : "···"}</span>}
                <p><strong>{fileNameFromPath(result.source)}</strong><small>{result.error || (result.outputBytes ? `${formatBytes(result.originalBytes)} → ${formatBytes(result.outputBytes)}` : "正在压缩…")}</small></p>
                {result.originalBytes && result.outputBytes ? <b>{sizeChangeLabel(result.originalBytes, result.outputBytes)}</b> : null}
              </div>
            ))}
          </div>
        )}
      </section>
      <div className={`dock-controls ${results.length ? "" : "idle-controls"}`}>
        <label htmlFor="dock-quality"><span>画质</span><input id="dock-quality" type="range" min="1" max="100" step="1" value={quality} style={{ "--range-progress": `${quality}%` } as CSSProperties} onChange={(event) => setQuality(Number(event.target.value))} /><b>{quality}%</b></label>
        <label htmlFor="dock-scale"><span>尺寸</span><input id="dock-scale" type="range" min="0.1" max="100" step="0.1" value={scale} style={{ "--range-progress": `${scale}%` } as CSSProperties} onChange={(event) => setScale(Number(event.target.value))} /><b>{formatScale(scale)}</b></label>
      </div>
      <footer>
        <span title={notice}>{notice}</span>
        <span className="dock-footer-actions"><button className="dock-icon-action" type="button" title="撤回上一次" disabled={isProcessing || !historyRef.current.length} onClick={undoCompression}>↶</button><button className="dock-icon-action" type="button" title="在文件夹中显示" disabled={!latestOutput} onClick={() => latestOutput && void bridge.revealPath(latestOutput)}>⌑</button><button className="dock-icon-action" type="button" title="复制压缩文件" disabled={isProcessing || !latestOutput} onClick={() => void copyLatestResult()}>⧉</button><button type="button" disabled={isProcessing || !lastPathsRef.current.length} onClick={() => void runCompression(lastPathsRef.current)}>{isProcessing ? "处理中…" : "重压"}</button></span>
      </footer>
      <button className="dock-resize-handle" type="button" aria-label="调整悬浮窗大小" title="拖动调整大小" onPointerDown={startDockResize}><i /><i /><i /></button>
    </main>
  );
}

export function PicLiteApp() {
  const bridge = typeof window !== "undefined" ? window.picLite : undefined;
  return bridge?.windowLabel === "dropzone" ? <TrayDropDock bridge={bridge} /> : <PicLiteWorkbench nativeBridge={bridge} />;
}

function PicLiteWorkbench({ nativeBridge }: { nativeBridge?: NativeBridge }) {
  const [view, setView] = useState<ViewName>("workspace");
  const [items, setItems] = useState<ImageItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState<CompressionSettings>(loadStoredSettings);
  const [presets, setPresets] = useState<SavedPreset[]>(loadStoredPresets);
  const [activePresetId, setActivePresetId] = useState(() => typeof window === "undefined" ? "current" : window.localStorage.getItem("piclite.activePreset.v1") || "current");
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [pendingTrayAction, setPendingTrayAction] = useState<string | null>(null);
  const [compare, setCompare] = useState(52);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("compare");
  const [previewZoom, setPreviewZoom] = useState(100);
  const [previewFit, setPreviewFit] = useState(true);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [processingAll, setProcessingAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [desktopPreferences, setDesktopPreferences] = useState<DesktopPreferences>(loadStoredDesktopPreferences);
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutPreferenceKey | null>(null);
  const [exportMode, setExportMode] = useState<ExportMode>(() => typeof window !== "undefined" && window.picLite ? loadStoredDesktopPreferences().exportMode : "download");
  const [exportSuffix, setExportSuffix] = useState(() => loadStoredDesktopPreferences().exportSuffix);
  const [exportFolderName, setExportFolderName] = useState(() => loadStoredDesktopPreferences().exportFolder);
  const [localFonts, setLocalFonts] = useState<string[]>(["Microsoft YaHei", "PingFang SC", "Arial", "SimSun"]);
  const [toast, setToast] = useState<string | null>(null);
  const [watcherSettings, setWatcherSettings] = useState<WatcherSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_WATCHER_SETTINGS;
    try {
      const saved = window.localStorage.getItem("piclite.watcherSettings.v1");
      return saved ? { ...DEFAULT_WATCHER_SETTINGS, ...JSON.parse(saved) } : DEFAULT_WATCHER_SETTINGS;
    } catch {
      return DEFAULT_WATCHER_SETTINGS;
    }
  });
  const [watcherActive, setWatcherActive] = useState(false);
  const [watcherEvents, setWatcherEvents] = useState<WatcherEvent[]>([]);
  const [galleryItems, setGalleryItems] = useState<GalleryViewItem[]>([]);
  const [galleryRevision, setGalleryRevision] = useState(0);
  const [uploadSettings, setUploadSettings] = useState<UploadSettings>(loadUploadSettings);
  const [uploadSecret, setUploadSecret] = useState("");
  const [uploadProfileSaved, setUploadProfileSaved] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const exportDirectoryRef = useRef<DirectoryHandleLike | null>(null);
  const compareRef = useRef<HTMLDivElement>(null);
  const previewDragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const itemsRef = useRef<ImageItem[]>([]);
  const settingsReadyRef = useRef(false);
  const desktopPreferencesReadyRef = useRef(false);
  const shortcutRegistrationGenerationRef = useRef(0);
  const importFromClipboardRef = useRef<(() => Promise<void>) | null>(null);
  const livePreviewGenerationRef = useRef(0);
  const galleryUrlsRef = useRef<string[]>([]);
  const savedUploadProfileRef = useRef<string | null>(null);
  const loadedSystemFontsRef = useRef<Set<string>>(new Set());
  const systemFontFilesRef = useRef<Map<string, SystemFontInfo>>(new Map());
  const desktopPlatform = nativeBridge
    ? ({ win32: "Windows", darwin: "macOS", linux: "Linux" }[nativeBridge.platform] || "桌面")
    : "桌面";

  useEffect(() => {
    if (!nativeBridge) return;
    document.documentElement.classList.add("desktop-root");
    return () => document.documentElement.classList.remove("desktop-root");
  }, [nativeBridge]);

  useEffect(() => {
    if (!nativeBridge) return;
    const syncDesktopPreferences = (event: StorageEvent) => {
      if (event.key === "piclite.desktopPreferences.v1") setDesktopPreferences(loadStoredDesktopPreferences());
    };
    window.addEventListener("storage", syncDesktopPreferences);
    return () => window.removeEventListener("storage", syncDesktopPreferences);
  }, [nativeBridge]);

  const selected = useMemo(() => items.find((item) => item.id === selectedId) || items[0] || null, [items, selectedId]);
  const selectedTarget = useMemo(() => selected ? getTargetDimensions(selected, settings) : null, [selected, settings]);
  const totals = useMemo(() => {
    const original = items.reduce((sum, item) => sum + item.originalBytes, 0);
    const output = items.reduce((sum, item) => sum + (item.outputBytes ?? item.originalBytes), 0);
    return { original, output, saved: savedPercent(original, output) };
  }, [items]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const refreshGallery = useCallback(async () => {
    try {
      const records = await galleryList();
      galleryUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      const next = records.map((record) => ({ ...record, previewUrl: URL.createObjectURL(record.blob) }));
      galleryUrlsRef.current = next.map((record) => record.previewUrl);
      setGalleryItems(next);
    } catch {
      showToast("图库读取失败");
    }
  }, [showToast]);

  useEffect(() => {
    if (view === "gallery") void refreshGallery();
  }, [galleryRevision, refreshGallery, view]);

  useEffect(() => () => galleryUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

  useEffect(() => {
    try {
      window.localStorage.setItem("piclite.uploadSettings.v1", JSON.stringify(uploadSettings));
    } catch { /* 非敏感上传配置仅用于本机偏好 */ }
  }, [uploadSettings]);

  useEffect(() => {
    if (!nativeBridge) return;
    void nativeBridge.loadUploadProfile()
      .then((profile) => {
        if (!profile) return;
        const { secret, ...storedSettings } = profile;
        savedUploadProfileRef.current = JSON.stringify({ ...DEFAULT_UPLOAD_SETTINGS, ...storedSettings, secret });
        setUploadSettings({ ...DEFAULT_UPLOAD_SETTINGS, ...storedSettings });
        setUploadSecret(secret);
        setUploadProfileSaved(true);
      })
      .catch(() => showToast("本机上传配置读取失败"));
  }, [nativeBridge, showToast]);

  useEffect(() => {
    if (!savedUploadProfileRef.current) return;
    setUploadProfileSaved(savedUploadProfileRef.current === JSON.stringify({ ...uploadSettings, secret: uploadSecret }));
  }, [uploadSecret, uploadSettings]);

  const saveItemToGallery = useCallback(async (item: ImageItem, blob: Blob, outputPath?: string, remoteUrl?: string) => {
    await galleryPut({
      id: item.id,
      name: outputName(item, cleanSuffix(exportSuffix)),
      createdAt: Date.now(),
      originalBytes: item.originalBytes,
      outputBytes: blob.size,
      width: item.outputWidth || item.width,
      height: item.outputHeight || item.height,
      mimeType: blob.type || item.type,
      blob,
      sourcePath: item.sourcePath,
      outputPath,
      remoteUrl,
    });
    setGalleryRevision((current) => current + 1);
  }, [exportSuffix]);

  const addSources = useCallback(async (sources: ImageSourceInput[]) => {
    const imageSources = sources.filter(({ file }) => file.type.startsWith("image/") || /\.(?:jpe?g|png|webp|avif|gif)$/i.test(file.name));
    if (!imageSources.length) {
      showToast("没有找到可处理的图片");
      return;
    }
    const nextItems = await Promise.all(imageSources.map(async ({ file, fileHandle, sourcePath }): Promise<ImageItem | null> => {
      try {
        const dimensions = await getDimensions(file);
        return { id: uid(), file, name: file.name || `clipboard-${Date.now()}.png`, type: file.type || mimeFromName(file.name), width: dimensions.width, height: dimensions.height, originalBytes: file.size, sourceUrl: URL.createObjectURL(file), status: "ready", fileHandle, sourcePath };
      } catch {
        return null;
      }
    }));
    const validItems = nextItems.filter((item): item is ImageItem => Boolean(item));
    setItems((current) => [...current, ...validItems]);
    if (!selectedId && validItems[0]) setSelectedId(validItems[0].id);
    showToast(`已加入 ${validItems.length} 张图片`);
  }, [selectedId, showToast]);

  const addFiles = useCallback((files: File[]) => addSources(files.map((file) => ({ file }))), [addSources]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!nativeBridge) return;
    setExportMode(desktopPreferences.exportMode);
    setExportSuffix(desktopPreferences.exportSuffix);
    setExportFolderName(desktopPreferences.exportFolder);
    setSettings((current) => ({ ...current, preventLarger: desktopPreferences.preventLarger }));
    desktopPreferencesReadyRef.current = true;
    // 桌面偏好已经通过 useState 同步初始化，这里只建立原生窗口状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeBridge]);

  useEffect(() => {
    if (!nativeBridge) return;
    void isAutostartEnabled()
      .then((enabled) => setDesktopPreferences((current) => current.launchAtStartup === enabled ? current : { ...current, launchAtStartup: enabled }))
      .catch(() => showToast("无法读取系统开机启动状态"));
  }, [nativeBridge, showToast]);

  useEffect(() => {
    if (!nativeBridge || !desktopPreferencesReadyRef.current) return;
    window.localStorage.setItem("piclite.desktopPreferences.v1", JSON.stringify(desktopPreferences));
    setExportMode(desktopPreferences.exportMode);
    setExportSuffix(desktopPreferences.exportSuffix);
    setExportFolderName(desktopPreferences.exportFolder);
    setSettings((current) => current.preventLarger === desktopPreferences.preventLarger ? current : { ...current, preventLarger: desktopPreferences.preventLarger });
  }, [desktopPreferences, nativeBridge]);

  useEffect(() => {
    if (!nativeBridge || !desktopPreferencesReadyRef.current) return;
    void nativeBridge.updateDesktopPreferences({
      minimizeToTray: desktopPreferences.minimizeToTray,
    });
  }, [desktopPreferences.minimizeToTray, nativeBridge]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyAppearance = () => {
      const resolvedTheme = desktopPreferences.theme === "system"
        ? (media.matches ? "dark" : "light")
        : desktopPreferences.theme;
      const resolvedDensity = desktopPreferences.density === "auto"
        ? (window.innerWidth <= 860 || window.innerHeight <= 540 ? "compact" : "comfortable")
        : desktopPreferences.density;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.dataset.density = resolvedDensity;
      document.documentElement.style.colorScheme = resolvedTheme;
      if (nativeBridge) void nativeBridge.setWindowTheme(desktopPreferences.theme).catch(() => showToast("系统主题同步失败，已保留应用内主题"));
    };
    applyAppearance();
    media.addEventListener("change", applyAppearance);
    window.addEventListener("resize", applyAppearance);
    return () => {
      media.removeEventListener("change", applyAppearance);
      window.removeEventListener("resize", applyAppearance);
    };
  }, [desktopPreferences.density, desktopPreferences.theme, nativeBridge, showToast]);

  useEffect(() => {
    window.localStorage.setItem("piclite.customPresets.v1", JSON.stringify(presets.filter((preset) => preset.custom)));
  }, [presets]);

  useEffect(() => {
    const active = presets.find((preset) => preset.id === activePresetId);
    if (!active || JSON.stringify(active.settings) !== JSON.stringify(settings)) {
      if (activePresetId !== "current") setActivePresetId("current");
    }
    window.localStorage.setItem("piclite.activePreset.v1", activePresetId);
  }, [activePresetId, presets, settings]);

  useEffect(() => {
    window.localStorage.setItem("piclite.watcherSettings.v1", JSON.stringify(watcherSettings));
  }, [watcherSettings]);

  useEffect(() => {
    setPreviewPan({ x: 0, y: 0 });
    setPreviewZoom(100);
    setPreviewFit(true);
  }, [selectedId, previewMode]);

  useEffect(() => () => {
    itemsRef.current.forEach((item) => {
      URL.revokeObjectURL(item.sourceUrl);
      if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
    });
  }, []);

  useEffect(() => {
    if (!settingsReadyRef.current) {
      settingsReadyRef.current = true;
      window.localStorage.setItem("piclite.compressionSettings.v2", JSON.stringify(settings));
      return;
    }
    window.localStorage.setItem("piclite.compressionSettings.v2", JSON.stringify(settings));
    setItems((current) => current.map((item) => {
      if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
      return { ...item, outputUrl: undefined, outputBlob: undefined, outputBytes: undefined, outputType: undefined, outputWidth: undefined, outputHeight: undefined, keptOriginal: undefined, sizeGuardQuality: undefined, status: "ready", error: undefined };
    }));
  }, [settings]);

  useEffect(() => {
    if (!nativeBridge) return;
    return nativeBridge.onFileDrop((event) => {
      if (event.type === "error") {
        showToast(event.error || "系统文件拖放监听不可用");
        return;
      }
      setDragging(event.type === "over");
      if (event.type !== "drop" || !event.paths?.length) return;
      void nativeBridge.readImagesFromPaths(event.paths).then((nativeImages) => addSources(nativeImages.map((image) => ({
        file: new File([new Uint8Array(image.data)], image.name, { type: image.type || mimeFromName(image.name) }),
        sourcePath: image.path,
      }))));
    });
  }, [addSources, nativeBridge, showToast]);

  useEffect(() => nativeBridge?.onTrayAction(setPendingTrayAction), [nativeBridge]);

  useEffect(() => {
    const id = selectedId || itemsRef.current[0]?.id;
    if (!id) return;
    const generation = ++livePreviewGenerationRef.current;
    const timer = window.setTimeout(async () => {
      const item = itemsRef.current.find((candidate) => candidate.id === id);
      if (!item) return;
      setItems((current) => current.map((candidate) => candidate.id === id ? { ...candidate, status: "processing", error: undefined } : candidate));
      try {
        const result = await compressImage(item, settings);
        if (generation !== livePreviewGenerationRef.current) return;
        const outputUrl = URL.createObjectURL(result.blob);
        setItems((current) => current.map((candidate) => {
          if (candidate.id !== id) return candidate;
          if (candidate.outputUrl) URL.revokeObjectURL(candidate.outputUrl);
          return {
            ...candidate,
            outputBlob: result.blob,
            outputUrl,
            outputBytes: result.blob.size,
            outputType: result.blob.type || candidate.type,
            outputWidth: result.width,
            outputHeight: result.height,
            keptOriginal: result.keptOriginal,
            sizeGuardQuality: result.sizeGuardQuality,
            status: "done",
          };
        }));
      } catch (error) {
        if (generation !== livePreviewGenerationRef.current) return;
        setItems((current) => current.map((candidate) => candidate.id === id ? { ...candidate, status: "error", error: error instanceof Error ? error.message : "预览失败" } : candidate));
      }
    }, itemsRef.current.find((item) => item.id === id)?.type === "image/gif" ? 420 : 220);

    return () => {
      window.clearTimeout(timer);
      if (livePreviewGenerationRef.current === generation) livePreviewGenerationRef.current += 1;
    };
  }, [selectedId, settings]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files || []);
      if (files.some((file) => file.type.startsWith("image/"))) {
        event.preventDefault();
        void addFiles(files);
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [addFiles]);

  useEffect(() => {
    if (!nativeBridge) return;
    void nativeBridge.getWatcherState().then((state) => {
      setWatcherActive(state.active);
      if (state.settings) setWatcherSettings({ ...DEFAULT_WATCHER_SETTINGS, ...state.settings });
    });
    return nativeBridge.onWatcherEvent((event) => {
      setWatcherEvents((current) => [event, ...current].slice(0, 30));
      if (event.type === "started") setWatcherActive(true);
      if (event.type === "stopped") setWatcherActive(false);
      if (event.type === "success" && event.output) {
        void nativeBridge.readImagesFromPaths([event.output]).then(async ([image]) => {
          if (!image) return;
          const blob = new Blob([new Uint8Array(image.data)], { type: image.type || mimeFromName(image.name) });
          const dimensions = await getDimensions(new File([blob], image.name, { type: blob.type }));
          await galleryPut({
            id: `watcher:${event.output}`,
            name: image.name,
            createdAt: event.time,
            originalBytes: event.originalBytes || blob.size,
            outputBytes: event.outputBytes || blob.size,
            width: dimensions.width,
            height: dimensions.height,
            mimeType: blob.type,
            blob,
            outputPath: event.output,
          });
          setGalleryRevision((current) => current + 1);
        }).catch(() => undefined);
      }
    });
  }, [nativeBridge]);

  const processOne = useCallback(async (id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    setItems((current) => current.map((candidate) => candidate.id === id ? { ...candidate, status: "processing", error: undefined } : candidate));
    try {
      const result = await compressImage(item, settings);
      const outputUrl = URL.createObjectURL(result.blob);
      const completed: ImageItem = { ...item, outputBlob: result.blob, outputUrl, outputBytes: result.blob.size, outputType: result.blob.type || item.type, outputWidth: result.width, outputHeight: result.height, keptOriginal: result.keptOriginal, sizeGuardQuality: result.sizeGuardQuality, status: "done" };
      setItems((current) => current.map((candidate) => {
        if (candidate.id !== id) return candidate;
        if (candidate.outputUrl) URL.revokeObjectURL(candidate.outputUrl);
        return { ...completed, fileHandle: candidate.fileHandle, sourcePath: candidate.sourcePath };
      }));
      await saveItemToGallery(completed, result.blob);
    } catch (error) {
      setItems((current) => current.map((candidate) => candidate.id === id ? { ...candidate, status: "error", error: error instanceof Error ? error.message : "压缩失败" } : candidate));
    }
  }, [saveItemToGallery, settings]);

  const processAll = useCallback(async () => {
    if (!items.length) return;
    livePreviewGenerationRef.current += 1;
    setProcessingAll(true);
    for (const item of items) await processOne(item.id);
    setProcessingAll(false);
    showToast("全部图片已处理完成");
  }, [items, processOne, showToast]);

  const downloadItem = useCallback((item: ImageItem, blob = item.outputBlob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = outputName(item, cleanSuffix(exportSuffix));
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  }, [exportSuffix]);

  const copyBlobToClipboard = useCallback(async (blob: Blob, fileName: string) => {
    if (nativeBridge) {
      await nativeBridge.copyCompressedData(new Uint8Array(await blob.arrayBuffer()), fileName);
      return;
    }
    const clipboardItem = ClipboardItem as unknown as { new(items: Record<string, Blob>): ClipboardItem; supports?: (type: string) => boolean };
    if (clipboardItem.supports?.(blob.type)) {
      await navigator.clipboard.write([new clipboardItem({ [blob.type]: blob })]);
      return;
    }
    const clipboardBlob = blob.type === "image/png" ? blob : await (async () => {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建剪贴板图片");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!png) throw new Error("无法转换剪贴板图片");
      return png;
    })();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardBlob })]);
  }, [nativeBridge]);

  const copySelectedResult = useCallback(async () => {
    if (!selected) return;
    try {
      const blob = selected.outputBlob || selected.file;
      await copyBlobToClipboard(blob, outputName(selected, cleanSuffix(exportSuffix)));
      await saveItemToGallery(selected, blob);
      showToast(nativeBridge ? `已复制压缩文件 · ${formatBytes(blob.size)}` : "结果图已复制，可直接粘贴到其他软件");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "复制结果图失败");
    }
  }, [copyBlobToClipboard, exportSuffix, nativeBridge, saveItemToGallery, selected, showToast]);

  const copyGalleryResult = useCallback(async (record: GalleryRecord) => {
    try {
      await copyBlobToClipboard(record.blob, record.name);
      showToast(nativeBridge ? `已复制压缩文件 · ${formatBytes(record.blob.size)}` : "图库图片已复制");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "复制失败");
    }
  }, [copyBlobToClipboard, nativeBridge, showToast]);

  const downloadGalleryResult = useCallback((record: GalleryRecord) => {
    const url = URL.createObjectURL(record.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = record.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  }, []);

  const uploadGalleryResult = useCallback(async (record: GalleryRecord) => {
    if (!nativeBridge) {
      showToast("云端上传只在桌面客户端提供");
      return;
    }
    if (!uploadSettings.endpoint.trim()) {
      showToast("请先在应用设置中填写上传服务地址");
      setView("preferences");
      return;
    }
    setUploadingId(record.id);
    try {
      const result = await nativeBridge.uploadImage({
        ...uploadSettings,
        secret: uploadSecret,
        fileName: record.name,
        mimeType: record.mimeType,
        data: new Uint8Array(await record.blob.arrayBuffer()),
      });
      await galleryPut({ ...record, remoteUrl: result.url });
      setGalleryRevision((current) => current + 1);
      await navigator.clipboard.writeText(result.url).catch(() => undefined);
      showToast("上传完成，图片链接已复制");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploadingId(null);
    }
  }, [nativeBridge, showToast, uploadSecret, uploadSettings]);

  const saveUploadProfile = useCallback(async () => {
    if (!nativeBridge) {
      showToast("图床上传配置只在桌面客户端保存");
      return;
    }
    if (!uploadSettings.endpoint.trim()) {
      showToast("请先填写服务地址");
      return;
    }
    try {
      await nativeBridge.saveUploadProfile({ ...uploadSettings, secret: uploadSecret });
      savedUploadProfileRef.current = JSON.stringify({ ...uploadSettings, secret: uploadSecret });
      setUploadProfileSaved(true);
      showToast("图床配置与凭证已保存到本机");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "图床配置保存失败");
    }
  }, [nativeBridge, showToast, uploadSecret, uploadSettings]);

  const uploadSelectedResult = useCallback(async () => {
    if (!selected?.outputBlob) return;
    const record: GalleryRecord = {
      id: selected.id,
      name: outputName(selected, cleanSuffix(exportSuffix)),
      createdAt: Date.now(),
      originalBytes: selected.originalBytes,
      outputBytes: selected.outputBlob.size,
      width: selected.outputWidth || selected.width,
      height: selected.outputHeight || selected.height,
      mimeType: selected.outputBlob.type || selected.type,
      blob: selected.outputBlob,
      sourcePath: selected.sourcePath,
    };
    await galleryPut(record);
    setGalleryRevision((current) => current + 1);
    await uploadGalleryResult(record);
  }, [exportSuffix, selected, uploadGalleryResult]);

  const copyRemoteUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      showToast("图片链接已复制");
    } catch {
      showToast("链接复制失败，请手动复制");
    }
  }, [showToast]);

  const deleteGalleryResult = useCallback(async (id: string) => {
    await galleryDelete(id);
    setGalleryRevision((current) => current + 1);
    showToast("已从图库记录中移除，不会删除本地文件");
  }, [showToast]);

  const prepareAllForExport = useCallback(async () => {
    const prepared: Array<{ item: ImageItem; blob: Blob }> = [];
    for (const item of itemsRef.current) {
      if (item.outputBlob) {
        prepared.push({ item, blob: item.outputBlob });
        continue;
      }
      setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: "processing", error: undefined } : candidate));
      const result = await compressImage(item, settings);
      const outputUrl = URL.createObjectURL(result.blob);
      const completed = { ...item, outputBlob: result.blob, outputUrl, outputBytes: result.blob.size, outputType: result.blob.type || item.type, outputWidth: result.width, outputHeight: result.height, keptOriginal: result.keptOriginal, sizeGuardQuality: result.sizeGuardQuality, status: "done" as const };
      setItems((current) => current.map((candidate) => {
        if (candidate.id !== item.id) return candidate;
        if (candidate.outputUrl) URL.revokeObjectURL(candidate.outputUrl);
        return completed;
      }));
      prepared.push({ item: completed, blob: result.blob });
    }
    return prepared;
  }, [settings]);

  const chooseExportFolder = useCallback(async () => {
    try {
      if (nativeBridge) {
        const folder = await nativeBridge.selectFolder("export");
        if (!folder) return false;
        setExportFolderName(folder);
        setDesktopPreferences((current) => ({ ...current, exportFolder: folder }));
        return true;
      }
      if (!window.showDirectoryPicker) {
        showToast("当前浏览器不支持文件夹写入，请使用 Chrome、Edge 或下载模式");
        return false;
      }
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      exportDirectoryRef.current = handle;
      setExportFolderName(handle.name);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
      showToast("没有获得文件夹写入权限");
      return false;
    }
  }, [nativeBridge, showToast]);

  const exportAll = useCallback(async () => {
    if (!itemsRef.current.length || exporting) return;
    if (exportMode === "overwrite" && settings.format !== "keep") {
      showToast("覆盖源文件时请将输出格式设为“保持原格式”");
      return;
    }
    if (exportMode === "overwrite" && (!nativeBridge || desktopPreferences.confirmOverwrite) && !window.confirm("确认覆盖源图片？该操作无法在 PicLite 中撤销。")) return;

    setExporting(true);
    try {
      if (!nativeBridge && exportMode === "overwrite") {
        const handles = itemsRef.current.map((item) => item.fileHandle);
        if (handles.some((handle) => !handle)) throw new Error("覆盖需要通过“添加图片”重新选择源文件并授权写入");
        for (const handle of handles) {
          if (handle?.requestPermission && await handle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("没有获得源文件写入权限");
        }
      }
      if (!nativeBridge && (exportMode === "same-folder" || exportMode === "fixed-folder") && !exportDirectoryRef.current && !(await chooseExportFolder())) return;
      if (nativeBridge && exportMode === "fixed-folder" && !exportFolderName && !(await chooseExportFolder())) return;

      const prepared = await prepareAllForExport();
      const suffix = cleanSuffix(exportSuffix);
      if (exportMode === "download") {
        prepared.forEach(({ item, blob }, index) => window.setTimeout(() => downloadItem(item, blob), index * 160));
        showToast(`正在下载 ${prepared.length} 张图片`);
        return;
      }

      if (nativeBridge) {
        if ((exportMode === "overwrite" || exportMode === "same-folder") && prepared.some(({ item }) => !item.sourcePath)) {
          throw new Error("有图片不是通过“添加图片”导入，无法定位源文件夹");
        }
        const payloadItems: NativeExportItem[] = [];
        for (const { item, blob } of prepared) {
          payloadItems.push({ sourcePath: item.sourcePath, outputName: outputName(item, suffix), data: new Uint8Array(await blob.arrayBuffer()) });
        }
        const result = await nativeBridge.exportImages({ mode: exportMode, suffix, fixedFolder: exportFolderName || undefined, items: payloadItems });
        if (!result.ok) throw new Error(result.error || "导出失败");
        for (let index = 0; index < prepared.length; index += 1) {
          const { item, blob } = prepared[index];
          await saveItemToGallery(item, blob, result.paths?.[index]);
        }
        showToast(`已写入 ${result.paths?.length || prepared.length} 个文件`);
        return;
      }

      if (exportMode === "overwrite") {
        if (prepared.some(({ item }) => !item.fileHandle)) throw new Error("覆盖需要通过“添加图片”重新选择源文件并授权写入");
        for (const { item, blob } of prepared) {
          const writable = await item.fileHandle!.createWritable();
          await writable.write(blob);
          await writable.close();
        }
      } else {
        const directory = exportDirectoryRef.current;
        if (!directory) throw new Error("请选择输出文件夹");
        for (const { item, blob } of prepared) {
          const handle = await directory.getFileHandle(outputName(item, suffix), { create: true });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        }
      }
      showToast(`已写入 ${prepared.length} 个文件`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }, [chooseExportFolder, desktopPreferences.confirmOverwrite, downloadItem, exportFolderName, exportMode, exportSuffix, exporting, nativeBridge, prepareAllForExport, saveItemToGallery, settings.format, showToast]);

  const removeItem = useCallback((id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    if (item) {
      URL.revokeObjectURL(item.sourceUrl);
      if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
    }
    const remaining = items.filter((candidate) => candidate.id !== id);
    setItems(remaining);
    if (selectedId === id) setSelectedId(remaining[0]?.id || null);
  }, [items, selectedId]);

  const clearAll = useCallback(() => {
    items.forEach((item) => {
      URL.revokeObjectURL(item.sourceUrl);
      if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
    });
    setItems([]);
    setSelectedId(null);
  }, [items]);

  const importFromClipboard = useCallback(async () => {
    try {
      if (nativeBridge) {
        const nativeImage = await nativeBridge.readClipboardImage();
        if (nativeImage) {
          await addFiles([new File([new Uint8Array(nativeImage.data)], `clipboard-${Date.now()}.png`, { type: "image/png" })]);
          return;
        }
      }
      const clipboardItems = await navigator.clipboard.read();
      const files: File[] = [];
      for (const clipboardItem of clipboardItems) {
        const type = clipboardItem.types.find((candidate) => candidate.startsWith("image/"));
        if (!type) continue;
        const blob = await clipboardItem.getType(type);
        files.push(new File([blob], `clipboard-${Date.now()}.${type.split("/")[1]}`, { type }));
      }
      await addFiles(files);
    } catch {
      showToast("请直接按 Ctrl + V 粘贴剪贴板图片");
    }
  }, [addFiles, nativeBridge, showToast]);

  useEffect(() => {
    importFromClipboardRef.current = importFromClipboard;
  }, [importFromClipboard]);

  const toggleAutostart = useCallback(async () => {
    if (!nativeBridge) return;
    const next = !desktopPreferences.launchAtStartup;
    try {
      if (next) await enableAutostart();
      else await disableAutostart();
      setDesktopPreferences((current) => ({ ...current, launchAtStartup: next }));
      showToast(next ? "已开启开机自启动，将静默进入系统托盘" : "已关闭开机自启动");
    } catch {
      showToast("开机自启动设置失败，请检查系统权限");
    }
  }, [desktopPreferences.launchAtStartup, nativeBridge, showToast]);

  const captureShortcut = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, preference: ShortcutPreferenceKey) => {
    event.preventDefault();
    event.stopPropagation();
    const shortcut = shortcutFromKeyboardEvent(event);
    if (shortcut === null) return;
    if (shortcut === "escape") {
      setRecordingShortcut(null);
      return;
    }
    setDesktopPreferences((current) => ({ ...current, [preference]: shortcut }));
    setRecordingShortcut(null);
    showToast(shortcut ? "快捷键已更新" : "快捷键已清除");
  }, [showToast]);

  useEffect(() => {
    if (!nativeBridge || !desktopPreferences.shortcutsEnabled) return;
    const generation = ++shortcutRegistrationGenerationRef.current;
    const shortcuts = [
      { value: desktopPreferences.shortcutShow, action: () => void nativeBridge.showMainWindow() },
      { value: desktopPreferences.shortcutPaste, action: () => { void nativeBridge.showMainWindow(); setView("workspace"); void importFromClipboardRef.current?.(); } },
      { value: desktopPreferences.shortcutDock, action: () => void nativeBridge.showDropzoneWindow() },
    ].filter((entry, index, entries) => entry.value && entries.findIndex((candidate) => candidate.value === entry.value) === index);

    void (async () => {
      try {
        await unregisterAllGlobalShortcuts();
        if (generation !== shortcutRegistrationGenerationRef.current) return;
        for (const shortcut of shortcuts) {
          await registerGlobalShortcut(shortcut.value, (event) => {
            if (event.state === "Pressed") shortcut.action();
          });
          if (generation !== shortcutRegistrationGenerationRef.current) return;
        }
      } catch {
        if (generation === shortcutRegistrationGenerationRef.current) showToast("部分全局快捷键被其他软件占用，请重新设置");
      }
    })();

    return () => {
      if (shortcutRegistrationGenerationRef.current === generation) shortcutRegistrationGenerationRef.current += 1;
      void unregisterAllGlobalShortcuts();
    };
  }, [desktopPreferences.shortcutDock, desktopPreferences.shortcutPaste, desktopPreferences.shortcutShow, desktopPreferences.shortcutsEnabled, nativeBridge, showToast]);

  const importImages = useCallback(async () => {
    try {
      if (nativeBridge) {
        const nativeImages = await nativeBridge.selectImages();
        await addSources(nativeImages.map((image) => ({
          file: new File([new Uint8Array(image.data)], image.name, { type: image.type || mimeFromName(image.name) }),
          sourcePath: image.path,
        })));
        return;
      }
      if (window.showOpenFilePicker) {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: "图片", accept: { "image/*": [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"] } }],
        });
        const sources = await Promise.all(handles.map(async (fileHandle) => ({ file: await fileHandle.getFile(), fileHandle })));
        await addSources(sources);
        return;
      }
      fileInputRef.current?.click();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      fileInputRef.current?.click();
    }
  }, [addSources, nativeBridge]);

  const loadSystemFonts = useCallback(async () => {
    try {
      let families: string[] = [];
      if (nativeBridge) {
        const fonts = await nativeBridge.listSystemFonts();
        systemFontFilesRef.current = new Map(fonts.map((font) => [font.family, font]));
        families = fonts.map((font) => font.family);
      } else if (window.queryLocalFonts) {
        families = Array.from(new Set((await window.queryLocalFonts()).map((font) => font.family).filter(Boolean))).sort((left, right) => left.localeCompare(right));
      }
      if (!families.length) {
        showToast(nativeBridge ? "没有在系统字体目录中找到可用字体" : "当前浏览器不支持读取系统字体，可直接导入字体文件");
        return;
      }
      setLocalFonts((current) => Array.from(new Set([...current, ...families])));
      showToast(`已读取 ${families.length} 个本地字体`);
    } catch {
      showToast("没有获得本地字体读取权限");
    }
  }, [nativeBridge, showToast]);

  const selectSystemFont = useCallback(async (family: string) => {
    try {
      if (!loadedSystemFontsRef.current.has(family)) {
        const systemFont = systemFontFilesRef.current.get(family);
        const localName = family.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        const source = nativeBridge && systemFont
          ? (await nativeBridge.readSystemFont(systemFont.path, systemFont.faceIndex)).data
          : `local("${localName}")`;
        const face = new FontFace(family, source);
        await face.load();
        document.fonts.add(face);
        await document.fonts.load(`16px "${localName}"`, "PicLite 图轻 123");
        await document.fonts.ready;
        loadedSystemFontsRef.current.add(family);
      }
      setSettings((current) => ({ ...current, watermark: { ...current.watermark, fontFamily: family } }));
      showToast(`水印字体已切换为：${family}`);
    } catch {
      setSettings((current) => ({ ...current, watermark: { ...current.watermark, fontFamily: family } }));
      showToast(`系统字体 ${family} 无法载入，请尝试导入对应字体文件`);
    }
  }, [nativeBridge, showToast]);

  const onFontSelected = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const family = `PicLite ${file.name.replace(/\.[^.]+$/, "")}`;
      const font = new FontFace(family, await file.arrayBuffer());
      await font.load();
      document.fonts.add(font);
      loadedSystemFontsRef.current.add(family);
      setLocalFonts((current) => Array.from(new Set([...current, family])));
      setSettings((current) => ({ ...current, watermark: { ...current.watermark, fontFamily: family } }));
      showToast(`已载入字体：${file.name}`);
    } catch {
      showToast("字体文件无法读取，请使用 TTF、OTF、WOFF 或 WOFF2");
    }
  }, [showToast]);

  const handleComparePointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const box = compareRef.current?.getBoundingClientRect();
    if (!box) return;
    setCompare(Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)));
  }, []);

  const setZoom = useCallback((next: number) => {
    setPreviewFit(false);
    setPreviewZoom(Math.max(10, Math.min(800, Math.round(next))));
  }, []);

  const startPreviewPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!selected || target.closest("button, input, select, a, .compare-handle")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    previewDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: previewPan.x, panY: previewPan.y };
  }, [previewPan, selected]);

  const movePreviewPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = previewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPreviewPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y });
  }, []);

  const stopPreviewPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (previewDragRef.current?.pointerId === event.pointerId) previewDragRef.current = null;
  }, []);

  const zoomPreviewWithWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!selected) return;
    event.preventDefault();
    setZoom(previewZoom * (event.deltaY > 0 ? 0.9 : 1.1));
  }, [previewZoom, selected, setZoom]);

  const chooseFolder = useCallback(async (kind: "input" | "output") => {
    if (!nativeBridge) return;
    const folder = await nativeBridge.selectFolder(kind);
    if (!folder) return;
    setWatcherSettings((current) => ({ ...current, [kind === "input" ? "inputFolder" : "outputFolder"]: folder }));
  }, [nativeBridge]);

  const applyPreset = useCallback((preset: SavedPreset) => {
    setSettings({ ...preset.settings, watermark: { ...preset.settings.watermark } });
    setActivePresetId(preset.id);
    showToast(`已应用预设：${preset.name}`);
  }, [showToast]);

  const saveCustomPreset = useCallback(() => {
    const name = presetName.trim();
    if (!name) return;
    const preset: SavedPreset = {
      id: `custom-${uid()}`,
      name,
      custom: true,
      settings: { ...settings, watermark: { ...settings.watermark } },
    };
    setPresets((current) => [...current, preset]);
    setActivePresetId(preset.id);
    setPresetName("");
    setPresetDialogOpen(false);
    showToast(`已保存预设：${name}`);
  }, [presetName, settings, showToast]);

  const deleteActivePreset = useCallback(() => {
    const preset = presets.find((candidate) => candidate.id === activePresetId);
    if (!preset?.custom) return;
    setPresets((current) => current.filter((candidate) => candidate.id !== preset.id));
    setActivePresetId("lossless");
    showToast(`已删除预设：${preset.name}`);
  }, [activePresetId, presets, showToast]);

  const toggleWatcher = useCallback(async () => {
    if (!nativeBridge) return;
    if (watcherActive) {
      await nativeBridge.stopWatcher();
      return;
    }
    if (!watcherSettings.inputFolder) {
      showToast("请先选择要监测的文件夹");
      return;
    }
    const result = await nativeBridge.startWatcher(watcherSettings);
    if (!result.ok) showToast(result.error || "无法启动文件夹监测");
  }, [nativeBridge, showToast, watcherActive, watcherSettings]);

  useEffect(() => {
    if (!pendingTrayAction) return;
    const action = pendingTrayAction;
    setPendingTrayAction(null);
    if (action === "preferences") {
      setView("preferences");
      return;
    }
    if (action === "watcher_settings") {
      setView("watcher");
      return;
    }
    if (action.startsWith("theme_")) {
      const theme = action.replace("theme_", "") as ThemeMode;
      setDesktopPreferences((current) => ({ ...current, theme }));
      return;
    }
    if (action.startsWith("density_")) {
      const density = action.replace("density_", "") as UiDensity;
      setDesktopPreferences((current) => ({ ...current, density }));
      return;
    }
    if (action === "toggle_minimize_to_tray") {
      setDesktopPreferences((current) => ({ ...current, minimizeToTray: !current.minimizeToTray }));
      return;
    }
    const presetId = action.startsWith("preset_") ? action.replace("preset_", "") : "";
    if (presetId === "last") {
      showToast("已保留上次使用的压缩参数");
      return;
    }
    const preset = presets.find((candidate) => candidate.id === presetId);
    if (preset) applyPreset(preset);
  }, [applyPreset, pendingTrayAction, presets, showToast]);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  }, [addFiles]);

  const onFilesSelected = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    void addFiles(Array.from(event.target.files || []));
    event.target.value = "";
  }, [addFiles]);

  const addDemo = useCallback(async () => addFiles([await createDemoFile()]), [addFiles]);

  return (
    <main
      className={`app-shell ${nativeBridge ? "desktop-app" : "web-app"}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={onDrop}
    >
      <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/*" multiple onChange={onFilesSelected} />
      <input ref={fontInputRef} className="visually-hidden" type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" onChange={onFontSelected} />

      <header className="topbar">
        <button className="brand" type="button" onClick={() => setView("workspace")}>
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>PicLite</strong><small>图轻</small></span>
        </button>
        <nav className="main-nav" aria-label="主要功能">
          <button className={view === "workspace" ? "active" : ""} type="button" onClick={() => setView("workspace")}>{nativeBridge ? "工作台" : "压缩工作台"}</button>
          <button className={view === "watcher" ? "active" : ""} type="button" onClick={() => setView("watcher")}>文件夹监测{watcherActive && <span className="live-dot" aria-label="监测中" />}</button>
          <button className={view === "gallery" ? "active" : ""} type="button" onClick={() => setView("gallery")}>图库</button>
          {nativeBridge && <button className={view === "preferences" ? "active" : ""} type="button" onClick={() => setView("preferences")}>应用设置</button>}
        </nav>
        <div className="topbar-actions">
          <span className="privacy-badge"><i /> {nativeBridge ? `${desktopPlatform} · Tauri` : "本地处理，图片不上传"}</span>
          <IconButton label="帮助" symbol="?" onClick={() => showToast("支持 JPG、PNG、WebP、动态 GIF；可拖入或按 Ctrl + V")} />
        </div>
      </header>

      {view === "workspace" ? (
        <section className="workspace" aria-label="图片压缩工作台">
          <aside className="queue-panel">
            <div className="panel-heading">
              <div><span className="eyebrow">任务队列</span><strong>{items.length ? `${items.length} 张图片` : "等待导入"}</strong></div>
              {items.length > 0 && <button className="text-button" type="button" onClick={clearAll}>清空</button>}
            </div>

            <button className="import-button" type="button" onClick={importImages}><span aria-hidden="true">＋</span> 添加图片</button>

            <div className="queue-list">
              {items.length === 0 ? (
                <div className="queue-empty">
                  <div className="empty-stack" aria-hidden="true"><i /><i /><i /></div>
                  <strong>队列还是空的</strong>
                  <p>拖入图片，或从剪贴板粘贴</p>
                  <button type="button" onClick={addDemo}>载入演示图片</button>
                </div>
              ) : items.map((item) => (
                <button className={`queue-item ${selected?.id === item.id ? "selected" : ""}`} type="button" key={item.id} onClick={() => setSelectedId(item.id)}>
                  <img src={item.sourceUrl} alt="" />
                  <span className="queue-copy">
                    <strong>{item.name}</strong>
                    <small>{item.width} × {item.height} · {formatBytes(item.originalBytes)}</small>
                    <span className={`item-status ${item.status}`}>
                      {item.status === "processing" && "正在实时试压…"}
                      {item.status === "ready" && "等待实时试压"}
                      {item.status === "error" && (item.error || "处理失败")}
                      {item.status === "done" && <><b className={savedPercent(item.originalBytes, item.outputBytes) < 0 ? "larger" : ""}>{sizeChangeLabel(item.originalBytes, item.outputBytes)}</b> {item.keptOriginal ? "已保留原图" : formatBytes(item.outputBytes)}</>}
                    </span>
                  </span>
                  <span className="remove-item" role="button" aria-label={`移除 ${item.name}`} onClick={(event) => { event.stopPropagation(); removeItem(item.id); }}>×</span>
                </button>
              ))}
            </div>

            <div className="queue-footer">
              <button className="paste-button" type="button" onClick={importFromClipboard}><span>⌘</span> 从剪贴板粘贴</button>
              <small>也可随时按 Ctrl + V</small>
            </div>
          </aside>

          <section className="preview-panel">
            <div className="preview-toolbar">
              <div><span className="eyebrow">画质对比</span><strong>{selected?.name || "导入一张图片开始"}</strong></div>
              {selected && <>
                <div className="preview-mode-tabs" aria-label="预览方式">
                  <button className={previewMode === "compare" ? "active" : ""} type="button" onClick={() => setPreviewMode("compare")}>对比</button>
                  <button className={previewMode === "original" ? "active" : ""} type="button" onClick={() => setPreviewMode("original")}>原图</button>
                  <button className={previewMode === "result" ? "active" : ""} type="button" onClick={() => setPreviewMode("result")}>结果</button>
                </div>
                <div className="preview-tools">
                  <button type="button" aria-label="缩小预览" onClick={() => setZoom(previewZoom / 1.25)}>−</button>
                  <button className="zoom-readout" type="button" aria-label="切换 1:1 实际像素" title="按实际像素查看" onClick={() => { setPreviewFit(false); setPreviewZoom(100); setPreviewPan({ x: 0, y: 0 }); }}>{previewFit ? "适应" : `${previewZoom}%`}</button>
                  <button type="button" aria-label="放大预览" onClick={() => setZoom(previewZoom * 1.25)}>＋</button>
                  <button className="fit-button" type="button" onClick={() => { setPreviewFit(true); setPreviewZoom(100); setPreviewPan({ x: 0, y: 0 }); }}>适应</button>
                  <button className="copy-result-button" type="button" disabled={!selected.outputBlob} title="复制结果图" aria-label="复制结果图" onClick={() => void copySelectedResult()}>⧉</button>
                  {nativeBridge && <button className="copy-result-button" type="button" disabled={!selected.outputBlob || uploadingId === selected.id} title="上传并复制图片链接" aria-label="上传并复制图片链接" onClick={() => void uploadSelectedResult()}>{uploadingId === selected.id ? "···" : "⇧"}</button>}
                </div>
              </>}
            </div>

            <div
              className={`preview-stage ${previewDragRef.current ? "is-panning" : ""}`}
              onPointerDown={startPreviewPan}
              onPointerMove={movePreviewPan}
              onPointerUp={stopPreviewPan}
              onPointerCancel={stopPreviewPan}
              onWheel={zoomPreviewWithWheel}
            >
              {selected ? (
                previewMode === "compare" ? (
                  <div ref={compareRef} className="compare-canvas" aria-label="拖动中线查看压缩前后对比">
                    <div className={`preview-pan-layer ${previewFit ? "fit" : "actual"}`} style={{ transform: `translate3d(${previewPan.x}px, ${previewPan.y}px, 0) scale(${previewZoom / 100})` }}>
                      <img className="compare-after" src={selected.outputUrl || selected.sourceUrl} alt="优化后预览" />
                      <div className="compare-before" style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }}><img src={selected.sourceUrl} alt="原图预览" /></div>
                    </div>
                    <span className="compare-label before-label">原图 · {formatBytes(selected.originalBytes)}</span>
                    <span className="compare-label after-label">实时结果 · {selected.outputBytes ? formatBytes(selected.outputBytes) : "计算中"}</span>
                    <div
                      className="compare-handle"
                      style={{ left: `${compare}%` }}
                      onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); handleComparePointer(event); }}
                      onPointerMove={(event) => { event.stopPropagation(); if (event.currentTarget.hasPointerCapture(event.pointerId)) handleComparePointer(event); }}
                    ><span>‹ ›</span></div>
                    {selected.outputWidth && (selected.outputWidth !== selected.width || selected.outputHeight !== selected.height) && <div className="preview-scale-note">对比模式会对齐显示尺寸；切到“结果”查看缩小后的真实比例</div>}
                    {selected.status === "processing" && <div className="processing-overlay"><i /><strong>正在计算真实输出体积</strong></div>}
                  </div>
                ) : (
                  <div className="image-inspector" aria-label={previewMode === "original" ? "原图预览" : "结果预览"}>
                    <div className={`actual-image-layer ${previewFit ? "fit" : "actual"}`} style={{ transform: `translate3d(${previewPan.x}px, ${previewPan.y}px, 0) scale(${previewZoom / 100})` }}>
                      <img
                        src={previewMode === "original" ? selected.sourceUrl : selected.outputUrl || selected.sourceUrl}
                        alt={previewMode === "original" ? "原图预览" : "优化结果预览"}
                        style={previewFit ? undefined : {
                          width: `${previewMode === "original" ? selected.width : selected.outputWidth || selected.width}px`,
                          height: `${previewMode === "original" ? selected.height : selected.outputHeight || selected.height}px`,
                        }}
                      />
                    </div>
                    <span className="actual-size-badge">{previewMode === "original" ? "原图" : "结果"} · {previewMode === "original" ? `${selected.width} × ${selected.height}` : `${selected.outputWidth || selected.width} × ${selected.outputHeight || selected.height}`} px</span>
                    {!previewFit && previewZoom === 100 && <span className="pixel-badge">1:1 · 一个图像像素对应一个屏幕像素</span>}
                    {selected.status === "processing" && <div className="processing-overlay"><i /><strong>正在计算真实输出体积</strong></div>}
                  </div>
                )
              ) : (
                <button className="hero-dropzone" type="button" onClick={importImages}>
                  <span className="drop-visual" aria-hidden="true"><i className="drop-card one" /><i className="drop-card two" /><i className="drop-card three" /><b>＋</b></span>
                  <span className="hero-copy"><span className="hero-kicker">DROP · PASTE · COMPRESS</span><strong>把图片放轻一点</strong><p>拖入图片，或点击选择本地文件</p></span>
                  <span className="supported-formats">JPG&nbsp;&nbsp; PNG&nbsp;&nbsp; WebP&nbsp;&nbsp; GIF</span>
                </button>
              )}
            </div>

            <div className="result-strip">
              <div><span>原始体积</span><strong>{formatBytes(totals.original)}</strong></div>
              <span className="result-arrow">→</span>
              <div><span>当前实时结果</span><strong>{items.some((item) => item.outputBytes) ? formatBytes(totals.output) : "—"}</strong></div>
              <div className={`savings-pill ${totals.saved < 0 ? "larger" : ""}`}><span>{totals.saved < 0 ? "体积增加" : "共节省"}</span><strong>{sizeChangeLabel(totals.original, totals.output)}</strong></div>
              <button className="export-button" type="button" disabled={!items.length || exporting} onClick={exportAll}><span>↓</span> {exporting ? "正在导出" : "导出全部"}</button>
            </div>
          </section>

          <aside className="settings-panel">
            <div className="panel-heading"><div><span className="eyebrow">实时试压</span><strong>滑动即预览体积</strong></div><button className="reset-button" type="button" onClick={() => setSettings(DEFAULT_SETTINGS)}>重置</button></div>

            <div className="preset-toolbar">
              <div className="select-wrap"><select aria-label="压缩预设" value={activePresetId} onChange={(event) => {
                const preset = presets.find((candidate) => candidate.id === event.target.value);
                if (preset) applyPreset(preset);
              }}><option value="current">当前参数（自动保存）</option>{presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.custom ? `自定义 · ${preset.name}` : preset.name}</option>)}</select></div>
              <button type="button" title="保存当前参数为预设" onClick={() => setPresetDialogOpen(true)}>＋ 保存</button>
              {presets.find((preset) => preset.id === activePresetId)?.custom && <button className="preset-delete" type="button" title="删除当前预设" onClick={deleteActivePreset}>删除</button>}
            </div>

            <div className="setting-section">
              <label className="setting-label">快速方案</label>
              <div className="mode-grid">
                {([
                  ["lossless", 100, "无损优先", "100%", "◌"],
                  ["balanced", 82, "智能平衡", "82%", "◐"],
                  ["small", 45, "更小体积", "45%", "●"],
                ] as const).map(([value, quality, label, note, icon]) => (
                  <button className={settings.mode === value ? "active" : ""} type="button" key={value} onClick={() => {
                    const preset = BUILT_IN_PRESETS.find((candidate) => candidate.id === value);
                    if (preset) applyPreset({ ...preset, settings: { ...settings, mode: value, quality } });
                  }}>
                    <span>{icon}</span><strong>{label}</strong><small>{note}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-section slider-section">
              <div className="slider-heading"><label className="setting-label" htmlFor="quality-range">画质 / 编码质量</label><output htmlFor="quality-range">{settings.quality}%</output></div>
              <input
                id="quality-range"
                className="compression-range"
                type="range"
                min="1"
                max="100"
                step="1"
                value={settings.quality}
                style={{ "--range-progress": `${settings.quality}%` } as CSSProperties}
                onChange={(event) => {
                  const quality = Number(event.target.value);
                  setSettings((current) => ({ ...current, quality, mode: modeFromQuality(quality) }));
                }}
              />
              <div className="range-labels"><span>更小文件</span><span>更多细节</span></div>
              <div className={`live-size-card ${selected?.status === "processing" ? "calculating" : ""}`}>
                <span><i /> 实时试压结果</span>
                <strong>{selected?.status === "processing" ? "计算中…" : selected?.outputBytes ? formatBytes(selected.outputBytes) : "导入图片后显示"}</strong>
                <small>{selected?.outputBytes ? selected.keptOriginal ? "所有候选都更大，已保留原图" : selected.sizeGuardQuality ? `${formatBytes(selected.originalBytes)} → ${formatBytes(selected.outputBytes)} · 已自动调整编码质量至 ${selected.sizeGuardQuality}%` : `${formatBytes(selected.originalBytes)} → ${formatBytes(selected.outputBytes)} · ${savedPercent(selected.originalBytes, selected.outputBytes) >= 0 ? "节省" : "增加"} ${Math.abs(savedPercent(selected.originalBytes, selected.outputBytes))}%` : "显示的是本机实际编码后的文件大小"}</small>
              </div>
              <p className="setting-hint"><i /> JPG / WebP 调整编码质量；PNG 减少颜色级数；GIF 调整每帧色板。开启体积保护时，缩放后若候选变大，会自动寻找不超过原文件的合适编码质量。</p>
            </div>

            <div className="setting-section slider-section">
              <div className="slider-heading"><label className="setting-label" htmlFor="scale-range">等比例尺寸</label><output htmlFor="scale-range">{formatScale(settings.scale)}</output></div>
              <input
                id="scale-range"
                className="compression-range scale-range"
                type="range"
                min="0.1"
                max="100"
                step="0.1"
                value={settings.scale}
                style={{ "--range-progress": `${settings.scale}%` } as CSSProperties}
                onChange={(event) => setSettings((current) => ({ ...current, scale: Number(event.target.value) }))}
              />
              <div className="range-labels"><span>0.1% · 极小</span><span>100% · 原尺寸</span></div>
              <div className="scale-presets">
                {[100, 50, 25, 10].map((scale) => <button className={settings.scale === scale ? "active" : ""} type="button" key={scale} onClick={() => setSettings((current) => ({ ...current, scale }))}>{scale}%</button>)}
                <button type="button" onClick={() => setSettings((current) => ({ ...current, scale: Math.max(0.1, Math.round(current.scale * 5) / 10) }))}>继续减半</button>
              </div>
              <div className="dimension-preview"><span>预计像素</span><strong>{selectedTarget ? `${selectedTarget.width} × ${selectedTarget.height} px` : "导入图片后显示"}</strong></div>
              <p className="setting-hint">可反复继续减半，始终从原图生成；最小会收敛到 1 × 1 像素。</p>
            </div>

            <div className="setting-section">
              <label className="setting-label" htmlFor="output-format">输出格式</label>
              <div className="select-wrap">
                <select id="output-format" value={settings.format} onChange={(event) => setSettings((current) => ({ ...current, format: event.target.value as OutputFormat }))}>
                  <option value="keep">保持原格式</option>
                  <option value="image/jpeg">JPG · 适合照片</option>
                  <option value="image/png">PNG · 透明与无损</option>
                  <option value="image/webp">WebP · 适合网页</option>
                </select>
              </div>
            </div>

            <div className="setting-section">
              <div className="label-row"><label className="setting-label" htmlFor="resize-toggle">最大像素边界（可选）</label><button id="resize-toggle" className={`switch ${settings.resize ? "on" : ""}`} type="button" role="switch" aria-checked={settings.resize} onClick={() => setSettings((current) => ({ ...current, resize: !current.resize }))}><i /></button></div>
              <div className={`dimension-grid ${settings.resize ? "" : "disabled"}`}>
                <label>最大宽度 <span><input type="number" min="1" value={settings.width} disabled={!settings.resize} onChange={(event) => setSettings((current) => ({ ...current, width: Number(event.target.value) }))} /> px</span></label>
                <button className={settings.lockRatio ? "locked" : ""} type="button" disabled={!settings.resize} aria-label="锁定宽高比" onClick={() => setSettings((current) => ({ ...current, lockRatio: !current.lockRatio }))}>↕</button>
                <label>最大高度 <span><input type="number" min="1" value={settings.height} disabled={!settings.resize} onChange={(event) => setSettings((current) => ({ ...current, height: Number(event.target.value) }))} /> px</span></label>
              </div>
              <p className="setting-hint">会与上方比例同时生效，且不会放大小图；开启 ↕ 时保持原始宽高比。</p>
            </div>

            <div className="setting-section watermark-section">
              <div className="label-row"><label className="setting-label" htmlFor="watermark-toggle">文字水印</label><button id="watermark-toggle" className={`switch ${settings.watermark.enabled ? "on" : ""}`} type="button" role="switch" aria-checked={settings.watermark.enabled} onClick={() => setSettings((current) => ({ ...current, watermark: { ...current.watermark, enabled: !current.watermark.enabled } }))}><i /></button></div>
              {settings.watermark.enabled && <div className="watermark-controls">
                <input className="watermark-text-input" aria-label="水印文字" value={settings.watermark.text} placeholder="输入水印文字" onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, text: event.target.value } }))} />
                <div className="segmented-control" aria-label="水印铺设方式">
                  <button className={settings.watermark.layout === "tile" ? "active" : ""} type="button" onClick={() => setSettings((current) => ({ ...current, watermark: { ...current.watermark, layout: "tile" } }))}>全屏重复</button>
                  <button className={settings.watermark.layout === "single" ? "active" : ""} type="button" onClick={() => setSettings((current) => ({ ...current, watermark: { ...current.watermark, layout: "single" } }))}>单点定位</button>
                </div>
                <div className="font-picker-row">
                  <div className="select-wrap"><select aria-label="水印字体" value={settings.watermark.fontFamily} onChange={(event) => void selectSystemFont(event.target.value)}>{localFonts.map((font) => <option value={font} key={font} style={{ fontFamily: `"${font.replaceAll('"', "")}"` }}>{font}</option>)}</select></div>
                  <button type="button" onClick={loadSystemFonts}>系统字体</button>
                  <button type="button" onClick={() => fontInputRef.current?.click()}>导入字体</button>
                </div>
                <label className="mini-range"><span>字号 <b>{settings.watermark.fontScale.toFixed(1)}%</b></span><input type="range" min="1" max="20" step="0.5" value={settings.watermark.fontScale} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, fontScale: Number(event.target.value) } }))} /></label>
                <label className="mini-range"><span>方向 <b>{settings.watermark.rotation}°</b></span><input type="range" min="-180" max="180" step="1" value={settings.watermark.rotation} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, rotation: Number(event.target.value) } }))} /></label>
                {settings.watermark.layout === "tile" ? <label className="mini-range"><span>铺设密度（越低越稀疏） <b>{settings.watermark.density}%</b></span><input type="range" min="0" max="100" step="1" value={settings.watermark.density} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, density: Number(event.target.value) } }))} /></label> : <>
                  <label className="mini-range"><span>水平位置 <b>{settings.watermark.positionX}%</b></span><input type="range" min="0" max="100" step="1" value={settings.watermark.positionX} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, positionX: Number(event.target.value) } }))} /></label>
                  <label className="mini-range"><span>垂直位置 <b>{settings.watermark.positionY}%</b></span><input type="range" min="0" max="100" step="1" value={settings.watermark.positionY} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, positionY: Number(event.target.value) } }))} /></label>
                </>}
                <div className="watermark-color-row"><label>文字色 <input type="color" value={settings.watermark.color} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, color: event.target.value } }))} /></label><label className="mini-range"><span>透明度 <b>{settings.watermark.opacity}%</b></span><input type="range" min="1" max="100" step="1" value={settings.watermark.opacity} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, opacity: Number(event.target.value) } }))} /></label></div>
                <div className="shadow-row"><label><input type="checkbox" checked={settings.watermark.shadow} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, shadow: event.target.checked } }))} /> 阴影</label>{settings.watermark.shadow && <><input aria-label="阴影颜色" type="color" value={settings.watermark.shadowColor} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, shadowColor: event.target.value } }))} /><label className="mini-range"><span>模糊 <b>{settings.watermark.shadowBlur}px</b></span><input type="range" min="0" max="40" step="1" value={settings.watermark.shadowBlur} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, shadowBlur: Number(event.target.value) } }))} /></label></> }</div>
              </div>}
            </div>

            <div className="setting-section compact">
              <label className="check-row"><input type="checkbox" checked={settings.stripMetadata} onChange={(event) => setSettings((current) => ({ ...current, stripMetadata: event.target.checked }))} /><span><strong>移除隐私元数据</strong><small>删除位置、相机与拍摄信息</small></span></label>
              {!nativeBridge && <label className="check-row secondary-check"><input type="checkbox" checked={settings.preventLarger} onChange={(event) => setSettings((current) => ({ ...current, preventLarger: event.target.checked }))} /><span><strong>始终避免文件变大</strong><small>必要时自动降低编码质量；仍无法变小时保留原图</small></span></label>}
            </div>

            <div className={`setting-section export-settings ${nativeBridge ? "desktop-hidden-setting" : ""}`}>
              <label className="setting-label" htmlFor="export-mode">导出位置</label>
              <div className="select-wrap"><select id="export-mode" value={exportMode} onChange={(event) => setExportMode(event.target.value as ExportMode)}><option value="download">浏览器下载</option><option value="overwrite">覆盖源文件</option><option value="same-folder">原文件夹重命名</option><option value="fixed-folder">固定文件夹</option></select></div>
              {exportMode !== "overwrite" && <label className="suffix-input">文件名后缀<input value={exportSuffix} onChange={(event) => setExportSuffix(event.target.value)} placeholder="-piclite" /></label>}
              {(exportMode === "fixed-folder" || (!nativeBridge && exportMode === "same-folder")) && <button className="folder-picker-button" type="button" onClick={chooseExportFolder}><span>⌑</span><strong>{exportFolderName || (exportMode === "same-folder" ? "授权原文件夹" : "选择固定文件夹")}</strong><b>选择</b></button>}
              <p className={`setting-hint ${exportMode === "overwrite" ? "warning" : ""}`}>{exportMode === "download" && "使用浏览器下载，不需要文件夹权限。"}{exportMode === "overwrite" && "会直接替换原图且无法撤销；仅支持保持原格式，并要求从“添加图片”导入。"}{exportMode === "same-folder" && (nativeBridge ? "桌面端会在每张源图旁输出重命名文件。" : "网页无法自动获知父文件夹，需要手动授权一次目标文件夹。")}{exportMode === "fixed-folder" && "所有处理结果写入指定文件夹。"}</p>
            </div>

            <div className="settings-spacer" />
            <div className="action-summary"><div><span>当前选中</span><strong>{selected?.outputBytes ? formatBytes(selected.outputBytes) : "—"}</strong></div><div><span>输出参数</span><strong>{settings.quality}% · {formatScale(settings.scale)}</strong></div></div>
            <button className="compress-button" type="button" disabled={!items.length || processingAll} onClick={processAll}><span>{processingAll ? "···" : "✦"}</span>{processingAll ? "正在应用到全部" : `按此参数应用到全部${items.length ? ` · ${items.length} 张` : ""}`}</button>
          </aside>
        </section>
      ) : view === "watcher" ? (
        <section className="watcher-page">
          <div className="watcher-intro">
            <span className="section-index">02 / AUTO FLOW</span>
            <h1>放进文件夹，<br />自动<span>变轻。</span></h1>
            <p>PicLite 会静默监测新图片，完成无损优化后写入指定位置。源文件默认保持不变。</p>
            <div className="watcher-platform"><span className={nativeBridge ? "available" : ""}>{nativeBridge ? `● ${desktopPlatform} 客户端已连接` : "◫ 需要桌面客户端"}</span><small>网页端受浏览器安全限制，无法持续读取本地文件夹</small></div>
          </div>

          <div className={`watcher-console ${!nativeBridge ? "locked" : ""}`}>
            {!nativeBridge && (
              <div className="console-lock"><span>▣</span><strong>在桌面客户端中启用</strong><p>网页端的压缩工作台仍可完整使用。文件夹监测需要安装桌面版。</p></div>
            )}
            <div className="console-header"><div><i className={watcherActive ? "active" : ""} /><span>{watcherActive ? "MONITORING" : "READY"}</span></div><small>本地自动化</small></div>
            <div className="folder-route">
              <button type="button" onClick={() => chooseFolder("input")} disabled={!nativeBridge || watcherActive}>
                <span className="folder-icon">⌑</span><small>监测文件夹</small><strong>{watcherSettings.inputFolder || "选择来源文件夹"}</strong><b>选择</b>
              </button>
              <div className="route-line"><i /><i /><i /><span>自动优化</span></div>
              <button type="button" onClick={() => chooseFolder("output")} disabled={!nativeBridge || watcherActive}>
                <span className="folder-icon output">⌑</span><small>输出文件夹</small><strong>{watcherSettings.outputFolder || "默认：来源/PicLite"}</strong><b>选择</b>
              </button>
            </div>

            <div className="watcher-options">
              <label><span>压缩方案</span><select value={watcherSettings.mode} disabled={watcherActive} onChange={(event) => {
                const mode = event.target.value as CompressionMode;
                const quality = mode === "lossless" ? 100 : mode === "balanced" ? 82 : 45;
                setWatcherSettings((current) => ({ ...current, mode, quality }));
              }}><option value="lossless">无损优先</option><option value="balanced">智能平衡</option><option value="small">更小体积</option></select></label>
              <label><span>输出格式</span><select value={watcherSettings.format} disabled={watcherActive} onChange={(event) => setWatcherSettings((current) => ({ ...current, format: event.target.value as OutputFormat }))}><option value="keep">保持原格式</option><option value="image/jpeg">JPG</option><option value="image/png">PNG</option><option value="image/webp">WebP</option></select></label>
              <label className="watcher-range"><span>画质 <b>{watcherSettings.quality}%</b></span><input type="range" min="1" max="100" step="1" value={watcherSettings.quality} disabled={watcherActive} onChange={(event) => {
                const quality = Number(event.target.value);
                setWatcherSettings((current) => ({ ...current, quality, mode: modeFromQuality(quality) }));
              }} /></label>
              <label className="watcher-range"><span>等比例尺寸 <b>{formatScale(watcherSettings.scale)}</b></span><input type="range" min="0.1" max="100" step="0.1" value={watcherSettings.scale} disabled={watcherActive} onChange={(event) => setWatcherSettings((current) => ({ ...current, scale: Number(event.target.value) }))} /></label>
              <label className="watcher-check"><input type="checkbox" checked={watcherSettings.stripMetadata} disabled={watcherActive} onChange={(event) => setWatcherSettings((current) => ({ ...current, stripMetadata: event.target.checked }))} /><span>移除隐私元数据</span></label>
              <label className="watcher-check"><input type="checkbox" checked={watcherSettings.preventLarger} disabled={watcherActive} onChange={(event) => setWatcherSettings((current) => ({ ...current, preventLarger: event.target.checked }))} /><span>候选更大时保留原图</span></label>
              <label className="watcher-check"><input type="checkbox" checked={watcherSettings.resize} disabled={watcherActive} onChange={(event) => setWatcherSettings((current) => ({ ...current, resize: event.target.checked }))} /><span>限制最大像素尺寸</span></label>
              {watcherSettings.resize && <div className="watcher-dimensions"><label>宽 <input type="number" min="1" value={watcherSettings.maxWidth} disabled={watcherActive} onChange={(event) => setWatcherSettings((current) => ({ ...current, maxWidth: Number(event.target.value) }))} /></label><span>×</span><label>高 <input type="number" min="1" value={watcherSettings.maxHeight} disabled={watcherActive} onChange={(event) => setWatcherSettings((current) => ({ ...current, maxHeight: Number(event.target.value) }))} /></label><small>px</small></div>}
            </div>

            <button className={`watcher-toggle ${watcherActive ? "stop" : ""}`} type="button" disabled={!nativeBridge} onClick={toggleWatcher}><span>{watcherActive ? "■" : "▶"}</span>{watcherActive ? "停止监测" : "开始监测"}</button>
          </div>

          <div className="watcher-log">
            <div className="watcher-log-heading"><span>最近活动</span><small>{watcherEvents.length ? `${watcherEvents.length} 条记录` : "等待新图片"}</small></div>
            {watcherEvents.length ? watcherEvents.map((event) => (
              <div className="log-row" key={event.id}>
                <span className={`log-icon ${event.type}`}>{event.type === "success" ? "✓" : event.type === "error" ? "!" : "•"}</span>
                <span><strong>{event.file || event.message || (event.type === "started" ? "文件夹监测已启动" : "文件夹监测已停止")}</strong><small>{new Date(event.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}{event.originalBytes && event.outputBytes ? ` · ${formatBytes(event.originalBytes)} → ${formatBytes(event.outputBytes)}` : ""}</small></span>
                {event.originalBytes && event.outputBytes ? <b className={savedPercent(event.originalBytes, event.outputBytes) < 0 ? "larger" : ""}>{sizeChangeLabel(event.originalBytes, event.outputBytes)}</b> : null}
              </div>
            )) : <div className="log-empty"><span>⌁</span><p>启动监测后，处理记录会出现在这里</p></div>}
          </div>
        </section>
      ) : view === "gallery" ? (
        <section className="gallery-page" aria-label="压缩结果图库">
          <header className="gallery-hero">
            <div>
              <span className="section-index">03 / RESULT LIBRARY</span>
              <h1>压过的图，<br />随手就能<span>再用。</span></h1>
              <p>压缩结果保存在本机图库中。复制图片可直接粘贴，上传成功后链接也会留在这里。</p>
            </div>
            <div className="gallery-summary"><strong>{galleryItems.length}</strong><span>张结果图</span><button type="button" onClick={() => void refreshGallery()}>↻ 刷新</button></div>
          </header>

          {galleryItems.length ? (
            <div className="gallery-grid">
              {galleryItems.map((record) => (
                <article className="gallery-card" key={record.id}>
                  <div className="gallery-preview"><img src={record.previewUrl} alt={record.name} /><span>{record.width} × {record.height}</span></div>
                  <div className="gallery-card-body">
                    <strong title={record.name}>{record.name}</strong>
                    <small>{new Date(record.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} · {formatBytes(record.outputBytes)} · {sizeChangeLabel(record.originalBytes, record.outputBytes)}</small>
                    {record.remoteUrl && <button className="gallery-link" type="button" title={record.remoteUrl} onClick={() => void copyRemoteUrl(record.remoteUrl!)}><span>↗</span><b>{record.remoteUrl}</b><em>复制链接</em></button>}
                    <div className="gallery-actions">
                      <button type="button" onClick={() => void copyGalleryResult(record)}>⧉ 复制图片</button>
                      <button type="button" onClick={() => downloadGalleryResult(record)}>↓ 保存文件</button>
                      {nativeBridge && <button type="button" disabled={uploadingId === record.id} onClick={() => void uploadGalleryResult(record)}>{uploadingId === record.id ? "上传中…" : record.remoteUrl ? "重新上传" : "⇧ 上传图床"}</button>}
                      {nativeBridge && (record.outputPath || record.sourcePath) && <button type="button" onClick={() => void nativeBridge.revealPath(record.outputPath || record.sourcePath!)}>⌑ 定位文件</button>}
                      <button className="danger" type="button" title="只删除图库记录，不删除本地文件" onClick={() => void deleteGalleryResult(record.id)}>移除</button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="gallery-empty"><span>◫</span><strong>图库还是空的</strong><p>工作台实时生成、导出或悬浮窗压缩后的图片会自动出现在这里。</p><button type="button" onClick={() => setView("workspace")}>去压缩图片</button></div>
          )}
        </section>
      ) : (
        <section className="preferences-page" aria-label="PicLite 应用设置">
          <aside className="preferences-aside">
            <span className="section-index">03 / PREFERENCES</span>
            <h1>像软件一样，<br />安静地<span>工作。</span></h1>
            <p>这些是桌面客户端的全局设置。压缩参数仍放在工作台，只在当前任务中调整。</p>
            <div className="native-stack"><i>R</i><span><strong>Rust native core</strong><small>Tauri 2 · 使用系统 WebView，不再打包 Chromium</small></span></div>
          </aside>

          <div className="preferences-content">
            <section className="preference-card">
              <div className="preference-card-heading"><span>导出</span><small>默认保存规则</small></div>
              <div className="preference-row column">
                <div><strong>默认导出方式</strong><small>每次点击“导出全部”时使用</small></div>
                <div className="preference-segments">
                  <button className={desktopPreferences.exportMode === "same-folder" ? "active" : ""} type="button" onClick={() => setDesktopPreferences((current) => ({ ...current, exportMode: "same-folder" }))}>源文件旁重命名</button>
                  <button className={desktopPreferences.exportMode === "fixed-folder" ? "active" : ""} type="button" onClick={() => setDesktopPreferences((current) => ({ ...current, exportMode: "fixed-folder" }))}>固定文件夹</button>
                  <button className={desktopPreferences.exportMode === "overwrite" ? "danger active" : "danger"} type="button" onClick={() => setDesktopPreferences((current) => ({ ...current, exportMode: "overwrite" }))}>覆盖源文件</button>
                </div>
              </div>
              {desktopPreferences.exportMode !== "overwrite" && <div className="preference-row">
                <div><strong>文件名后缀</strong><small>例如 photo-piclite.jpg</small></div>
                <input className="preference-input" value={desktopPreferences.exportSuffix} onChange={(event) => setDesktopPreferences((current) => ({ ...current, exportSuffix: event.target.value }))} />
              </div>}
              {desktopPreferences.exportMode === "fixed-folder" && <div className="preference-row">
                <div><strong>固定输出文件夹</strong><small>{desktopPreferences.exportFolder || "尚未选择"}</small></div>
                <button className="preference-action" type="button" onClick={chooseExportFolder}>选择文件夹</button>
              </div>}
              {desktopPreferences.exportMode === "overwrite" && <label className="preference-row clickable"><div><strong>覆盖前再次确认</strong><small>建议保持开启，覆盖操作无法撤销</small></div><button className={`switch ${desktopPreferences.confirmOverwrite ? "on" : ""}`} type="button" role="switch" aria-checked={desktopPreferences.confirmOverwrite} onClick={() => setDesktopPreferences((current) => ({ ...current, confirmOverwrite: !current.confirmOverwrite }))}><i /></button></label>}
            </section>

            <section className="preference-card">
              <div className="preference-card-heading"><span>压缩行为</span><small>全局保护策略</small></div>
              <label className="preference-row clickable">
                <div><strong>始终避免文件变大</strong><small>缩放结果偏大时自动调整编码质量；仍无法变小时保留原图</small></div>
                <button className={`switch ${desktopPreferences.preventLarger ? "on" : ""}`} type="button" role="switch" aria-checked={desktopPreferences.preventLarger} onClick={() => setDesktopPreferences((current) => ({ ...current, preventLarger: !current.preventLarger }))}><i /></button>
              </label>
            </section>

            <section className="preference-card">
              <div className="preference-card-heading"><span>外观</span><small>高分屏与深色主题</small></div>
              <div className="preference-row column">
                <div><strong>主题</strong><small>可跟随 Windows / macOS 系统外观</small></div>
                <div className="preference-segments">
                  {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => <button className={desktopPreferences.theme === value ? "active" : ""} type="button" key={value} onClick={() => setDesktopPreferences((current) => ({ ...current, theme: value }))}>{label}</button>)}
                </div>
              </div>
              <div className="preference-row column">
                <div><strong>界面密度</strong><small>自动模式优先保证字号清晰，仅在窗口接近最小尺寸时收紧界面</small></div>
                <div className="preference-segments">
                  {([['auto', '自动'], ['comfortable', '标准'], ['compact', '紧凑']] as const).map(([value, label]) => <button className={desktopPreferences.density === value ? "active" : ""} type="button" key={value} onClick={() => setDesktopPreferences((current) => ({ ...current, density: value }))}>{label}</button>)}
                </div>
              </div>
              <div className="preference-row column">
                <div><strong>悬浮压缩坞主题</strong><small>可以独立于主窗口选择浅色、深色或跟随系统</small></div>
                <div className="preference-segments">
                  {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => <button className={desktopPreferences.dockTheme === value ? "active" : ""} type="button" key={value} onClick={() => setDesktopPreferences((current) => ({ ...current, dockTheme: value }))}>{label}</button>)}
                </div>
              </div>
              <div className="preference-row column">
                <div><strong>悬浮入口样式</strong><small>桌宠适合常驻；紧凑与完整样式会在产生结果时展开工具区</small></div>
                <div className="preference-segments">
                  {([['pet', '桌宠'], ['compact', '紧凑'], ['full', '完整']] as const).map(([value, label]) => <button className={desktopPreferences.dockLayout === value ? "active" : ""} type="button" key={value} onClick={() => setDesktopPreferences((current) => ({ ...current, dockLayout: value }))}>{label}</button>)}
                </div>
              </div>
              <div className="preference-row column">
                <div><strong>桌宠角色</strong><small>绿色苦力怕猫与黑色末影人猫，可在桌宠右键菜单里随时切换</small></div>
                <div className="preference-segments pet-variant-preferences">
                  {([['green', '绿色猫帽'], ['black', '黑色猫帽']] as const).map(([value, label]) => <button className={desktopPreferences.petVariant === value ? "active" : ""} type="button" key={value} onClick={() => setDesktopPreferences((current) => ({ ...current, petVariant: value }))}>{label}</button>)}
                </div>
              </div>
              <label className="preference-row"><div><strong>桌宠大小</strong><small>也可以把鼠标放在桌宠上滚动滚轮，范围 60%–180%</small></div><span className="preference-number"><input type="number" min="60" max="180" step="5" value={desktopPreferences.petScale} onChange={(event) => setDesktopPreferences((current) => ({ ...current, petScale: Math.max(60, Math.min(180, Number(event.target.value) || 100)) }))} /> %</span></label>
              <label className="preference-row"><div><strong>结果自动收起</strong><small>压缩完成后在桌面右下角停留；设为 0 秒则不自动收起</small></div><span className="preference-number"><input type="number" min="0" max="120" step="1" value={desktopPreferences.floatingResultSeconds} onChange={(event) => setDesktopPreferences((current) => ({ ...current, floatingResultSeconds: Math.max(0, Math.min(120, Number(event.target.value) || 0)) }))} /> 秒</span></label>
            </section>

            <section className="preference-card upload-preference-card">
              <div className="preference-card-heading"><span>图床上传</span><small>WebDAV · S3 · R2 · OSS · FTP · SFTP</small></div>
              <div className="preference-row column">
                <div><strong>服务类型</strong><small>压缩后可从工作台或图库直接上传并复制链接</small></div>
                <div className="preference-segments upload-provider-segments">
                  {([['webdav', 'WebDAV'], ['s3', 'S3 / MinIO'], ['r2', 'Cloudflare R2'], ['oss', '阿里云 OSS'], ['ftp', 'FTP'], ['sftp', 'SFTP']] as const).map(([value, label]) => <button className={uploadSettings.provider === value ? "active" : ""} type="button" key={value} onClick={() => setUploadSettings((current) => ({ ...current, provider: value, region: value === "r2" ? "auto" : value === "s3" && current.region === "auto" ? "us-east-1" : current.region, port: value === "ftp" ? 21 : value === "sftp" ? 22 : current.port }))}>{label}</button>)}
                </div>
              </div>
              <div className="upload-grid">
                <label className="upload-field wide"><span>服务地址</span><input type="text" value={uploadSettings.endpoint} placeholder={uploadSettings.provider === "webdav" ? "https://dav.example.com/remote.php/dav/files/user" : uploadSettings.provider === "r2" ? "https://ACCOUNT_ID.r2.cloudflarestorage.com" : uploadSettings.provider === "s3" ? "https://s3.amazonaws.com 或 https://minio.example.com" : uploadSettings.provider === "oss" ? "https://oss-cn-hangzhou.aliyuncs.com" : "server.example.com"} onChange={(event) => setUploadSettings((current) => ({ ...current, endpoint: event.target.value }))} /></label>
                {(uploadSettings.provider === "s3" || uploadSettings.provider === "r2" || uploadSettings.provider === "oss") && <label className="upload-field"><span>Bucket</span><input type="text" value={uploadSettings.bucket} placeholder="images" onChange={(event) => setUploadSettings((current) => ({ ...current, bucket: event.target.value }))} /></label>}
                {(uploadSettings.provider === "s3" || uploadSettings.provider === "r2") && <label className="upload-field"><span>Region</span><input type="text" value={uploadSettings.region} placeholder={uploadSettings.provider === "r2" ? "auto" : "us-east-1"} onChange={(event) => setUploadSettings((current) => ({ ...current, region: event.target.value }))} /></label>}
                {(uploadSettings.provider === "s3" || uploadSettings.provider === "r2" || uploadSettings.provider === "oss") && <label className="upload-field"><span>Access Key ID</span><input type="text" value={uploadSettings.accessKey} autoComplete="off" onChange={(event) => setUploadSettings((current) => ({ ...current, accessKey: event.target.value }))} /></label>}
                {(uploadSettings.provider === "webdav" || uploadSettings.provider === "ftp" || uploadSettings.provider === "sftp") && <label className="upload-field"><span>用户名</span><input type="text" value={uploadSettings.username} autoComplete="username" onChange={(event) => setUploadSettings((current) => ({ ...current, username: event.target.value }))} /></label>}
                {(uploadSettings.provider === "ftp" || uploadSettings.provider === "sftp") && <label className="upload-field"><span>端口</span><input type="number" min="1" max="65535" value={uploadSettings.port} onChange={(event) => setUploadSettings((current) => ({ ...current, port: Number(event.target.value) }))} /></label>}
                {uploadSettings.provider === "sftp" && <label className="upload-field wide"><span>SSH 私钥路径（可选）</span><input type="text" value={uploadSettings.keyPath} placeholder="留空时使用密码" onChange={(event) => setUploadSettings((current) => ({ ...current, keyPath: event.target.value }))} /></label>}
                <label className="upload-field"><span>{uploadSettings.provider === "s3" || uploadSettings.provider === "r2" || uploadSettings.provider === "oss" ? "Secret Access Key" : "密码"}</span><input type="password" value={uploadSecret} autoComplete="new-password" placeholder="保存后下次自动读取" onChange={(event) => setUploadSecret(event.target.value)} /></label>
                {uploadSettings.provider === "s3" && <label className="upload-field upload-check"><input type="checkbox" checked={uploadSettings.pathStyle} onChange={(event) => setUploadSettings((current) => ({ ...current, pathStyle: event.target.checked }))} /><span>使用 Path-style（MinIO / 自建 S3 常用）</span></label>}
                <label className="upload-field"><span>远端目录</span><input type="text" value={uploadSettings.remotePath} placeholder="piclite" onChange={(event) => setUploadSettings((current) => ({ ...current, remotePath: event.target.value }))} /></label>
                <label className="upload-field wide"><span>公开访问地址（可选）</span><input type="text" value={uploadSettings.publicBaseUrl} placeholder="https://img.example.com" onChange={(event) => setUploadSettings((current) => ({ ...current, publicBaseUrl: event.target.value }))} /><small>用于拼接最终图片链接；留空则返回服务本身的地址。</small></label>
              </div>
              <div className="upload-save-row"><p className="upload-security-note"><span>◉</span> 配置和凭证保存在当前系统用户的 PicLite 配置目录，不写入网页 localStorage，也不会同步到云端。</p><button className="preference-action" type="button" disabled={!nativeBridge} onClick={() => void saveUploadProfile()}>{uploadProfileSaved ? "✓ 已保存 · 再次保存" : "保存到本机"}</button></div>
            </section>

            <section className="preference-card">
              <div className="preference-card-heading"><span>系统托盘</span><small>后台常驻行为</small></div>
              <div className="preference-row"><div><strong>仅在系统托盘 / 菜单栏显示</strong><small>任务栏与 macOS Dock 不保留图标，主窗口关闭后仍在后台运行</small></div><span className="always-on-badge">始终开启</span></div>
              <label className="preference-row clickable"><div><strong>开机自启动</strong><small>登录系统后静默进入托盘，不主动弹出主窗口</small></div><button className={`switch ${desktopPreferences.launchAtStartup ? "on" : ""}`} type="button" role="switch" aria-checked={desktopPreferences.launchAtStartup} onClick={() => void toggleAutostart()}><i /></button></label>
              <label className="preference-row clickable"><div><strong>最小化时留在托盘</strong><small>不占用任务栏；从托盘左键恢复主窗口</small></div><button className={`switch ${desktopPreferences.minimizeToTray ? "on" : ""}`} type="button" role="switch" aria-checked={desktopPreferences.minimizeToTray} onClick={() => setDesktopPreferences((current) => ({ ...current, minimizeToTray: !current.minimizeToTray }))}><i /></button></label>
              <div className="preference-row"><div><strong>悬浮压缩坞</strong><small>可点击选图或拖入图片；结果会在桌面右下角显示并继续调整</small></div><button className="preference-action" type="button" onClick={() => void nativeBridge?.showDropzoneWindow()}>立即打开</button></div>
            </section>

            <section className="preference-card">
              <div className="preference-card-heading"><span>全局快捷键</span><small>窗口隐藏后仍然有效</small></div>
              <label className="preference-row clickable"><div><strong>启用全局快捷键</strong><small>如果组合键与其他软件冲突，可以关闭或重新录制</small></div><button className={`switch ${desktopPreferences.shortcutsEnabled ? "on" : ""}`} type="button" role="switch" aria-checked={desktopPreferences.shortcutsEnabled} onClick={() => setDesktopPreferences((current) => ({ ...current, shortcutsEnabled: !current.shortcutsEnabled }))}><i /></button></label>
              {([
                ["shortcutShow", "显示主窗口", "从任何软件快速唤起 PicLite"],
                ["shortcutPaste", "导入剪贴板图片", "唤起工作台并读取当前剪贴板图片"],
                ["shortcutDock", "打开悬浮压缩坞", "直接显示可拖入图片的压缩坞"],
              ] as const).map(([preference, title, note]) => <div className="preference-row shortcut-row" key={preference}><div><strong>{title}</strong><small>{note}</small></div><button className={`shortcut-recorder ${recordingShortcut === preference ? "recording" : ""}`} type="button" disabled={!desktopPreferences.shortcutsEnabled} onClick={() => setRecordingShortcut(preference)} onBlur={() => setRecordingShortcut((current) => current === preference ? null : current)} onKeyDown={(event) => recordingShortcut === preference && captureShortcut(event, preference)}>{recordingShortcut === preference ? "请按组合键…" : shortcutLabel(desktopPreferences[preference], nativeBridge?.platform || "win32")}</button></div>)}
              <p className="shortcut-help">点击组合键后直接按新的按键；按 Delete 清除，按 Esc 取消。为避免误触，快捷键必须包含 Ctrl/⌘ 或 Alt。</p>
            </section>

            <section className="preference-card about-card">
              <div className="preference-card-heading"><span>关于 PicLite</span><small>版本与运行环境</small></div>
              <div className="about-product"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><div><strong>PicLite 图轻</strong><small>0.9.1 · Tauri 2 + Rust</small></div><em>OPEN SOURCE</em></div>
              <p>图片在本机处理，不上传到 PicLite 服务器。桌面端使用操作系统自带 WebView，因此安装包不再携带完整浏览器内核。</p>
              <div className="about-links"><a href="https://github.com/amiaoapp/PicLite" target="_blank" rel="noreferrer">GitHub 项目</a><button type="button" onClick={() => showToast("PicLite 0.9.1 · Tauri 2 + Rust")}>版本信息</button></div>
            </section>
          </div>
        </section>
      )}

      {presetDialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPresetDialogOpen(false); }}><form className="preset-dialog" onSubmit={(event) => { event.preventDefault(); saveCustomPreset(); }}><span className="eyebrow">SAVE PRESET</span><h2>保存当前压缩参数</h2><p>画质、尺寸、格式、元数据和水印设置会一起保存，下次启动仍然可用。</p><input autoFocus value={presetName} maxLength={24} placeholder="例如：公众号封面" onChange={(event) => setPresetName(event.target.value)} /><div><button type="button" onClick={() => setPresetDialogOpen(false)}>取消</button><button className="primary" type="submit" disabled={!presetName.trim()}>保存预设</button></div></form></div>}
      {dragging && <div className="drag-overlay" onDragLeave={() => setDragging(false)}><div><span>＋</span><strong>松开即可加入图片</strong><small>支持同时导入多张</small></div></div>}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </main>
  );
}
