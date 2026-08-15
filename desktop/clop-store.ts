import type { DesktopSettings, ImageFormat, Language, OptimisationPreset } from "./clop-types";

const SETTINGS_KEY = "piclite.desktop.clop-settings.v1";
const MAIN_DESKTOP_PREFERENCES_KEY = "piclite.desktopPreferences.v1";
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
  renameTemplate: "{name}{suffix}",
  preserveDates: true,
  autoCleanupEnabled: false,
  autoCleanupAmount: 7,
  autoCleanupUnit: "days",
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
  shortcutsEnabled: true,
  shortcutToggleDropzone: "CommandOrControl+Alt+D",
  shortcutOptimiseClipboard: "CommandOrControl+Alt+V",
  shortcutShowMain: "CommandOrControl+Alt+P",
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
    const mainPreferences = JSON.parse(localStorage.getItem(MAIN_DESKTOP_PREFERENCES_KEY) || "{}") as Partial<{ shortcutsEnabled: boolean; shortcutDock: string; shortcutPaste: string; shortcutShow: string; renameTemplate: string }>;
    const preset = { ...DEFAULT_SETTINGS.preset, ...(parsed.preset || {}) } as OptimisationPreset;
    if (preset.mode !== "manual") preset.mode = "auto";
    if (!validFormat(preset.format)) preset.format = "keep";
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      shortcutsEnabled: typeof mainPreferences.shortcutsEnabled === "boolean" ? mainPreferences.shortcutsEnabled : parsed.shortcutsEnabled ?? DEFAULT_SETTINGS.shortcutsEnabled,
      shortcutToggleDropzone: mainPreferences.shortcutDock || parsed.shortcutToggleDropzone || DEFAULT_SETTINGS.shortcutToggleDropzone,
      shortcutOptimiseClipboard: mainPreferences.shortcutPaste || parsed.shortcutOptimiseClipboard || DEFAULT_SETTINGS.shortcutOptimiseClipboard,
      shortcutShowMain: mainPreferences.shortcutShow || parsed.shortcutShowMain || DEFAULT_SETTINGS.shortcutShowMain,
      renameTemplate: mainPreferences.renameTemplate || parsed.renameTemplate || DEFAULT_SETTINGS.renameTemplate,
      language: parsed.language === "en" ? "en" : "zh",
      preset,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: DesktopSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  try {
    const mainPreferences = JSON.parse(localStorage.getItem(MAIN_DESKTOP_PREFERENCES_KEY) || "{}") as Record<string, unknown>;
    localStorage.setItem(MAIN_DESKTOP_PREFERENCES_KEY, JSON.stringify({
      ...mainPreferences,
      shortcutsEnabled: settings.shortcutsEnabled,
      shortcutDock: settings.shortcutToggleDropzone,
      shortcutPaste: settings.shortcutOptimiseClipboard,
      shortcutShow: settings.shortcutShowMain,
      renameTemplate: settings.renameTemplate,
    }));
  } catch {
    // The floating window still owns a complete local copy when an older main-window preference is malformed.
  }
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: settings }));
}

export function subscribeSettings(callback: (settings: DesktopSettings) => void) {
  const listener = (event: Event) => callback((event as CustomEvent<DesktopSettings>).detail || loadSettings());
  const storage = (event: StorageEvent) => {
    if (event.key === SETTINGS_KEY || event.key === MAIN_DESKTOP_PREFERENCES_KEY) callback(loadSettings());
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
