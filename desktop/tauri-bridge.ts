import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

type EncodedImage = { name: string; type: string; path: string; data: string };

function decodeBase64(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function platformName() {
  const value = navigator.userAgent.toLowerCase();
  if (value.includes("windows")) return "win32";
  if (value.includes("mac os") || value.includes("macintosh")) return "darwin";
  return "linux";
}

if ("__TAURI_INTERNALS__" in window) {
  const currentWindow = getCurrentWindow();
  const currentWebview = getCurrentWebview();
  document.documentElement.classList.add(currentWindow.label === "dropzone" ? "dropzone-root" : "desktop-root");
  window.picLite = {
    platform: platformName(),
    windowLabel: currentWindow.label,
    readClipboardImage: async () => {
      const result = await invoke<{ data: string } | null>("read_clipboard_image");
      return result ? { data: decodeBase64(result.data) } : null;
    },
    readClipboardPaths: () => invoke<string[]>("read_clipboard_paths"),
    copyImageData: (data) => invoke("copy_image_data", { data: Array.from(data) }),
    copyCompressedData: (data, fileName) => invoke("copy_compressed_data", { data: Array.from(data), fileName }),
    cacheImageData: (data, fileName) => invoke("cache_image_data", { data: Array.from(data), fileName }),
    copyImagePath: (path) => invoke("copy_image_path", { path }),
    copyText: (text) => invoke("copy_text", { text }),
    selectImages: async () => {
      const images = await invoke<EncodedImage[]>("select_images");
      return images.map((image) => ({ ...image, data: decodeBase64(image.data) }));
    },
    readImagesFromPaths: async (paths) => {
      const images = await invoke<EncodedImage[]>("read_images_from_paths", { paths });
      return images.map((image) => ({ ...image, data: decodeBase64(image.data) }));
    },
    selectFolder: (kind) => invoke<string | null>("select_folder", { kind }),
    suggestScreenshotFolder: () => invoke<string | null>("suggest_screenshot_folder"),
    exportImages: async (payload) => invoke("export_images", {
      payload: {
        ...payload,
        items: payload.items.map((item) => ({ ...item, data: Array.from(item.data) })),
      },
    }),
    startWatcher: (settings) => invoke("start_watcher", { settings }),
    stopWatcher: () => invoke("stop_watcher"),
    getWatcherState: () => invoke("get_watcher_state"),
    quickCompressPaths: (paths, settings) => invoke("quick_compress_paths", { paths, settings }),
    compressAnimationData: async (data, fileName, settings) => {
      const result = await invoke<Omit<import("./clop-types").CompressedAnimationData, "data"> & { data: string }>("compress_animation_data", { data: Array.from(data), fileName, settings });
      return { ...result, data: decodeBase64(result.data) };
    },
    configureGlobalShortcuts: (bindings) => invoke("configure_global_shortcuts", { bindings }),
    cleanupOptimisedFiles: (payload) => invoke("cleanup_optimised_files", { request: payload }),
    revealPath: (path) => invoke("reveal_path", { path }),
    openImage: (path) => invoke("open_image", { path }),
    uploadImage: (payload) => invoke("upload_image", { payload: { ...payload, data: Array.from(payload.data) } }),
    loadUploadProfile: () => invoke("load_upload_profile"),
    saveUploadProfile: (profile) => invoke("save_upload_profile", { profile }),
    loadAppProfile: () => invoke("load_app_profile"),
    saveAppProfile: (profile) => invoke("save_app_profile", { profile }),
    loadImportedFonts: async () => {
      const fonts = await invoke<Array<{ family: string; data: string }>>("load_imported_fonts");
      return fonts.map((font) => ({ family: font.family, data: decodeBase64(font.data) }));
    },
    saveImportedFont: (family, data) => invoke("save_imported_font", { payload: { family, data: Array.from(data) } }),
    listSystemFonts: () => invoke("list_system_fonts"),
    readSystemFont: async (path, faceIndex) => {
      const result = await invoke<{ data: string }>("read_system_font", { path, faceIndex });
      return { data: decodeBase64(result.data) };
    },
    updateDesktopPreferences: (preferences) => invoke("update_desktop_preferences", { preferences }),
    setWindowTheme: async (theme) => {
      await currentWindow.setTheme(theme === "system" ? null : theme);
      await invoke("set_tray_theme", { theme });
    },
    startDragging: () => currentWindow.startDragging(),
    startResizeDragging: (direction) => currentWindow.startResizeDragging(direction),
    showMainWindow: () => invoke("show_main_window"),
    showGalleryWindow: () => invoke("show_gallery_window"),
    showPreferencesWindow: () => invoke("show_preferences_window"),
    showDropzoneWindow: () => invoke("show_dropzone_window"),
    submitCornerDrop: (paths) => invoke("submit_corner_drop", { paths }),
    takePendingCornerDrop: () => invoke<string[]>("take_pending_corner_drop"),
    configureDropzoneWindow: (width, height) => invoke("configure_dropzone_window", { width, height }),
    resizeDropzoneWindow: (width, height) => invoke("resize_dropzone_window", { width, height }),
    setAlwaysOnTop: (enabled) => currentWindow.setAlwaysOnTop(enabled),
    hideCurrentWindow: () => invoke("hide_current_window"),
    quitApplication: () => invoke("quit_application"),
    checkForUpdates: () => invoke("check_for_updates"),
    openExternal: (url) => invoke("open_external_url", { url }),
    onFileDrop: (callback) => {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void currentWebview.onDragDropEvent((event) => {
        if (event.payload.type === "drop") callback({ type: "drop", paths: event.payload.paths });
        else if (event.payload.type === "over") callback({ type: "over" });
        else callback({ type: "leave" });
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      }).catch((error) => {
        if (!disposed) callback({ type: "error", error: error instanceof Error ? error.message : String(error) });
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onTrayAction: (callback) => {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void listen<string>("tray:action", (event) => callback(event.payload)).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onClipboardImage: (callback) => {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void listen<{ data: string }>("clipboard:image", (event) => callback(decodeBase64(event.payload.data))).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onClipboardPaths: (callback) => {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void listen<string[]>("clipboard:paths", (event) => callback(event.payload)).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onCornerDrop: (callback) => {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void listen("corner:drop", callback).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onWatcherEvent: (callback) => {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void listen("watcher:event", (event) => callback(event.payload as Parameters<typeof callback>[0])).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    onWindowResized: (callback) => {
      let unlisten: (() => void) | undefined;
      let disposed = false;
      void currentWindow.onResized(async (event) => {
        const size = event.payload;
        const factor = await currentWindow.scaleFactor().catch(() => 1);
        callback({ width: Math.round(size.width / factor), height: Math.round(size.height / factor) });
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
      return () => { disposed = true; unlisten?.(); };
    },
  };
} else if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  const label = new URLSearchParams(location.search).get("window") || "main";
  const noop = async () => undefined;
  window.picLite = {
    platform: platformName(),
    windowLabel: label,
    readClipboardImage: async () => null,
    readClipboardPaths: async () => [],
    copyImageData: noop,
    copyCompressedData: async (_data, fileName) => `/preview/${fileName}`,
    cacheImageData: async (_data, fileName) => `/preview/${fileName}`,
    copyImagePath: noop,
    copyText: noop,
    selectImages: async () => [],
    readImagesFromPaths: async () => [],
    selectFolder: async () => null,
    suggestScreenshotFolder: async () => null,
    exportImages: async () => ({ ok: true, paths: [] }),
    startWatcher: async () => ({ ok: true }),
    stopWatcher: async () => ({ ok: true }),
    getWatcherState: async () => ({ active: false }),
    quickCompressPaths: async () => [],
    compressAnimationData: async () => { throw new Error("Animated WebP encoding requires the desktop app"); },
    configureGlobalShortcuts: noop,
    cleanupOptimisedFiles: async () => ({ deleted: 0 }),
    revealPath: noop,
    openImage: noop,
    uploadImage: async () => ({ url: "", remotePath: "" }),
    loadUploadProfile: async () => null,
    saveUploadProfile: noop,
    loadAppProfile: async () => null,
    saveAppProfile: noop,
    loadImportedFonts: async () => [],
    saveImportedFont: noop,
    listSystemFonts: async () => [],
    readSystemFont: async () => ({ data: new Uint8Array() }),
    updateDesktopPreferences: noop,
    setWindowTheme: noop,
    startDragging: noop,
    startResizeDragging: noop,
    showMainWindow: noop,
    showGalleryWindow: noop,
    showPreferencesWindow: noop,
    showDropzoneWindow: noop,
    submitCornerDrop: noop,
    takePendingCornerDrop: async () => [],
    configureDropzoneWindow: noop,
    resizeDropzoneWindow: noop,
    setAlwaysOnTop: noop,
    hideCurrentWindow: noop,
    quitApplication: noop,
    checkForUpdates: async () => ({ currentVersion: "1.0.0", latestVersion: "1.0.0", available: false, releaseUrl: "" }),
    openExternal: noop,
    onFileDrop: () => () => undefined,
    onTrayAction: () => () => undefined,
    onClipboardImage: () => () => undefined,
    onClipboardPaths: () => () => undefined,
    onCornerDrop: () => () => undefined,
    onWatcherEvent: () => () => undefined,
    onWindowResized: () => () => undefined,
  };
}
