# PicLite 图轻

面向自媒体工作人员和开发人员的本地优先图片压缩工具，支持 Windows、macOS、Linux 与可自托管 Web 端。

[English](README.en-US.md) · [下载桌面版](https://github.com/amiaoapp/PicLite/releases) · [Web 演示](https://piclite-image-optimiser.ritchiecessac4273.chatgpt.site) · [插件开发](docs/PLUGIN_DEVELOPMENT.md) · [问题反馈](https://github.com/amiaoapp/PicLite/issues)

![PicLite 工作台](public/og.png)

## 主要能力

- JPEG、PNG、WebP、GIF 导入、转换、压缩与等比例缩放
- 默认自动比较候选格式，在尽量保持观感的前提下选择更小结果
- 原图/结果对比、实时体积、连续画质与尺寸控制、文字水印
- 剪贴板监听、全局快捷键、文件夹监测与本地图库
- 类 Clop 的桌面悬浮结果：复制、预览、撤销、继续缩小、切换格式
- 结果数量上限、堆叠/展开两种悬浮布局、自动隐藏
- 覆盖源文件、同目录重命名或固定目录输出，并支持定期清理
- WebDAV、S3/R2、OSS、FTP、SFTP 图床上传
- 可加载本地 HTML/JavaScript 或 URL 工作台插件；图库与文件夹监测也可独立启停
- Tauri 2 + Rust 桌面端；图片默认只在本机处理

## 下载

在 [Releases](https://github.com/amiaoapp/PicLite/releases) 下载：

- Windows x64 / ARM64：`.exe` 或 `.msi`
- macOS Apple Silicon / Intel：`.dmg`
- Linux x64 / ARM64：`.AppImage` 或 `.deb`

macOS 构建目前为 ad-hoc 签名，首次运行可能需要在“系统设置 → 隐私与安全性”中允许打开。

## Web 与 Docker

```bash
docker run -d \
  --name piclite \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/amiaoapp/piclite:latest
```

浏览器打开 `http://服务器IP:3000`。Web 端受浏览器权限限制，不提供系统托盘、全局快捷键和持续文件夹监测。

## 本地开发

要求 Node.js 22.13+、Rust stable，以及目标平台的 Tauri 2 系统依赖。

```bash
npm install
npm run dev
npm run desktop:dev
```

验证与构建：

```bash
npm test
npm run desktop:build
```

## 隐私与许可证

图片压缩默认在浏览器或桌面客户端本地完成；只有主动使用图床上传时，文件才会发送到你配置的服务。

PicLite 使用 [GPL-3.0-or-later](LICENSE)。桌面自动化工作流借鉴并改编自 GPL 项目 [FuzzyIdeas/Clop](https://github.com/FuzzyIdeas/Clop)，PicLite 不使用 Clop 商标；详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
