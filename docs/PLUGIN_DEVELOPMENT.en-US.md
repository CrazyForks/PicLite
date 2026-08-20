# PicLite plugin development

PicLite 1.0 can load a local HTML file, a JavaScript file, or an HTTPS page as a workbench tab. Plugins run inside an isolated `iframe`, which suits client-side tools such as banner makers, annotators, and colour utilities.

## Installation formats

Open Settings → Plugins and choose one of these options:

- Import `.html` to run a complete page.
- Import `.js`; PicLite creates the page and exposes `window.PicLitePlugin`.
- Add an HTTPS URL, for example `https://banner.xmit.dev/`.

A JSON manifest is also supported:

```json
{
  "name": "Banner Maker",
  "nameZh": "封面生成器",
  "nameEn": "Banner Maker",
  "url": "https://banner.example.com/"
}
```

## JavaScript plugin

```js
const root = window.PicLitePlugin.root;
root.innerHTML = `
  <style>.card { padding: 24px; font: 16px system-ui; }</style>
  <section class="card">
    <h1>My image tool</h1>
    <button id="ready">Ready</button>
  </section>
`;

document.querySelector("#ready").addEventListener("click", () => {
  window.PicLitePlugin.post("ready", { version: 1 });
});
```

Runtime object:

```ts
window.PicLitePlugin = {
  version: "1.0.0",
  root: HTMLElement,
  post(type: string, payload?: unknown): void
}
```

`post` is the event channel from the plugin to the host. Version 1.0 guarantees isolation and metadata delivery only; plugins should not depend on unpublished file or optimisation APIs.

## Security model

- Local plugins run without `allow-same-origin`, so they cannot read PicLite storage, image-host credentials, or system files.
- URL plugins may be blocked by the target site's `Content-Security-Policy` or `X-Frame-Options`.
- Do not embed secrets in a plugin. Use PicLite's image-host configuration for uploads.
- PicLite remembers installed plugins and their enabled state, but it does not auto-update third-party plugins.

## Publishing checklist

Host the plugin as a static HTTPS site and document its data handling, browser compatibility, and licence. Test light and dark themes plus narrow windows before publishing.
