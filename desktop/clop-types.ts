export type Language = "zh" | "en";
export type Appearance = "system" | "light" | "dark";
export type ResultLayout = "compact" | "full";
export type FilePlacement = "same-folder" | "fixed-folder";
export type ImageFormat = "keep" | "jpeg" | "png" | "webp";

export type OptimisationPreset = {
  quality: number;
  scale: number;
  format: ImageFormat;
  stripMetadata: boolean;
  preventLarger: boolean;
};

export type DesktopSettings = {
  language: Language;
  appearance: Appearance;
  launchAtLogin: boolean;
  showMenubarIcon: boolean;
  clipboardOptimiser: boolean;
  clipboardImageData: boolean;
  clipboardImageFiles: boolean;
  keepClipboardResults: boolean;
  filePlacement: FilePlacement;
  outputFolder: string;
  outputSuffix: string;
  preserveDates: boolean;
  stripMetadata: boolean;
  preserveColorProfile: boolean;
  enableDropZone: boolean;
  dropZoneAtCursor: boolean;
  autoCopyDropResults: boolean;
  batchThreshold: number;
  enableFloatingResults: boolean;
  floatingLayout: ResultLayout;
  floatingCorner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  autoHideResults: boolean;
  autoHideSeconds: number;
  followCursorScreen: boolean;
  showCopyClearButtons: boolean;
  hideTooltips: boolean;
  watchFolders: string[];
  pauseAutomaticOptimisations: boolean;
  preset: OptimisationPreset;
};

export type QuickCompressSettings = {
  quality: number;
  scale: number;
  format: string;
  stripMetadata: boolean;
  preventLarger: boolean;
  exportMode: string;
  exportSuffix: string;
  fixedFolder?: string;
};

export type QuickCompressResult = {
  source: string;
  output?: string;
  originalBytes?: number;
  outputBytes?: number;
  keptOriginal: boolean;
  error?: string;
};

export type WatcherSettings = {
  inputFolder: string;
  inputFolders: string[];
  outputFolder: string;
  mode: string;
  quality: number;
  scale: number;
  format: string;
  resize: boolean;
  maxWidth: number;
  maxHeight: number;
  stripMetadata: boolean;
  preventLarger: boolean;
};

export type NativeImage = { name: string; type: string; path: string; data: Uint8Array };

export type PicLiteBridge = {
  platform: string;
  windowLabel: string;
  readClipboardImage: () => Promise<{ data: Uint8Array } | null>;
  copyImageData: (data: Uint8Array) => Promise<void>;
  copyCompressedData: (data: Uint8Array, fileName: string) => Promise<string>;
  cacheImageData: (data: Uint8Array, fileName: string) => Promise<string>;
  copyImagePath: (path: string) => Promise<void>;
  selectImages: () => Promise<NativeImage[]>;
  readImagesFromPaths: (paths: string[]) => Promise<NativeImage[]>;
  selectFolder: (kind: "input" | "output" | "export") => Promise<string | null>;
  startWatcher: (settings: WatcherSettings) => Promise<{ ok: boolean; error?: string }>;
  stopWatcher: () => Promise<{ ok: boolean }>;
  getWatcherState: () => Promise<{ active: boolean; settings?: WatcherSettings }>;
  quickCompressPaths: (paths: string[], settings: QuickCompressSettings) => Promise<QuickCompressResult[]>;
  revealPath: (path: string) => Promise<void>;
  updateDesktopPreferences: (preferences: { minimizeToTray: boolean; clipboardWatcherEnabled: boolean }) => Promise<void>;
  setWindowTheme: (theme: Appearance) => Promise<void>;
  showMainWindow: () => Promise<void>;
  showGalleryWindow: () => Promise<void>;
  showPreferencesWindow: () => Promise<void>;
  showDropzoneWindow: () => Promise<void>;
  submitCornerDrop: (paths: string[]) => Promise<void>;
  takePendingCornerDrop: () => Promise<string[]>;
  configureDropzoneWindow: (width: number, height: number) => Promise<void>;
  resizeDropzoneWindow: (width: number, height: number) => Promise<void>;
  setAlwaysOnTop: (enabled: boolean) => Promise<void>;
  hideCurrentWindow: () => Promise<void>;
  quitApplication: () => Promise<void>;
  onFileDrop: (callback: (event: { type: "over" | "drop" | "leave" | "error"; paths?: string[]; error?: string }) => void) => () => void;
  onCornerDrop: (callback: () => void) => () => void;
  onTrayAction: (callback: (action: string) => void) => () => void;
  onClipboardImage: (callback: (data: Uint8Array) => void) => () => void;
  onClipboardPaths: (callback: (paths: string[]) => void) => () => void;
  onWatcherEvent: (callback: (event: { type: string; message?: string; file?: string; output?: string; originalBytes?: number; outputBytes?: number; time: number }) => void) => () => void;
  checkForUpdates: () => Promise<{ currentVersion: string; latestVersion: string; available: boolean; releaseUrl: string }>;
  openExternal: (url: string) => Promise<void>;
};

declare global {
  interface Window {
    picLite?: PicLiteBridge;
  }
}
