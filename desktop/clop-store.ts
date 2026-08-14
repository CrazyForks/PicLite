import type { DesktopSettings, ImageFormat, Language, OptimisationPreset } from "./clop-types";

const SETTINGS_KEY = "piclite.desktop.clop-settings.v1";
const SETTINGS_EVENT = "piclite:settings-changed";

export const DEFAULT_SETTINGS: DesktopSettings = {
  language: "zh",
  appearance: "system",
  launchAtLogin: false,
  showMenubarIcon: true,
  clipboardOptimiser: true,
  clipboardImageData: true,
  clipboardImageFiles: true,
  keepClipboardResults: false,
  filePlacement: "same-folder",
  outputFolder: "",
  outputSuffix: "-piclite",
  preserveDates: true,
  stripMetadata: true,
  preserveColorProfile: true,
  enableDropZone: true,
  dropZoneAtCursor: false,
  autoCopyDropResults: false,
  batchThreshold: 30,
  enableFloatingResults: true,
  floatingLayout: "compact",
  floatingCorner: "bottom-right",
  autoHideResults: true,
  autoHideSeconds: 10,
  followCursorScreen: true,
  showCopyClearButtons: true,
  hideTooltips: false,
  watchFolders: [],
  pauseAutomaticOptimisations: false,
  preset: {
    mode: "auto",
    quality: 86,
    scale: 100,
    format: "keep",
    stripMetadata: true,
    preventLarger: true,
  },
};

function validFormat(value: unknown): value is ImageFormat {
  return value === "keep" || value === "jpeg" || value === "png" || value === "webp";
}

export function loadSettings(): DesktopSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Partial<DesktopSettings>;
    const preset = { ...DEFAULT_SETTINGS.preset, ...(parsed.preset || {}) } as OptimisationPreset;
    if (preset.mode !== "manual") preset.mode = "auto";
    if (!validFormat(preset.format)) preset.format = "keep";
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      language: parsed.language === "en" ? "en" : "zh",
      preset,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: DesktopSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: settings }));
}

export function subscribeSettings(callback: (settings: DesktopSettings) => void) {
  const listener = (event: Event) => callback((event as CustomEvent<DesktopSettings>).detail || loadSettings());
  const storage = (event: StorageEvent) => {
    if (event.key === SETTINGS_KEY) callback(loadSettings());
  };
  window.addEventListener(SETTINGS_EVENT, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(SETTINGS_EVENT, listener);
    window.removeEventListener("storage", storage);
  };
}

export function tr(language: Language, zh: string, en: string) {
  return language === "zh" ? zh : en;
}

export function toNativeFormat(format: ImageFormat) {
  if (format === "keep") return "keep";
  return `image/${format}`;
}

export function formatBytes(value?: number) {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}
