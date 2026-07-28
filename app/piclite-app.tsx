"use client";
/* eslint-disable @next/next/no-img-element -- Blob URLs are created and revoked locally. */

import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { applyPalette, GIFEncoder, quantize } from "gifenc";

type CompressionMode = "lossless" | "balanced" | "small";
type OutputFormat = "keep" | "image/jpeg" | "image/png" | "image/webp";
type ViewName = "workspace" | "watcher" | "preferences";
type PreviewMode = "compare" | "original" | "result";
type ItemStatus = "ready" | "processing" | "done" | "error";
type ExportMode = "download" | "overwrite" | "same-folder" | "fixed-folder";
type WatermarkLayout = "tile" | "single";

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
  readClipboardImage: () => Promise<{ data: Uint8Array } | null>;
  selectImages: () => Promise<NativeImage[]>;
  selectFolder: (kind: "input" | "output" | "export") => Promise<string | null>;
  exportImages: (payload: { mode: Exclude<ExportMode, "download">; suffix: string; fixedFolder?: string; items: NativeExportItem[] }) => Promise<{ ok: boolean; paths?: string[]; error?: string }>;
  startWatcher: (settings: WatcherSettings) => Promise<{ ok: boolean; error?: string }>;
  stopWatcher: () => Promise<{ ok: boolean }>;
  getWatcherState: () => Promise<{ active: boolean; settings?: WatcherSettings }>;
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
};

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
};

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
  context.font = `700 ${fontSize}px "${watermark.fontFamily.replaceAll('"', "")}", sans-serif`;
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
    const stepX = measured + fontSize * (3.2 - density * 2.2);
    const stepY = fontSize * (4.6 - density * 3.15);
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

type CompressionResult = { blob: Blob; width: number; height: number; keptOriginal?: boolean };

async function compressImage(item: ImageItem, settings: CompressionSettings): Promise<CompressionResult> {
  const candidate = item.type === "image/gif" && settings.format === "keep"
    ? await animatedGifCompress(item, settings)
    : await canvasCompress(item, settings);
  const hasVisualTransform = candidate.width !== item.width
    || candidate.height !== item.height
    || settings.format !== "keep"
    || settings.watermark.enabled;
  if (settings.preventLarger && !hasVisualTransform && candidate.blob.size >= item.originalBytes) {
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

export function PicLiteApp() {
  const [view, setView] = useState<ViewName>("workspace");
  const [items, setItems] = useState<ImageItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState<CompressionSettings>(DEFAULT_SETTINGS);
  const [compare, setCompare] = useState(52);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("compare");
  const [previewZoom, setPreviewZoom] = useState(100);
  const [previewFit, setPreviewFit] = useState(true);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [processingAll, setProcessingAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [desktopPreferences, setDesktopPreferences] = useState<DesktopPreferences>(DEFAULT_DESKTOP_PREFERENCES);
  const [exportMode, setExportMode] = useState<ExportMode>(() => typeof window !== "undefined" && window.picLite ? DEFAULT_DESKTOP_PREFERENCES.exportMode : "download");
  const [exportSuffix, setExportSuffix] = useState("-piclite");
  const [exportFolderName, setExportFolderName] = useState("");
  const [localFonts, setLocalFonts] = useState<string[]>(["Microsoft YaHei", "PingFang SC", "Arial", "SimSun"]);
  const [toast, setToast] = useState<string | null>(null);
  const [watcherSettings, setWatcherSettings] = useState<WatcherSettings>(DEFAULT_WATCHER_SETTINGS);
  const [watcherActive, setWatcherActive] = useState(false);
  const [watcherEvents, setWatcherEvents] = useState<WatcherEvent[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const exportDirectoryRef = useRef<DirectoryHandleLike | null>(null);
  const compareRef = useRef<HTMLDivElement>(null);
  const previewDragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const itemsRef = useRef<ImageItem[]>([]);
  const settingsReadyRef = useRef(false);
  const desktopPreferencesReadyRef = useRef(false);
  const livePreviewGenerationRef = useRef(0);
  const nativeBridge = typeof window !== "undefined" ? window.picLite : undefined;
  const desktopPlatform = nativeBridge
    ? ({ win32: "Windows", darwin: "macOS", linux: "Linux" }[nativeBridge.platform] || "桌面")
    : "桌面";

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
    try {
      const saved = window.localStorage.getItem("piclite.desktopPreferences.v1");
      const next = saved ? { ...DEFAULT_DESKTOP_PREFERENCES, ...JSON.parse(saved) } as DesktopPreferences : DEFAULT_DESKTOP_PREFERENCES;
      setDesktopPreferences(next);
      setExportMode(next.exportMode);
      setExportSuffix(next.exportSuffix);
      setExportFolderName(next.exportFolder);
      setSettings((current) => ({ ...current, preventLarger: next.preventLarger }));
    } catch {
      setDesktopPreferences(DEFAULT_DESKTOP_PREFERENCES);
    } finally {
      desktopPreferencesReadyRef.current = true;
    }
  }, [nativeBridge]);

  useEffect(() => {
    if (!nativeBridge || !desktopPreferencesReadyRef.current) return;
    window.localStorage.setItem("piclite.desktopPreferences.v1", JSON.stringify(desktopPreferences));
    setExportMode(desktopPreferences.exportMode);
    setExportSuffix(desktopPreferences.exportSuffix);
    setExportFolderName(desktopPreferences.exportFolder);
    setSettings((current) => current.preventLarger === desktopPreferences.preventLarger ? current : { ...current, preventLarger: desktopPreferences.preventLarger });
  }, [desktopPreferences, nativeBridge]);

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
      return;
    }
    setItems((current) => current.map((item) => {
      if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
      return { ...item, outputUrl: undefined, outputBlob: undefined, outputBytes: undefined, outputType: undefined, outputWidth: undefined, outputHeight: undefined, keptOriginal: undefined, status: "ready", error: undefined };
    }));
  }, [settings]);

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
    });
  }, [nativeBridge]);

  const processOne = useCallback(async (id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    setItems((current) => current.map((candidate) => candidate.id === id ? { ...candidate, status: "processing", error: undefined } : candidate));
    try {
      const result = await compressImage(item, settings);
      const outputUrl = URL.createObjectURL(result.blob);
      setItems((current) => current.map((candidate) => {
        if (candidate.id !== id) return candidate;
        if (candidate.outputUrl) URL.revokeObjectURL(candidate.outputUrl);
        return { ...candidate, outputBlob: result.blob, outputUrl, outputBytes: result.blob.size, outputType: result.blob.type || candidate.type, outputWidth: result.width, outputHeight: result.height, keptOriginal: result.keptOriginal, status: "done" };
      }));
    } catch (error) {
      setItems((current) => current.map((candidate) => candidate.id === id ? { ...candidate, status: "error", error: error instanceof Error ? error.message : "压缩失败" } : candidate));
    }
  }, [settings]);

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
      const completed = { ...item, outputBlob: result.blob, outputUrl, outputBytes: result.blob.size, outputType: result.blob.type || item.type, outputWidth: result.width, outputHeight: result.height, keptOriginal: result.keptOriginal, status: "done" as const };
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
  }, [chooseExportFolder, desktopPreferences.confirmOverwrite, downloadItem, exportFolderName, exportMode, exportSuffix, exporting, nativeBridge, prepareAllForExport, settings.format, showToast]);

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
    if (!window.queryLocalFonts) {
      showToast("当前浏览器不支持读取系统字体，可直接导入字体文件");
      return;
    }
    try {
      const fonts = await window.queryLocalFonts();
      const families = Array.from(new Set(fonts.map((font) => font.family).filter(Boolean))).sort((left, right) => left.localeCompare(right));
      setLocalFonts((current) => Array.from(new Set([...current, ...families])));
      showToast(`已读取 ${families.length} 个本地字体`);
    } catch {
      showToast("没有获得本地字体读取权限");
    }
  }, [showToast]);

  const onFontSelected = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const family = `PicLite ${file.name.replace(/\.[^.]+$/, "")}`;
      const font = new FontFace(family, await file.arrayBuffer());
      await font.load();
      document.fonts.add(font);
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
    if (target.closest(".compare-handle")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    previewDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: previewPan.x, panY: previewPan.y };
  }, [previewPan]);

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

            <div className="setting-section">
              <label className="setting-label">快速方案</label>
              <div className="mode-grid">
                {([
                  ["lossless", 100, "无损优先", "100%", "◌"],
                  ["balanced", 82, "智能平衡", "82%", "◐"],
                  ["small", 45, "更小体积", "45%", "●"],
                ] as const).map(([value, quality, label, note, icon]) => (
                  <button className={settings.mode === value ? "active" : ""} type="button" key={value} onClick={() => setSettings((current) => ({ ...current, mode: value, quality }))}>
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
                <small>{selected?.outputBytes ? selected.keptOriginal ? "候选文件更大，智能保留原图" : `${formatBytes(selected.originalBytes)} → ${formatBytes(selected.outputBytes)} · ${savedPercent(selected.originalBytes, selected.outputBytes) >= 0 ? "节省" : "增加"} ${Math.abs(savedPercent(selected.originalBytes, selected.outputBytes))}%` : "显示的是本机实际编码后的文件大小"}</small>
              </div>
              <p className="setting-hint"><i /> JPG / WebP 调整编码质量；PNG 减少颜色级数；GIF 调整每帧色板。若没有尺寸、格式或水印变化且候选文件更大，会自动保留原图。</p>
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
                  <div className="select-wrap"><select aria-label="水印字体" value={settings.watermark.fontFamily} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, fontFamily: event.target.value } }))}>{localFonts.map((font) => <option value={font} key={font}>{font}</option>)}</select></div>
                  <button type="button" onClick={loadSystemFonts}>系统字体</button>
                  <button type="button" onClick={() => fontInputRef.current?.click()}>导入字体</button>
                </div>
                <label className="mini-range"><span>字号 <b>{settings.watermark.fontScale.toFixed(1)}%</b></span><input type="range" min="1" max="20" step="0.5" value={settings.watermark.fontScale} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, fontScale: Number(event.target.value) } }))} /></label>
                <label className="mini-range"><span>方向 <b>{settings.watermark.rotation}°</b></span><input type="range" min="-180" max="180" step="1" value={settings.watermark.rotation} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, rotation: Number(event.target.value) } }))} /></label>
                {settings.watermark.layout === "tile" ? <label className="mini-range"><span>铺设密度 <b>{settings.watermark.density}%</b></span><input type="range" min="5" max="100" step="1" value={settings.watermark.density} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, density: Number(event.target.value) } }))} /></label> : <>
                  <label className="mini-range"><span>水平位置 <b>{settings.watermark.positionX}%</b></span><input type="range" min="0" max="100" step="1" value={settings.watermark.positionX} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, positionX: Number(event.target.value) } }))} /></label>
                  <label className="mini-range"><span>垂直位置 <b>{settings.watermark.positionY}%</b></span><input type="range" min="0" max="100" step="1" value={settings.watermark.positionY} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, positionY: Number(event.target.value) } }))} /></label>
                </>}
                <div className="watermark-color-row"><label>文字色 <input type="color" value={settings.watermark.color} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, color: event.target.value } }))} /></label><label className="mini-range"><span>透明度 <b>{settings.watermark.opacity}%</b></span><input type="range" min="1" max="100" step="1" value={settings.watermark.opacity} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, opacity: Number(event.target.value) } }))} /></label></div>
                <div className="shadow-row"><label><input type="checkbox" checked={settings.watermark.shadow} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, shadow: event.target.checked } }))} /> 阴影</label>{settings.watermark.shadow && <><input aria-label="阴影颜色" type="color" value={settings.watermark.shadowColor} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, shadowColor: event.target.value } }))} /><label className="mini-range"><span>模糊 <b>{settings.watermark.shadowBlur}px</b></span><input type="range" min="0" max="40" step="1" value={settings.watermark.shadowBlur} onChange={(event) => setSettings((current) => ({ ...current, watermark: { ...current.watermark, shadowBlur: Number(event.target.value) } }))} /></label></> }</div>
              </div>}
            </div>

            <div className="setting-section compact">
              <label className="check-row"><input type="checkbox" checked={settings.stripMetadata} onChange={(event) => setSettings((current) => ({ ...current, stripMetadata: event.target.checked }))} /><span><strong>移除隐私元数据</strong><small>删除位置、相机与拍摄信息</small></span></label>
              {!nativeBridge && <label className="check-row secondary-check"><input type="checkbox" checked={settings.preventLarger} onChange={(event) => setSettings((current) => ({ ...current, preventLarger: event.target.checked }))} /><span><strong>智能保留较小文件</strong><small>没有视觉变换时不输出更大的候选文件</small></span></label>}
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
                <div><strong>智能保留较小文件</strong><small>未改变尺寸、格式或水印时，如果候选文件更大就保留原图</small></div>
                <button className={`switch ${desktopPreferences.preventLarger ? "on" : ""}`} type="button" role="switch" aria-checked={desktopPreferences.preventLarger} onClick={() => setDesktopPreferences((current) => ({ ...current, preventLarger: !current.preventLarger }))}><i /></button>
              </label>
            </section>

            <section className="preference-card about-card">
              <div className="preference-card-heading"><span>关于 PicLite</span><small>版本与运行环境</small></div>
              <div className="about-product"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><div><strong>PicLite 图轻</strong><small>0.5.0 · Tauri 2 + Rust</small></div><em>OPEN SOURCE</em></div>
              <p>图片在本机处理，不上传到 PicLite 服务器。桌面端使用操作系统自带 WebView，因此安装包不再携带完整浏览器内核。</p>
              <div className="about-links"><a href="https://github.com/amiaoapp/PicLite" target="_blank" rel="noreferrer">GitHub 项目</a><button type="button" onClick={() => showToast("PicLite 0.5.0 · Tauri 2 + Rust")}>版本信息</button></div>
            </section>
          </div>
        </section>
      )}

      {dragging && <div className="drag-overlay" onDragLeave={() => setDragging(false)}><div><span>＋</span><strong>松开即可加入图片</strong><small>支持同时导入多张</small></div></div>}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </main>
  );
}
