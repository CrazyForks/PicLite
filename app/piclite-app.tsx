"use client";
/* eslint-disable @next/next/no-img-element -- Blob URLs are created and revoked locally. */

import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type CompressionMode = "lossless" | "balanced" | "small";
type OutputFormat = "keep" | "image/jpeg" | "image/png" | "image/webp";
type ViewName = "workspace" | "watcher";
type ItemStatus = "ready" | "processing" | "done" | "error";

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
};

type NativeBridge = {
  platform: string;
  readClipboardImage: () => Promise<{ data: Uint8Array } | null>;
  selectFolder: (kind: "input" | "output") => Promise<string | null>;
  startWatcher: (settings: WatcherSettings) => Promise<{ ok: boolean; error?: string }>;
  stopWatcher: () => Promise<{ ok: boolean }>;
  getWatcherState: () => Promise<{ active: boolean; settings?: WatcherSettings }>;
  onWatcherEvent: (callback: (event: WatcherEvent) => void) => () => void;
};

declare global {
  interface Window {
    picLite?: NativeBridge;
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
  return Math.max(0, Math.round((1 - output / original) * 100));
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
  return "application/octet-stream";
}

function outputName(item: ImageItem) {
  const base = item.name.replace(/\.[^.]+$/, "");
  return `${base}-piclite.${outputExtension(item.outputType || item.type, item.name)}`;
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

async function canvasCompress(item: ImageItem, settings: CompressionSettings) {
  const bitmap = await createImageBitmap(item.file);
  const { width, height } = getTargetDimensions(item, settings);

  const sameSize = width === item.width && height === item.height;
  if (settings.quality >= 100 && settings.format === "keep" && sameSize) {
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

  const quality = Math.min(1, Math.max(0.01, settings.quality / 100));
  const result = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outputType, quality));
  if (!result) throw new Error("当前浏览器不支持所选输出格式");
  if (settings.quality >= 100 && settings.format === "keep" && sameSize && result.size >= item.originalBytes) {
    const blob = settings.stripMetadata ? await optimizeLosslessly(item.file) : item.file;
    return { blob, width, height };
  }
  return { blob: result, width, height };
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
  const [dragging, setDragging] = useState(false);
  const [processingAll, setProcessingAll] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [watcherSettings, setWatcherSettings] = useState<WatcherSettings>(DEFAULT_WATCHER_SETTINGS);
  const [watcherActive, setWatcherActive] = useState(false);
  const [watcherEvents, setWatcherEvents] = useState<WatcherEvent[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const compareRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<ImageItem[]>([]);
  const settingsReadyRef = useRef(false);
  const livePreviewGenerationRef = useRef(0);
  const nativeBridge = typeof window !== "undefined" ? window.picLite : undefined;

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

  const addFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/") || /\.(?:jpe?g|png|webp|avif)$/i.test(file.name));
    if (!imageFiles.length) {
      showToast("没有找到可处理的图片");
      return;
    }
    const nextItems = await Promise.all(imageFiles.map(async (file): Promise<ImageItem | null> => {
      try {
        const dimensions = await getDimensions(file);
        return { id: uid(), file, name: file.name || `clipboard-${Date.now()}.png`, type: file.type || mimeFromName(file.name), width: dimensions.width, height: dimensions.height, originalBytes: file.size, sourceUrl: URL.createObjectURL(file), status: "ready" };
      } catch {
        return null;
      }
    }));
    const validItems = nextItems.filter((item): item is ImageItem => Boolean(item));
    setItems((current) => [...current, ...validItems]);
    if (!selectedId && validItems[0]) setSelectedId(validItems[0].id);
    showToast(`已加入 ${validItems.length} 张图片`);
  }, [selectedId, showToast]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

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
      return { ...item, outputUrl: undefined, outputBlob: undefined, outputBytes: undefined, outputType: undefined, outputWidth: undefined, outputHeight: undefined, status: "ready", error: undefined };
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
        const result = await canvasCompress(item, settings);
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
            status: "done",
          };
        }));
      } catch (error) {
        if (generation !== livePreviewGenerationRef.current) return;
        setItems((current) => current.map((candidate) => candidate.id === id ? { ...candidate, status: "error", error: error instanceof Error ? error.message : "预览失败" } : candidate));
      }
    }, 220);

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
      const result = await canvasCompress(item, settings);
      const outputUrl = URL.createObjectURL(result.blob);
      setItems((current) => current.map((candidate) => {
        if (candidate.id !== id) return candidate;
        if (candidate.outputUrl) URL.revokeObjectURL(candidate.outputUrl);
        return { ...candidate, outputBlob: result.blob, outputUrl, outputBytes: result.blob.size, outputType: result.blob.type || candidate.type, outputWidth: result.width, outputHeight: result.height, status: "done" };
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

  const downloadItem = useCallback((item: ImageItem) => {
    if (!item.outputUrl) return;
    const anchor = document.createElement("a");
    anchor.href = item.outputUrl;
    anchor.download = outputName(item);
    anchor.click();
  }, []);

  const downloadAll = useCallback(() => {
    const completeItems = items.filter((item) => item.outputUrl);
    completeItems.forEach((item, index) => window.setTimeout(() => downloadItem(item), index * 160));
    showToast(`正在导出 ${completeItems.length} 张图片`);
  }, [downloadItem, items, showToast]);

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

  const handleComparePointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const box = compareRef.current?.getBoundingClientRect();
    if (!box) return;
    setCompare(Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)));
  }, []);

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
      className="app-shell"
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={onDrop}
    >
      <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/*" multiple onChange={onFilesSelected} />

      <header className="topbar">
        <button className="brand" type="button" onClick={() => setView("workspace")}>
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>PicLite</strong><small>图轻</small></span>
        </button>
        <nav className="main-nav" aria-label="主要功能">
          <button className={view === "workspace" ? "active" : ""} type="button" onClick={() => setView("workspace")}>压缩工作台</button>
          <button className={view === "watcher" ? "active" : ""} type="button" onClick={() => setView("watcher")}>文件夹监测{watcherActive && <span className="live-dot" aria-label="监测中" />}</button>
        </nav>
        <div className="topbar-actions">
          <span className="privacy-badge"><i /> 本地处理，图片不上传</span>
          <IconButton label="帮助" symbol="?" onClick={() => showToast("支持 JPG、PNG、WebP；可直接拖入或按 Ctrl + V")} />
        </div>
      </header>

      {view === "workspace" ? (
        <section className="workspace" aria-label="图片压缩工作台">
          <aside className="queue-panel">
            <div className="panel-heading">
              <div><span className="eyebrow">任务队列</span><strong>{items.length ? `${items.length} 张图片` : "等待导入"}</strong></div>
              {items.length > 0 && <button className="text-button" type="button" onClick={clearAll}>清空</button>}
            </div>

            <button className="import-button" type="button" onClick={() => fileInputRef.current?.click()}><span aria-hidden="true">＋</span> 添加图片</button>

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
                      {item.status === "done" && <><b>−{savedPercent(item.originalBytes, item.outputBytes)}%</b> {formatBytes(item.outputBytes)}</>}
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
              {selected && <div className="preview-meta"><span>{selected.width} × {selected.height}{selected.outputWidth ? ` → ${selected.outputWidth} × ${selected.outputHeight}` : ""} px</span><span>{(selected.outputType || selected.type).replace("image/", "").toUpperCase()}</span></div>}
            </div>

            <div className="preview-stage">
              {selected ? (
                <div
                  ref={compareRef}
                  className="compare-canvas"
                  onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); handleComparePointer(event); }}
                  onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) handleComparePointer(event); }}
                  aria-label="拖动查看压缩前后对比"
                >
                  <img className="compare-after" src={selected.outputUrl || selected.sourceUrl} alt="优化后预览" />
                  <div className="compare-before" style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }}><img src={selected.sourceUrl} alt="原图预览" /></div>
                  <span className="compare-label before-label">原图 · {formatBytes(selected.originalBytes)}</span>
                  <span className="compare-label after-label">实时结果 · {selected.outputBytes ? formatBytes(selected.outputBytes) : "计算中"}</span>
                  <div className="compare-handle" style={{ left: `${compare}%` }}><span>‹ ›</span></div>
                  {selected.status === "processing" && <div className="processing-overlay"><i /><strong>正在计算真实输出体积</strong></div>}
                </div>
              ) : (
                <button className="hero-dropzone" type="button" onClick={() => fileInputRef.current?.click()}>
                  <span className="drop-visual" aria-hidden="true"><i className="drop-card one" /><i className="drop-card two" /><i className="drop-card three" /><b>＋</b></span>
                  <span className="hero-copy"><span className="hero-kicker">DROP · PASTE · COMPRESS</span><strong>把图片放轻一点</strong><p>拖入图片，或点击选择本地文件</p></span>
                  <span className="supported-formats">JPG&nbsp;&nbsp; PNG&nbsp;&nbsp; WebP</span>
                </button>
              )}
            </div>

            <div className="result-strip">
              <div><span>原始体积</span><strong>{formatBytes(totals.original)}</strong></div>
              <span className="result-arrow">→</span>
              <div><span>当前实时结果</span><strong>{items.some((item) => item.outputBytes) ? formatBytes(totals.output) : "—"}</strong></div>
              <div className="savings-pill"><span>共节省</span><strong>{totals.saved}%</strong></div>
              <button className="export-button" type="button" disabled={!items.some((item) => item.outputUrl)} onClick={downloadAll}><span>↓</span> 导出全部</button>
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
                <small>{selected?.outputBytes ? `${formatBytes(selected.originalBytes)} → ${formatBytes(selected.outputBytes)} · 节省 ${savedPercent(selected.originalBytes, selected.outputBytes)}%` : "显示的是浏览器实际编码后的文件大小"}</small>
              </div>
              <p className="setting-hint"><i /> JPG / WebP 的画质滑块最明显；PNG 可配合尺寸比例，或转为 WebP。</p>
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

            <div className="setting-section compact">
              <label className="check-row"><input type="checkbox" checked={settings.stripMetadata} onChange={(event) => setSettings((current) => ({ ...current, stripMetadata: event.target.checked }))} /><span><strong>移除隐私元数据</strong><small>删除位置、相机与拍摄信息</small></span></label>
            </div>

            <div className="settings-spacer" />
            <div className="action-summary"><div><span>当前选中</span><strong>{selected?.outputBytes ? formatBytes(selected.outputBytes) : "—"}</strong></div><div><span>输出参数</span><strong>{settings.quality}% · {formatScale(settings.scale)}</strong></div></div>
            <button className="compress-button" type="button" disabled={!items.length || processingAll} onClick={processAll}><span>{processingAll ? "···" : "✦"}</span>{processingAll ? "正在应用到全部" : `按此参数应用到全部${items.length ? ` · ${items.length} 张` : ""}`}</button>
          </aside>
        </section>
      ) : (
        <section className="watcher-page">
          <div className="watcher-intro">
            <span className="section-index">02 / AUTO FLOW</span>
            <h1>放进文件夹，<br />自动<span>变轻。</span></h1>
            <p>PicLite 会静默监测新图片，完成无损优化后写入指定位置。源文件默认保持不变。</p>
            <div className="watcher-platform"><span className={nativeBridge ? "available" : ""}>{nativeBridge ? "● Windows 客户端已连接" : "◫ 需要 Windows 客户端"}</span><small>网页端受浏览器安全限制，无法持续读取本地文件夹</small></div>
          </div>

          <div className={`watcher-console ${!nativeBridge ? "locked" : ""}`}>
            {!nativeBridge && (
              <div className="console-lock"><span>▣</span><strong>在 Windows 客户端中启用</strong><p>网页端的压缩工作台仍可完整使用。文件夹监测需要安装桌面版。</p></div>
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
                {event.originalBytes && event.outputBytes ? <b>−{savedPercent(event.originalBytes, event.outputBytes)}%</b> : null}
              </div>
            )) : <div className="log-empty"><span>⌁</span><p>启动监测后，处理记录会出现在这里</p></div>}
          </div>
        </section>
      )}

      {dragging && <div className="drag-overlay" onDragLeave={() => setDragging(false)}><div><span>＋</span><strong>松开即可加入图片</strong><small>支持同时导入多张</small></div></div>}
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </main>
  );
}
