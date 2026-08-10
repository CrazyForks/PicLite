# PicLite

[中文说明](README.md) · [Download desktop builds](https://github.com/amiaoapp/PicLite/releases/latest)

PicLite is a local-first, cross-platform media optimiser for **content creators and developers**. It lives in the system tray or macOS menu bar and processes images dropped onto it, copied to the clipboard, or created in watched folders.

> PicLite is an independent project and does not use the Clop name, trademarks or icons. Its desktop workflow and parts of its implementation are based on the GPL-3.0-or-later project [FuzzyIdeas/Clop](https://github.com/FuzzyIdeas/Clop). See [Third-party notices](THIRD_PARTY_NOTICES.md).

## Desktop platforms

- Windows x64
- Windows ARM64
- macOS Apple Silicon and Intel
- Linux x64 and ARM64

PicLite is now desktop-only. The former web and self-hosted editions are no longer part of the product. The desktop app uses Tauri 2, Rust and the operating system WebView instead of bundling Chromium.

## Product direction

- Menu bar / system tray resident process
- Global drop zone at the edge of the screen
- Compact Clop-style floating results with size comparison, re-optimisation, conversion, Quick Look, reveal and copy actions
- Separate settings window for General, Clipboard, File handling, Images, Drop Zone, Preset Zones, Floating Results, Shortcuts and Updates
- Batch optimiser for multiple files and folders
- Clipboard and watched-folder automation
- Same-folder or dedicated-folder placement without accidental source replacement
- Complete Chinese and English interface

## Current rebuild

PicLite is being rebuilt from the former browser-like workbench into a menu-bar-first desktop application. The old implementation remains available in Git history. The new architecture uses separate windows for the batch optimiser, settings, drop target and floating results.

macOS-only AppKit and SwiftUI integrations are reimplemented with platform-equivalent APIs on Windows and Linux; macOS binaries are not bundled or emulated on other systems.

## Development

Install Node.js 22+, Rust stable and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system.

```bash
npm install
npm run dev
```

Build installers for the current platform:

```bash
npm run build
```

Validate the renderer and Rust core:

```bash
npm run desktop:renderer
cargo test --manifest-path src-tauri/Cargo.toml
```

## Automated releases

Pushing a `v*` tag triggers GitHub Actions builds for Windows x64/ARM64, macOS Apple Silicon/Intel and Linux x64/ARM64, then attaches the installers to a GitHub Release.

## License and provenance

PicLite is distributed under [GPL-3.0-or-later](LICENSE). Code based on Clop remains under the GPL with source, copyright and modification notices retained. PicLite is not affiliated with or endorsed by FuzzyIdeas.
