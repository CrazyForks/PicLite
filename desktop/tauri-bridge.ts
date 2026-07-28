import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  window.picLite = {
    platform: platformName(),
    readClipboardImage: async () => {
      const result = await invoke<{ data: string } | null>("read_clipboard_image");
      return result ? { data: decodeBase64(result.data) } : null;
    },
    selectImages: async () => {
      const images = await invoke<EncodedImage[]>("select_images");
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
