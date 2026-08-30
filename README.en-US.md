# PicLite

A local-first image optimiser for content creators and developers, available on Windows, macOS, Linux, and as a self-hosted web app.

[中文](README.md) · [Desktop downloads](https://github.com/amiaoapp/PicLite/releases) · [Web demo](https://amiaoapp.github.io/PicLite/) · [Plugin development](docs/PLUGIN_DEVELOPMENT.en-US.md) · [Issues](https://github.com/amiaoapp/PicLite/issues)

![PicLite workspace](public/og.png)

## Highlights

- Import, convert, optimise, and proportionally resize JPEG, PNG, WebP, and GIF files
- Automatically compare candidate formats and choose a smaller result with limited visual loss
- Before/after preview, actual output size, continuous quality and scale controls, and text watermarks
- Clipboard monitoring, global shortcuts, watched folders, and a local result library
- Clop-inspired floating results with copy, preview, undo, further downscaling, and format switching
- Configurable result limit, stacked/list layouts, and automatic dismissal
- Replace, rename beside the source, or export to a fixed folder with scheduled cleanup
- Upload to WebDAV, S3/R2, OSS, FTP, or SFTP image hosts
- Load local HTML/JavaScript or URL workbench plugins; the library and folder watcher can also be toggled independently
- Tauri 2 + Rust desktop apps; images stay on your device by default

## Download

Get the latest installers from [GitHub Releases](https://github.com/amiaoapp/PicLite/releases):

- Windows x64 / ARM64: `.exe` or `.msi`
- macOS Apple Silicon / Intel: `.dmg`
- Linux x64 / ARM64: `.AppImage` or `.deb`

The current macOS builds use ad-hoc signing. On first launch, macOS may require approval in System Settings → Privacy & Security.

## Web and Docker

The [GitHub Pages demo](https://amiaoapp.github.io/PicLite/) is a static, install-free build. Images are processed locally in your browser and are not uploaded to a server. Use the desktop app for the system tray, global shortcuts, persistent clipboard monitoring, and watched folders.

For a LAN deployment, custom domain, or your own service endpoint, run the Docker build:

```bash
docker run -d \
  --name piclite \
  -p 3456:3456 \
  --restart unless-stopped \
  ghcr.io/amiaoapp/piclite:latest
```

Open `http://SERVER_IP:3456`. Both the GitHub Pages and Docker web builds include the compression workspace; browser security restrictions prevent system-tray, global-shortcut, and persistent folder-monitoring features.

## Development

Requires Node.js 22.13+, stable Rust, and the Tauri 2 system dependencies for your target platform.

```bash
npm install
npm run dev
npm run desktop:dev
```

Test and build:

```bash
npm test
npm run desktop:build
```

## Create a workbench plugin

PicLite plugins are no longer embedded with an `iframe`. The desktop app fetches HTML/CSS/JavaScript and mounts it in a trusted workbench runtime, avoiding `X-Frame-Options` failures and allowing a custom tab name. Install only code you trust.

A minimal plugin is a single HTML file:

```html
<!doctype html>
<meta charset="utf-8">
<main id="tool">
  <h1>My image tool</h1>
  <button id="ready">Done</button>
</main>
<script>
  document.querySelector("#ready").onclick = () => {
    window.PicLitePlugin.post("ready", { ok: true });
  };
</script>
```

Open Settings → Plugins to import `.html`, `.js`, or `manifest.json`, or enter a custom name and HTTPS URL for the desktop app to fetch. Manifest example:

```json
{
  "nameZh": "封面设计大师",
  "nameEn": "Banner Maker",
  "url": "https://example.com/plugin/"
}
```

See the full [plugin development guide](docs/PLUGIN_DEVELOPMENT.en-US.md) for the runtime API, asset URL rules, and publishing notes.

## Privacy and licence

Optimisation runs locally in the browser or desktop app. Files leave your device only when you explicitly upload them to a storage provider you configured.

PicLite is licensed under [GPL-3.0-or-later](LICENSE). Its desktop automation workflow is inspired by and adapted from the GPL-licensed [FuzzyIdeas/Clop](https://github.com/FuzzyIdeas/Clop) project. PicLite does not use the Clop trademark. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
