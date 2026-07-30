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
    copyImageData: (data) => invoke("copy_image_data", { data: Array.from(data) }),
    copyImagePath: (path) => invoke("copy_image_path", { path }),
    selectImages: async () => {
      const images = await invoke<EncodedImage[]>("select_images");
      return images.map((image) => ({ ...image, data: decodeBase64(image.data) }));
    },
    readImagesFromPaths: async (paths) => {
      const images = await invoke<EncodedImage[]>("read_images_from_paths", { paths });
      return images.map((image) => ({ ...image, data: decodeBase64(image.data) }));
    },
    selectFolder: (kind) => invoke<string | null>("select_folder", { kind }),
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
    revealPath: (path) => invoke("reveal_path", { path }),
    uploadImage: (payload) => invoke("upload_image", { payload: { ...payload, data: Array.from(payload.data) } }),
    updateDesktopPreferences: (preferences) => invoke("update_desktop_preferences", { preferences }),
    setWindowTheme: (theme) => currentWindow.setTheme(theme === "system" ? null : theme),
    startDragging: () => currentWindow.startDragging(),
    startResizeDragging: (direction) => currentWindow.startResizeDragging(direction),
    showMainWindow: () => invoke("show_main_window"),
    showDropzoneWindow: () => invoke("show_dropzone_window"),
    hideCurrentWindow: () => invoke("hide_current_window"),
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
  };
}
