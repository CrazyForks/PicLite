import { useCallback, useEffect, useRef, useState } from "react";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { Icon } from "./clop-icons";
import { fileName, formatBytes, loadSettings, saveSettings, subscribeSettings, toNativeFormat, tr } from "./clop-store";
import type { DesktopSettings, ImageFormat, Language, OptimisationPreset, PicLiteBridge, QuickCompressResult } from "./clop-types";

type ResultItem = QuickCompressResult & {
  id: string;
  preview?: string;
  width?: number;
  height?: number;
  history?: ResultItem[];
  status: "working" | "done" | "error";
};

const bridge = window.picLite as unknown as PicLiteBridge | undefined;

function useDesktopSettings() {
  const [settings, setSettingsState] = useState(loadSettings);
  useEffect(() => subscribeSettings(setSettingsState), []);
  const setSettings = useCallback((next: DesktopSettings | ((current: DesktopSettings) => DesktopSettings)) => {
    setSettingsState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      saveSettings(value);
      return value;
    });
  }, []);
  return [settings, setSettings] as const;
}

function T({ language, zh, en }: { language: Language; zh: string; en: string }) {
  return <>{tr(language, zh, en)}</>;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button type="button" className={`clop-switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><i /></button>;
}

function Select<T extends string>({ value, onChange, children, label }: { value: T; onChange: (value: T) => void; children: React.ReactNode; label: string }) {
  return <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>{children}</select>;
}

function percentage(item: QuickCompressResult) {
  if (!item.originalBytes || item.outputBytes == null) return null;
  return Math.round((1 - item.outputBytes / item.originalBytes) * 100);
}

function nativeSettings(settings: DesktopSettings) {
  const automatic = settings.preset.mode === "auto";
  return {
    mode: automatic ? "auto" : "manual",
    quality: automatic ? 86 : settings.preset.quality,
    scale: automatic ? 100 : settings.preset.scale,
    format: automatic ? "keep" : toNativeFormat(settings.preset.format),
    stripMetadata: settings.preset.stripMetadata,
    preventLarger: settings.preset.preventLarger,
    exportMode: settings.filePlacement,
    exportSuffix: settings.outputSuffix,
    fixedFolder: settings.outputFolder || undefined,
  };
}

async function attachPreviews(items: ResultItem[], api: PicLiteBridge) {
  const paths = items.flatMap((item) => item.output ? [item.output] : []);
  if (!paths.length) return items;
  try {
    const images = await api.readImagesFromPaths(paths);
    const byPath = new Map(images.map((image) => [image.path, image]));
    const withPreviews = items.map((item) => {
      const image = item.output ? byPath.get(item.output) : undefined;
      if (!image) return item;
      const blob = new Blob([image.data.slice().buffer as ArrayBuffer], { type: image.type });
      const preview = URL.createObjectURL(blob);
      return { ...item, preview };
    });
    return await Promise.all(withPreviews.map(async (item) => {
      if (!item.preview) return item;
      try {
        const bitmap = await createImageBitmap(await (await fetch(item.preview)).blob());
        const detailed = { ...item, width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return detailed;
      } catch {
        return item;
      }
    }));
  } catch {
    return items;
  }
}

function useOptimiser(api: PicLiteBridge | undefined, settings: DesktopSettings) {
  const [results, setResults] = useState<ResultItem[]>([]);
  const [working, setWorking] = useState(false);

  const optimise = useCallback(async (paths: string[], replace = false, overrides: Partial<OptimisationPreset> = {}) => {
    if (!api || !paths.length) return [] as ResultItem[];
    const effectiveSettings = { ...settings, preset: { ...settings.preset, ...overrides } };
    const unique = [...new Set(paths)];
    setWorking(true);
    const placeholders: ResultItem[] = unique.map((source) => ({ id: `${source}-${Date.now()}-${Math.random()}`, source, keptOriginal: false, status: "working" }));
    setResults((current) => replace ? placeholders : [...placeholders, ...current]);
    try {
      const output = await api.quickCompressPaths(unique, nativeSettings(effectiveSettings));
      const finished = await attachPreviews(output.map((item, index) => ({ ...item, id: placeholders[index].id, status: item.error ? "error" : "done" })), api);
      setResults((current) => current.map((item) => finished.find((candidate) => candidate.id === item.id) || item));
      return finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResults((current) => current.map((item) => placeholders.some((candidate) => candidate.id === item.id) ? { ...item, status: "error", error: message } : item));
      return [] as ResultItem[];
    } finally {
      setWorking(false);
    }
  }, [api, settings]);

  const reoptimise = useCallback(async (item: ResultItem, overrides: Partial<OptimisationPreset> = {}) => {
    if (!api || item.status === "working") return;
    const source = item.output || item.source;
    const effectiveSettings = { ...settings, preset: { ...settings.preset, ...overrides } };
    setWorking(true);
    setResults((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, source, status: "working", error: undefined } : candidate));
    try {
      const [output] = await api.quickCompressPaths([source], nativeSettings(effectiveSettings));
      if (!output) throw new Error(tr(settings.language, "没有生成压缩结果", "No optimised result was created"));
      const snapshot: ResultItem = { ...item, history: undefined };
      const [next] = await attachPreviews([{ ...output, id: item.id, status: output.error ? "error" : "done" }], api);
      const finished = { ...next, history: [...(item.history || []), snapshot] };
      setResults((current) => current.map((candidate) => {
        if (candidate.id !== item.id) return candidate;
        return finished;
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResults((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: "error", error: message } : candidate));
    } finally {
      setWorking(false);
    }
  }, [api, settings]);

  const remove = useCallback((id: string) => setResults((current) => {
    const target = current.find((item) => item.id === id);
    if (target?.preview) URL.revokeObjectURL(target.preview);
    return current.filter((item) => item.id !== id);
  }), []);

  const clear = useCallback(() => setResults((current) => {
    current.forEach((item) => item.preview && URL.revokeObjectURL(item.preview));
    return [];
  }), []);

  return { results, setResults, optimise, reoptimise, remove, clear, working };
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`piclite-brand ${compact ? "compact" : ""}`}><span className="piclite-symbol"><i /><i /><i /></span>{!compact && <strong>PicLite</strong>}</div>;
}

function DropSurface({ language, active, compact = false }: { language: Language; active: boolean; compact?: boolean }) {
  return <div className={`drop-surface ${active ? "active" : ""} ${compact ? "compact" : ""}`}>
    <span className="drop-rings"><i /><i /><i /></span>
    {!compact && <><strong><T language={language} zh="拖到这里优化" en="Drop to optimise" /></strong><small><T language={language} zh="图片将在本机处理" en="Images stay on this device" /></small></>}
  </div>;
}

function CornerDropTarget({ api }: { api: PicLiteBridge }) {
  const [settings] = useDesktopSettings();
  const [active, setActive] = useState(false);
  useEffect(() => api.onFileDrop((event) => {
    setActive(event.type === "over");
    if (event.type === "drop" && event.paths?.length) void api.submitCornerDrop(event.paths);
  }), [api]);
  if (!settings.enableDropZone) return null;
  return <main className="corner-drop-root"><DropSurface language={settings.language} active={active} compact /></main>;
}

function ResultActions({ item, api, settings, onDownscale, onUndo, onToggleControls }: { item: ResultItem; api: PicLiteBridge; settings: DesktopSettings; onDownscale: () => void; onUndo: () => void; onToggleControls: () => void }) {
  const language = settings.language;
  const copy = async () => {
    if (item.output) await api.copyImagePath(item.output);
  };
  return <div className="result-actions">
    <button title={tr(language, "再缩小一半", "Downscale by half again")} onClick={onDownscale}><Icon name="minus" /></button>
    <button disabled={!item.history?.length} title={tr(language, "撤销上一次压缩", "Undo last optimisation")} onClick={onUndo}><Icon name="undo" /></button>
    <button title={tr(language, "调整参数", "Adjust parameters")} onClick={onToggleControls}><Icon name="sliders" /></button>
    <button title={tr(language, "复制优化结果", "Copy optimised result")} onClick={() => void copy()}><Icon name="copy" /></button>
    <button title={tr(language, "预览结果", "Quick Look")} onClick={() => item.output && api.revealPath(item.output)}><Icon name="eye" /></button>
    <button title={tr(language, "在文件夹中显示", "Show in folder")} onClick={() => item.output && api.revealPath(item.output)}><Icon name="folder" /></button>
  </div>;
}

function resultFormat(item: ResultItem) {
  const extension = fileName(item.output || item.source).split(".").pop()?.toLowerCase();
  return extension === "jpg" ? "jpeg" : extension;
}

function FormatBar({ value, update }: { value?: string; update: (format: ImageFormat) => void }) {
  return <div className="format-bar">
    {(["keep", "jpeg", "webp", "png"] as ImageFormat[]).map((format) => <button key={format} className={(format === "keep" ? value === "auto" : value === format) ? "active" : ""} onClick={(event) => { event.stopPropagation(); update(format); }}>{format === "keep" ? "AUTO" : format.toUpperCase()}</button>)}
  </div>;
}

function ResultCard({ item, api, settings, active, controlsOpen, remove, select, downscale, undo, toggleControls, updateFormat, updateManual }: { item: ResultItem; api: PicLiteBridge; settings: DesktopSettings; active: boolean; controlsOpen: boolean; remove: () => void; select: () => void; downscale: () => void; undo: () => void; toggleControls: () => void; updateFormat: (format: ImageFormat) => void; updateManual: (value: Partial<OptimisationPreset>) => void }) {
  const saved = percentage(item);
  const format = resultFormat(item);
  return <article className={`result-card ${settings.floatingLayout} ${item.status} ${active ? "active" : ""}`} onClick={select}>
    <div className="result-preview">
      {item.preview ? <img src={item.preview} alt={fileName(item.source)} /> : <Icon name={item.status === "working" ? "spark" : "image"} />}
      <div className="result-overlay">
        <strong className="result-name" title={fileName(item.source)}>{fileName(item.source)}</strong>
        {item.status === "working" ? <><span className="result-state"><T language={settings.language} zh="正在自动选择最优结果…" en="Choosing the best result…" /></span><div className="progress"><i /></div></> : item.error ? <span className="result-error">{item.error}</span> : <>
          <div className="result-metrics"><b>{formatBytes(item.originalBytes)}</b><span>→</span><b>{formatBytes(item.outputBytes)}</b>{saved != null && <em className={saved < 0 ? "bad" : ""}>{saved > 0 ? `−${saved}%` : saved === 0 ? "0%" : `+${Math.abs(saved)}%`}</em>}</div>
          {(item.width && item.height) ? <small className="result-dimensions"><Icon name="image" /> {item.width.toLocaleString()} × {item.height.toLocaleString()}</small> : null}
          <FormatBar value={settings.preset.mode === "auto" && item.keptOriginal ? "auto" : format} update={updateFormat} />
        </>}
      </div>
    </div>
    <button className="result-close" title={tr(settings.language, "移除", "Dismiss")} onClick={(event) => { event.stopPropagation(); remove(); }}><Icon name="close" /></button>
    {active && item.status === "done" && <section className="result-control-deck" onClick={(event) => event.stopPropagation()}>
      <ResultActions item={item} api={api} settings={settings} onDownscale={downscale} onUndo={undo} onToggleControls={toggleControls} />
      {controlsOpen && <div className="result-parameters">
        <label><span><T language={settings.language} zh="画质" en="Quality" /></span><b>{settings.preset.quality}%</b><input type="range" min="30" max="100" value={settings.preset.quality} onChange={(event) => updateManual({ mode: "manual", quality: Number(event.target.value) })} /></label>
        <label><span><T language={settings.language} zh="尺寸" en="Scale" /></span><b>{settings.preset.scale}%</b><input type="range" min="5" max="100" value={settings.preset.scale} onChange={(event) => updateManual({ mode: "manual", scale: Number(event.target.value) })} /></label>
      </div>}
    </section>}
  </article>;
}

function FloatingResults({ api }: { api: PicLiteBridge }) {
  const [settings, setSettings] = useDesktopSettings();
  const { results, setResults, optimise, reoptimise, remove, clear, working } = useOptimiser(api, settings);
  const [dragging, setDragging] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [controlsId, setControlsId] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const parameterTimer = useRef<number | null>(null);

  const handlePending = useCallback(async () => {
    const paths = await api.takePendingCornerDrop();
    if (paths.length) await optimise(paths);
  }, [api, optimise]);

  useEffect(() => {
    void api.configureDropzoneWindow(settings.floatingLayout === "compact" ? 390 : 370, settings.floatingLayout === "compact" ? 440 : 590);
  }, [api, settings.floatingLayout]);
  useEffect(() => api.onCornerDrop(() => void handlePending()), [api, handlePending]);
  useEffect(() => { void handlePending(); }, [handlePending]);
  useEffect(() => api.onFileDrop((event) => {
    setDragging(event.type === "over");
    if (event.type === "drop" && event.paths?.length) void optimise(event.paths);
  }), [api, optimise]);
  useEffect(() => api.onClipboardPaths((paths) => {
    if (!settings.clipboardOptimiser || !settings.clipboardImageFiles || settings.pauseAutomaticOptimisations) return;
    void api.showDropzoneWindow().then(() => optimise(paths, !settings.keepClipboardResults));
  }), [api, optimise, settings.clipboardImageFiles, settings.clipboardOptimiser, settings.keepClipboardResults, settings.pauseAutomaticOptimisations]);
  useEffect(() => api.onClipboardImage((data) => {
    if (!settings.clipboardOptimiser || !settings.clipboardImageData || settings.pauseAutomaticOptimisations) return;
    void api.cacheImageData(data, `clipboard-${Date.now()}.png`).then((path) => api.showDropzoneWindow().then(() => optimise([path], !settings.keepClipboardResults)));
  }), [api, optimise, settings.clipboardImageData, settings.clipboardOptimiser, settings.keepClipboardResults, settings.pauseAutomaticOptimisations]);
  useEffect(() => api.onWatcherEvent((event) => {
    if (event.type !== "success" || !event.file || !event.output) return;
    const item: ResultItem = {
      id: `watch-${event.time}-${event.output}`,
      source: event.file,
      output: event.output,
      originalBytes: event.originalBytes,
      outputBytes: event.outputBytes,
      keptOriginal: false,
      status: "done",
    };
    void attachPreviews([item], api).then((items) => setResults((current) => [...items, ...current]));
  }), [api, setResults]);
  useEffect(() => api.onTrayAction((action) => {
    if (action !== "optimise_clipboard" && action !== "optimise_clipboard_aggressive" && action !== "downscale_clipboard") return;
    void api.readClipboardImage().then(async (image) => {
      if (!image) return;
      const path = await api.cacheImageData(image.data, `clipboard-${Date.now()}.png`);
      const overrides: Partial<OptimisationPreset> = action === "optimise_clipboard_aggressive"
        ? { mode: "manual", quality: 45 }
        : action === "downscale_clipboard"
          ? { mode: "manual", scale: Math.max(10, Math.round(settings.preset.scale / 2)) }
          : {};
      if (Object.keys(overrides).length) setSettings((current) => ({ ...current, preset: { ...current.preset, ...overrides } }));
      await optimise([path], !settings.keepClipboardResults, overrides);
    });
  }), [api, optimise, setSettings, settings.keepClipboardResults, settings.preset.scale]);
  useEffect(() => {
    if (!settings.autoHideResults || !results.length || working) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void api.hideCurrentWindow(), Math.max(1, settings.autoHideSeconds) * 1000);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [api, results.length, settings.autoHideResults, settings.autoHideSeconds, working]);

  const updateFormat = async (item: ResultItem, format: ImageFormat) => {
    setSettings((current) => ({ ...current, preset: { ...current.preset, mode: format === "keep" ? "auto" : "manual", format, scale: format === "keep" ? 100 : current.preset.scale } }));
    await reoptimise(item, { mode: format === "keep" ? "auto" : "manual", format, scale: format === "keep" ? 100 : settings.preset.scale, preventLarger: format === "keep" });
  };
  const undo = (item: ResultItem) => setResults((current) => current.map((candidate) => {
    if (candidate.id !== item.id || !candidate.history?.length) return candidate;
    const restored = candidate.history[candidate.history.length - 1];
    if (candidate.preview && candidate.preview !== restored.preview) URL.revokeObjectURL(candidate.preview);
    return { ...restored, history: candidate.history.slice(0, -1) };
  }));
  const updateManual = (item: ResultItem, value: Partial<OptimisationPreset>) => {
    setSettings((current) => ({ ...current, preset: { ...current.preset, ...value, mode: "manual" } }));
    if (parameterTimer.current) window.clearTimeout(parameterTimer.current);
    parameterTimer.current = window.setTimeout(() => void reoptimise(item, { ...value, mode: "manual", preventLarger: false }), 420);
  };
  return <main className={`floating-results ${settings.floatingLayout}`} onMouseEnter={() => timer.current && window.clearTimeout(timer.current)}>
    {!results.length ? <button className="floating-empty" onClick={() => void api.showMainWindow()}><DropSurface language={settings.language} active={dragging} /><span><T language={settings.language} zh="点击打开完整工作台" en="Click to open the full workbench" /></span></button> : <>
      <div className="floating-list">{results.map((item, index) => {
        const active = selectedId ? selectedId === item.id : index === 0;
        return <ResultCard key={item.id} item={item} api={api} settings={settings} active={active} controlsOpen={controlsId === item.id} select={() => setSelectedId(item.id)} remove={() => remove(item.id)} downscale={() => void reoptimise(item, { mode: "manual", scale: 50, preventLarger: false })} undo={() => undo(item)} toggleControls={() => setControlsId((current) => current === item.id ? null : item.id)} updateFormat={(format) => void updateFormat(item, format)} updateManual={(value) => updateManual(item, value)} />;
      })}</div>
      <footer className="floating-footer">
        <span className="automatic-badge"><Icon name="spark" /><T language={settings.language} zh="首次自动择优" en="Smart first pass" /></span>
        <div><button title={tr(settings.language, "打开完整工作台", "Open full workbench")} onClick={() => void api.showMainWindow()}><Icon name="menu" /></button>{settings.showCopyClearButtons && <button title={tr(settings.language, "清空", "Clear all")} onClick={clear}><Icon name="close" /></button>}</div>
      </footer>
    </>}
    <button className="floating-resize-handle" aria-label={tr(settings.language, "调整悬浮窗大小", "Resize floating window")} title={tr(settings.language, "拖动调整大小", "Drag to resize")} onPointerDown={(event) => { event.preventDefault(); void api.startResizeDragging("SouthEast"); }} />
  </main>;
}

function BatchOptimiser({ api }: { api: PicLiteBridge }) {
  const [settings] = useDesktopSettings();
  const { results, optimise, remove, clear, working } = useOptimiser(api, settings);
  const [dragging, setDragging] = useState(false);
  useEffect(() => api.onFileDrop((event) => {
    setDragging(event.type === "over");
    if (event.type === "drop" && event.paths?.length) void optimise(event.paths);
  }), [api, optimise]);
  useEffect(() => api.onTrayAction((action) => {
    if (action === "preferences") void api.showPreferencesWindow();
    if (action === "dropzone") void api.showDropzoneWindow();
  }), [api]);
  const choose = async () => {
    const files = await api.selectImages();
    await optimise(files.map((file) => file.path));
  };
  return <main className="batch-window">
    <header className="batch-toolbar"><Brand /><div className="window-title"><T language={settings.language} zh="批量优化器" en="Batch optimiser" /></div><div className="toolbar-actions"><button title={tr(settings.language, "设置", "Settings")} onClick={() => void api.showPreferencesWindow()}><Icon name="gear" /></button></div></header>
    <section className={`batch-drop ${dragging ? "active" : ""}`} onDoubleClick={() => void choose()}>
      <DropSurface language={settings.language} active={dragging} />
      <button className="primary" onClick={() => void choose()}><Icon name="plus" /><T language={settings.language} zh="选择图片" en="Choose images" /></button>
    </section>
    <section className="batch-table">
      <header><span><T language={settings.language} zh="文件" en="File" /></span><span><T language={settings.language} zh="原始" en="Original" /></span><span><T language={settings.language} zh="结果" en="Result" /></span><span><T language={settings.language} zh="节省" en="Saved" /></span><span /></header>
      {!results.length ? <div className="batch-empty"><Icon name="image" /><T language={settings.language} zh="拖入图片或点击“选择图片”开始" en="Drop images or choose files to begin" /></div> : results.map((item) => <div className="batch-row" key={item.id}>
        <span className="batch-name">{item.preview ? <img src={item.preview} alt="" /> : <Icon name="image" />}<span><strong>{fileName(item.source)}</strong><small>{item.status === "working" ? tr(settings.language, "正在优化", "Optimising") : item.error || fileName(item.output || "")}</small></span></span>
        <span>{formatBytes(item.originalBytes)}</span><span>{formatBytes(item.outputBytes)}</span><span className="saved">{percentage(item) == null ? "—" : `${percentage(item)}%`}</span><span className="row-actions"><button disabled={!item.output} title={tr(settings.language, "显示文件", "Reveal")} onClick={() => item.output && void api.revealPath(item.output)}><Icon name="folder" /></button><button title={tr(settings.language, "移除", "Remove")} onClick={() => remove(item.id)}><Icon name="close" /></button></span>
      </div>)}
    </section>
    <footer className="batch-status"><span>{working ? tr(settings.language, "正在处理…", "Working…") : tr(settings.language, `完成 ${results.filter((item) => item.status === "done").length} / ${results.length}`, `Done ${results.filter((item) => item.status === "done").length} / ${results.length}`)}</span><div className="progress"><i style={{ width: results.length ? `${results.filter((item) => item.status !== "working").length / results.length * 100}%` : "0%" }} /></div><button disabled={!results.length} onClick={clear}><T language={settings.language} zh="停止并清空" en="Stop and clear" /></button></footer>
  </main>;
}

type SettingsSection = "general" | "clipboard" | "files" | "images" | "dropzone" | "zones" | "floating" | "shortcuts" | "updates" | "about";

const settingsNav: Array<{ id: SettingsSection; icon: string; zh: string; en: string; group?: string }> = [
  { id: "general", icon: "gear", zh: "通用", en: "General" },
  { id: "clipboard", icon: "clipboard", zh: "剪贴板", en: "Clipboard" },
  { id: "files", icon: "folder", zh: "文件处理", en: "File handling" },
  { id: "images", icon: "image", zh: "图片", en: "Images", group: "types" },
  { id: "dropzone", icon: "drop", zh: "拖放区", en: "Drop Zone", group: "results" },
  { id: "zones", icon: "zones", zh: "预设区域", en: "Preset Zones" },
  { id: "floating", icon: "results", zh: "悬浮结果", en: "Floating Results" },
  { id: "shortcuts", icon: "shortcut", zh: "键盘快捷键", en: "Keyboard Shortcuts", group: "automation" },
  { id: "updates", icon: "spark", zh: "更新", en: "Updates", group: "support" },
  { id: "about", icon: "info", zh: "关于", en: "About" },
];

function SettingsRow({ title, note, children }: { title: React.ReactNode; note?: React.ReactNode; children: React.ReactNode }) {
  return <div className="settings-row"><div><strong>{title}</strong>{note && <small>{note}</small>}</div><div className="settings-control">{children}</div></div>;
}

function SettingsCard({ title, note, children }: { title?: React.ReactNode; note?: React.ReactNode; children: React.ReactNode }) {
  return <section className="settings-block">{title && <header><h2>{title}</h2>{note && <p>{note}</p>}</header>}<div className="settings-card">{children}</div></section>;
}

function Preferences({ api }: { api: PicLiteBridge }) {
  const [settings, setSettings] = useDesktopSettings();
  const [section, setSection] = useState<SettingsSection>("general");
  const [updateText, setUpdateText] = useState("");
  const [watchStatus, setWatchStatus] = useState("");
  const language = settings.language;
  const patch = <K extends keyof DesktopSettings>(key: K, value: DesktopSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const patchPreset = (value: Partial<DesktopSettings["preset"]>) => setSettings((current) => ({ ...current, preset: { ...current.preset, ...value } }));
  useEffect(() => { void isAutostartEnabled().then((value) => patch("launchAtLogin", value)).catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void api.setWindowTheme(settings.appearance); void api.updateDesktopPreferences({ minimizeToTray: true, clipboardWatcherEnabled: settings.clipboardOptimiser }); }, [api, settings.appearance, settings.clipboardOptimiser]);
  useEffect(() => api.onWatcherEvent((event) => setWatchStatus(event.message || event.type)), [api]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (settings.pauseAutomaticOptimisations || !settings.watchFolders.length) {
        void api.stopWatcher();
        return;
      }
      void api.startWatcher({
        inputFolder: settings.watchFolders[0],
        inputFolders: settings.watchFolders,
        outputFolder: settings.filePlacement === "fixed-folder" ? settings.outputFolder : "@same-folder",
        mode: settings.preset.mode === "auto" ? "balanced" : settings.preset.quality >= 96 ? "lossless" : settings.preset.quality >= 65 ? "balanced" : "small",
        quality: settings.preset.quality,
        scale: settings.preset.scale,
        format: toNativeFormat(settings.preset.format),
        resize: false,
        maxWidth: 4_294_967_295,
        maxHeight: 4_294_967_295,
        stripMetadata: settings.preset.stripMetadata,
        preventLarger: settings.preset.preventLarger,
      }).then((result) => setWatchStatus(result.ok ? tr(language, `正在监测 ${settings.watchFolders.length} 个目录`, `Watching ${settings.watchFolders.length} folder(s)`) : result.error || ""));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [api, language, settings.filePlacement, settings.outputFolder, settings.pauseAutomaticOptimisations, settings.preset, settings.watchFolders]);

  const toggleAutostart = async (value: boolean) => {
    if (value) await enableAutostart(); else await disableAutostart();
    patch("launchAtLogin", value);
  };
  const chooseOutput = async () => {
    const path = await api.selectFolder("export");
    if (path) patch("outputFolder", path);
  };
  const checkUpdates = async () => {
    setUpdateText(tr(language, "正在检查…", "Checking…"));
    try {
      const info = await api.checkForUpdates();
      setUpdateText(info.available ? tr(language, `发现新版本 ${info.latestVersion}`, `Version ${info.latestVersion} is available`) : tr(language, `已经是最新版 ${info.currentVersion}`, `PicLite ${info.currentVersion} is up to date`));
    } catch (error) {
      setUpdateText(String(error));
    }
  };

  return <main className="preferences-window">
    <aside className="settings-sidebar"><Brand />
      <nav>{settingsNav.map((item) => {
        const marker = item.group ? <span className="nav-group" key={`${item.group}-label`}>{item.group === "types" ? tr(language, "文件类型", "File types") : item.group === "results" ? tr(language, "拖放与结果", "Drops & Results") : item.group === "automation" ? tr(language, "快捷键与自动化", "Shortcuts & Automation") : tr(language, "支持", "Support")}</span> : null;
        return <span className="nav-entry" key={item.id}>{marker}<button className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}><Icon name={item.icon} /><span>{tr(language, item.zh, item.en)}</span></button></span>;
      })}</nav>
    </aside>
    <div className="settings-content">
      {section === "general" && <>
        <SettingsCard title={<T language={language} zh="通用" en="General" />}>
          <SettingsRow title={<T language={language} zh="语言" en="Language" />}><div className="segmented"><button className={language === "zh" ? "active" : ""} onClick={() => patch("language", "zh")}>中文</button><button className={language === "en" ? "active" : ""} onClick={() => patch("language", "en")}>English</button></div></SettingsRow>
          <SettingsRow title={<T language={language} zh="外观" en="Appearance" />}><Select label={tr(language, "外观", "Appearance")} value={settings.appearance} onChange={(value) => patch("appearance", value)}><option value="system">{tr(language, "跟随系统", "System")}</option><option value="light">{tr(language, "浅色", "Light")}</option><option value="dark">{tr(language, "深色", "Dark")}</option></Select></SettingsRow>
          <SettingsRow title={<T language={language} zh="登录时启动" en="Launch at login" />}><Switch label="launch" checked={settings.launchAtLogin} onChange={(value) => void toggleAutostart(value)} /></SettingsRow>
          <SettingsRow title={<T language={language} zh="暂停自动优化" en="Pause automatic optimisations" />} note={<T language={language} zh="保留菜单栏功能，但暂停监测和自动处理" en="Keep PicLite running without automatic processing" />}><Switch label="pause" checked={settings.pauseAutomaticOptimisations} onChange={(value) => patch("pauseAutomaticOptimisations", value)} /></SettingsRow>
        </SettingsCard>
        <SettingsCard title={<T language={language} zh="优化" en="Optimisation" />}>
          <SettingsRow title={<T language={language} zh="移除 EXIF 元数据" en="Strip EXIF metadata" />} note={<T language={language} zh="移除位置、相机、日期等可识别信息" en="Remove location, camera, date and other identifiable metadata" />}><Switch label="metadata" checked={settings.stripMetadata} onChange={(value) => { patch("stripMetadata", value); patchPreset({ stripMetadata: value }); }} /></SettingsRow>
          <SettingsRow title={<T language={language} zh="保留色彩配置" en="Preserve colour profile" />} note={<T language={language} zh="转换格式时尽量保持视觉颜色一致" en="Keep visual colours consistent across conversions" />}><Switch label="color" checked={settings.preserveColorProfile} onChange={(value) => patch("preserveColorProfile", value)} /></SettingsRow>
          <SettingsRow title={<T language={language} zh="避免优化后变大" en="Never make files larger" />}><Switch label="larger" checked={settings.preset.preventLarger} onChange={(value) => patchPreset({ preventLarger: value })} /></SettingsRow>
        </SettingsCard>
      </>}
      {section === "clipboard" && <SettingsCard title={<T language={language} zh="剪贴板" en="Clipboard" />} note={<T language={language} zh="自动监测复制的图片并优化" en="Watch copied images and optimise them automatically" />}>
        <SettingsRow title={<T language={language} zh="启用剪贴板优化器" en="Enable clipboard optimiser" />}><Switch label="clipboard" checked={settings.clipboardOptimiser} onChange={(value) => patch("clipboardOptimiser", value)} /></SettingsRow>
        <SettingsRow title={<T language={language} zh="图片数据" en="Image data" />} note={<T language={language} zh="截图和从应用中复制的像素数据" en="Screenshots and pixels copied from applications" />}><Switch label="image data" checked={settings.clipboardImageData} onChange={(value) => patch("clipboardImageData", value)} /></SettingsRow>
        <SettingsRow title={<T language={language} zh="图片文件" en="Image files" />} note={<T language={language} zh="从文件管理器复制的图片路径" en="Image paths copied from the file manager" />}><Switch label="files" checked={settings.clipboardImageFiles} onChange={(value) => patch("clipboardImageFiles", value)} /></SettingsRow>
        <SettingsRow title={<T language={language} zh="保留所有剪贴板结果" en="Keep all clipboard results" />} note={<T language={language} zh="每次复制生成独立结果，不替换上一次" en="Append each result instead of replacing the previous one" />}><Switch label="keep" checked={settings.keepClipboardResults} onChange={(value) => patch("keepClipboardResults", value)} /></SettingsRow>
      </SettingsCard>}
      {section === "files" && <SettingsCard title={<T language={language} zh="图片文件处理" en="Image file handling" />}>
        <SettingsRow title={<T language={language} zh="优化文件位置" en="Optimised file placement" />} note={<T language={language} zh="原图保留不变，优化结果写入所选位置" en="Keep originals and write optimised results to the selected location" />}><Select label="placement" value={settings.filePlacement} onChange={(value) => patch("filePlacement", value)}><option value="same-folder">{tr(language, "原文件夹", "Same folder as original")}</option><option value="fixed-folder">{tr(language, "指定文件夹", "Specific folder")}</option></Select></SettingsRow>
        <SettingsRow title={<T language={language} zh="文件名后缀" en="Filename suffix" />}><input value={settings.outputSuffix} onChange={(event) => patch("outputSuffix", event.target.value)} placeholder="-piclite" /></SettingsRow>
        {settings.filePlacement === "fixed-folder" && <SettingsRow title={<T language={language} zh="输出目录" en="Output folder" />}><button className="path-button" onClick={() => void chooseOutput()}>{settings.outputFolder || tr(language, "选择文件夹…", "Choose folder…")}</button></SettingsRow>}
        <SettingsRow title={<T language={language} zh="保留创建和修改日期" en="Preserve creation and modification dates" />}><Switch label="dates" checked={settings.preserveDates} onChange={(value) => patch("preserveDates", value)} /></SettingsRow>
      </SettingsCard>}
      {section === "images" && <>
        <SettingsCard title={<T language={language} zh="图片优化规则" en="Image optimisation rules" />}>
          <SettingsRow title={<T language={language} zh="智能首次优化" en="Smart first pass" />} note={<T language={language} zh="保持原尺寸，实测高质量原格式、WebP、JPEG/PNG，自动采用最小且有实际收益的结果" en="Keep original dimensions, test high-quality source, WebP and JPEG/PNG candidates, then use the smallest meaningful result" />}><Switch label="automatic optimisation" checked={settings.preset.mode === "auto"} onChange={(value) => patchPreset({ mode: value ? "auto" : "manual", format: value ? "keep" : settings.preset.format, scale: value ? 100 : settings.preset.scale })} /></SettingsRow>
          <SettingsRow title={<T language={language} zh="压缩质量" en="Compression quality" />} note={settings.preset.mode === "auto" ? tr(language, "自动", "Automatic") : `${settings.preset.quality}%`}><input disabled={settings.preset.mode === "auto"} type="range" min="5" max="100" value={settings.preset.quality} onChange={(event) => patchPreset({ mode: "manual", quality: Number(event.target.value) })} /></SettingsRow>
          <SettingsRow title={<T language={language} zh="缩放" en="Downscale" />} note={settings.preset.mode === "auto" ? "100%" : `${settings.preset.scale}%`}><input disabled={settings.preset.mode === "auto"} type="range" min="5" max="100" value={settings.preset.scale} onChange={(event) => patchPreset({ mode: "manual", scale: Number(event.target.value) })} /></SettingsRow>
          <SettingsRow title={<T language={language} zh="输出格式" en="Output format" />}><Select label="format" value={settings.preset.mode === "auto" ? "keep" : settings.preset.format} onChange={(value) => patchPreset({ mode: value === "keep" ? "auto" : "manual", format: value, scale: value === "keep" ? 100 : settings.preset.scale })}><option value="keep">{tr(language, "自动择优", "Automatic best format")}</option><option value="jpeg">JPEG</option><option value="webp">WebP</option><option value="png">PNG</option></Select></SettingsRow>
        </SettingsCard>
        <SettingsCard title={<T language={language} zh="监测路径" en="Watch paths" />} note={watchStatus || <T language={language} zh="图片出现在这些目录时自动优化" en="Optimise images as they appear in these folders" />}>
          <div className="watch-list">{settings.watchFolders.length ? settings.watchFolders.map((path) => <div key={path}><Icon name="folder" /><span>{path}</span><button onClick={() => patch("watchFolders", settings.watchFolders.filter((item) => item !== path))}><Icon name="minus" /></button></div>) : <p><T language={language} zh="尚未添加监测目录" en="No watched folders" /></p>}</div>
          <button className="add-path" onClick={async () => { const path = await api.selectFolder("input"); if (path && !settings.watchFolders.includes(path)) patch("watchFolders", [...settings.watchFolders, path]); }}><Icon name="plus" /><T language={language} zh="添加目录" en="Add folder" /></button>
        </SettingsCard>
      </>}
      {section === "dropzone" && <SettingsCard title={<T language={language} zh="拖放区" en="Drop zone" />} note={<T language={language} zh="把文件拖到全局区域即可优化" en="Drag files onto a global zone to optimise them" />}>
        <SettingsRow title={<T language={language} zh="启用拖放区" en="Enable drop zone" />}><Switch label="drop" checked={settings.enableDropZone} onChange={(value) => patch("enableDropZone", value)} /></SettingsRow>
        <SettingsRow title={<T language={language} zh="自动复制优化结果" en="Auto copy optimised files" />} note={<T language={language} zh="处理完成后可立即粘贴到其他应用" en="Paste results immediately after optimisation" />}><Switch label="copy" checked={settings.autoCopyDropResults} onChange={(value) => patch("autoCopyDropResults", value)} /></SettingsRow>
        <SettingsRow title={<T language={language} zh="批量模式阈值" en="Batch mode threshold" />} note={<T language={language} zh="超过此数量时改用批量窗口" en="Use the batch window above this file count" />}><span className="number-field"><input type="number" min="2" max="500" value={settings.batchThreshold} onChange={(event) => patch("batchThreshold", Math.max(2, Number(event.target.value)))} /> {tr(language, "个文件", "files")}</span></SettingsRow>
        <div className="dropzone-demo"><DropSurface language={language} active /></div>
      </SettingsCard>}
      {section === "zones" && <SettingsCard title={<T language={language} zh="预设区域" en="Preset zones" />} note={<T language={language} zh="将不同参数固定成四个快速拖放目标" en="Assign four quick drop targets to different presets" />}><div className="preset-zone-grid">{[0, 1, 2, 3].map((value) => <button key={value}><Icon name={value === 0 ? "plus" : "zones"} /><span>{value === 0 ? tr(language, "添加预设", "Add preset") : tr(language, "暂无预设", "No preset")}</span></button>)}</div></SettingsCard>}
      {section === "floating" && <SettingsCard title={<T language={language} zh="悬浮结果" en="Floating results" />} note={<T language={language} zh="优化结束后在桌面边缘显示结果卡片" en="Show result cards at the edge of the desktop" />}>
        <SettingsRow title={<T language={language} zh="显示悬浮结果" en="Show floating results" />}><Switch label="floating" checked={settings.enableFloatingResults} onChange={(value) => patch("enableFloatingResults", value)} /></SettingsRow>
        <SettingsRow title={<T language={language} zh="屏幕位置" en="Position on screen" />}><Select label="corner" value={settings.floatingCorner} onChange={(value) => patch("floatingCorner", value)}><option value="bottom-right">{tr(language, "右下角", "Bottom right")}</option><option value="bottom-left">{tr(language, "左下角", "Bottom left")}</option><option value="top-right">{tr(language, "右上角", "Top right")}</option><option value="top-left">{tr(language, "左上角", "Top left")}</option></Select></SettingsRow>
        <SettingsRow title={<T language={language} zh="布局" en="Layout" />}><div className="segmented"><button className={settings.floatingLayout === "compact" ? "active" : ""} onClick={() => patch("floatingLayout", "compact")}>{tr(language, "紧凑", "Compact")}</button><button className={settings.floatingLayout === "full" ? "active" : ""} onClick={() => patch("floatingLayout", "full")}>{tr(language, "完整", "Full")}</button></div></SettingsRow>
        <SettingsRow title={<T language={language} zh="自动隐藏" en="Auto hide" />}><Switch label="hide" checked={settings.autoHideResults} onChange={(value) => patch("autoHideResults", value)} /></SettingsRow>
        <SettingsRow title={<T language={language} zh="结果保留时间" en="Dismiss result after" />}><span className="number-field"><input type="number" min="1" max="300" value={settings.autoHideSeconds} onChange={(event) => patch("autoHideSeconds", Math.max(1, Number(event.target.value)))} /> {tr(language, "秒", "seconds")}</span></SettingsRow>
        <div className="floating-preview"><ResultCard item={{ id: "preview", source: "example-photo.jpg", output: "example-photo-piclite.webp", originalBytes: 750000, outputBytes: 211000, keptOriginal: false, status: "done", width: 1920, height: 1080 }} api={api} settings={settings} active controlsOpen={false} select={() => undefined} remove={() => undefined} downscale={() => undefined} undo={() => undefined} toggleControls={() => undefined} updateFormat={() => undefined} updateManual={() => undefined} /></div>
      </SettingsCard>}
      {section === "shortcuts" && <SettingsCard title={<T language={language} zh="键盘快捷键" en="Keyboard shortcuts" />}><SettingsRow title={<T language={language} zh="优化剪贴板" en="Optimise clipboard" />}><kbd>{api.platform === "darwin" ? "⌥⌘C" : "Ctrl+Alt+C"}</kbd></SettingsRow><SettingsRow title={<T language={language} zh="激进优化" en="Optimise aggressively" />}><kbd>{api.platform === "darwin" ? "⌥⌘A" : "Ctrl+Alt+A"}</kbd></SettingsRow><SettingsRow title={<T language={language} zh="缩小剪贴板图片" en="Downscale clipboard image" />}><kbd>{api.platform === "darwin" ? "⌥⌘−" : "Ctrl+Alt+-"}</kbd></SettingsRow><SettingsRow title="Quick Look"><kbd>{api.platform === "darwin" ? "⌥⌘Space" : "Ctrl+Alt+Space"}</kbd></SettingsRow></SettingsCard>}
      {section === "updates" && <SettingsCard title={<T language={language} zh="更新" en="Updates" />}><SettingsRow title={<T language={language} zh="检查 GitHub Releases" en="Check GitHub Releases" />} note={updateText}><button className="settings-button" onClick={() => void checkUpdates()}><T language={language} zh="检查更新" en="Check for updates" /></button></SettingsRow></SettingsCard>}
      {section === "about" && <SettingsCard title={<T language={language} zh="关于 PicLite" en="About PicLite" />}><div className="about-pane"><Brand /><p><T language={language} zh="面向自媒体工作人员和开发人员的本地优先跨平台媒体优化工具。" en="A local-first, cross-platform media optimiser for content creators and developers." /></p><small>GPL-3.0-or-later · Tauri 2 + Rust</small><p><T language={language} zh="工作流与部分实现基于 GPL 项目 Clop；PicLite 使用独立名称、图标和跨平台实现。" en="Workflow and parts of the implementation are based on the GPL-licensed Clop project. PicLite uses its own name, icons and cross-platform implementation." /></p><button className="settings-button" onClick={() => void api.openExternal("https://github.com/amiaoapp/PicLite")}><T language={language} zh="打开 GitHub" en="Open GitHub" /></button></div></SettingsCard>}
    </div>
  </main>;
}

export function PicLiteDesktopApp() {
  if (!bridge) return <div className="fatal">PicLite desktop bridge is unavailable.</div>;
  if (bridge.windowLabel === "preferences") return <Preferences api={bridge} />;
  if (bridge.windowLabel === "dropzone") return <FloatingResults api={bridge} />;
  if (bridge.windowLabel === "corner-drop-target") return <CornerDropTarget api={bridge} />;
  return <BatchOptimiser api={bridge} />;
}
