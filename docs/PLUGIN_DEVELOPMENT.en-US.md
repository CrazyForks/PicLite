# PicLite plugin development

Workbench plugins suit cover generators, annotators, colour tools, and other client-side image workflows. PicLite no longer uses an `iframe`: the desktop app fetches page source, resolves relative assets, and runs it in a trusted workbench runtime.

## Installation methods

Open Settings → Plugins and choose one of these options:

- Import `.html`: recommended; a single file containing page, styles, and scripts is the most reliable package.
- Import `.js`: PicLite creates a `#piclite-plugin-root` container automatically.
- Import `manifest.json`: declare English/Chinese names and inline HTML, script, or URL.
- Add a web plugin: enter a custom name and HTTP(S) URL. The desktop app fetches and mounts it without relying on `X-Frame-Options`.

Keep URL pages and their assets lightweight. The trusted runtime currently supports classic scripts; sites using `type="module"` should be bundled into one classic JavaScript file first.

## Minimal HTML plugin

```html
<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 24px; font: 16px system-ui; }
  button { padding: 10px 16px; }
</style>
<main>
  <h1>My image tool</h1>
  <button id="ready">Ready</button>
</main>
<script>
  document.querySelector("#ready").addEventListener("click", () => {
    window.PicLitePlugin.post("ready", { version: 1 });
  });
</script>
```

## JavaScript plugin

An imported `.js` file can use the runtime root directly:

```js
const root = window.PicLitePlugin.root;
root.innerHTML = `<section style="padding:24px"><h1>Image tool</h1></section>`;
window.PicLitePlugin.post("mounted", { ok: true });
```

Runtime object:

```ts
window.PicLitePlugin = {
  version: "1.0.0",
  root: HTMLElement,
  post(type: string, payload?: unknown): void
}
```

## Manifest format

```json
{
  "name": "Banner Maker",
  "nameZh": "封面设计大师",
  "nameEn": "Banner Maker",
  "url": "https://example.com/plugin/"
}
```

`url` may be replaced by an `html` or `script` field. A plugin can still be renamed after installation; the saved name becomes its workbench tab label.

## Asset URLs

- Relative `src`, `href`, `action`, `poster`, and CSS `url(...)` references in a URL plugin are resolved against the plugin URL.
- Host dependencies and assets on the same HTTPS origin to minimise compatibility issues.
- For local HTML, prefer data URLs or inline assets; do not rely on absolute paths on the user's computer.

## Security and publishing

A non-iframe plugin can execute page scripts, so it is trusted code rather than a security sandbox. Do not install untrusted code or embed secrets. PicLite image-host credentials are not exposed through the public runtime API.

Before publishing, test light and dark themes, narrow windows, offline messaging, and error states. Document the plugin's licence, network access, and data handling in its repository.
