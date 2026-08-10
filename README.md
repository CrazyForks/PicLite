# PicLite 图轻

[English](README.en-US.md) · [下载桌面版](https://github.com/amiaoapp/PicLite/releases/latest)

PicLite 是面向**自媒体工作人员和开发人员**的本地优先、跨平台媒体优化器。它常驻系统托盘或 macOS 菜单栏，自动处理拖入、复制或出现在监测目录中的图片。

> PicLite 是独立项目，不使用 Clop 的名称、商标或图标。桌面工作流和部分实现基于 GPL-3.0-or-later 项目 [FuzzyIdeas/Clop](https://github.com/FuzzyIdeas/Clop)，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 桌面平台

- Windows x64
- Windows ARM64
- macOS Apple Silicon 与 Intel
- Linux x64 与 ARM64

PicLite 现在是纯桌面项目，不再提供网页端或服务器部署版。桌面端使用 Tauri 2、Rust 和系统 WebView，不内置完整 Chromium。

## 设计目标

- 菜单栏 / 系统托盘常驻，主窗口关闭后继续工作
- 全局拖放区：把图片拖到屏幕边缘即可开始优化
- Clop 风格的紧凑悬浮结果：查看体积变化、重新优化、转换格式、预览、定位和复制
- 独立设置窗口：通用、剪贴板、文件处理、图片、拖放区、预设区域、悬浮结果、快捷键与更新
- 批量优化器：一次处理多个文件或目录
- 本地文件夹监测与剪贴板监测
- 原文件夹或指定文件夹输出，避免意外覆盖原图
- 中英文界面

## 当前重构

PicLite 正在从旧的网页式工作台重构为菜单栏优先的桌面应用。旧实现保留在 Git 历史中；新架构把批量优化器、设置、拖放区和悬浮结果拆成独立窗口。

macOS 专属系统能力会在 Windows 与 Linux 上以对应的系统能力重写，不会直接打包 macOS 的 AppKit/SwiftUI 二进制。

## 本地开发

需要 Node.js 22+、Rust stable，以及当前系统的 [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
npm install
npm run dev
```

构建当前平台安装包：

```bash
npm run build
```

仅验证桌面界面和 Rust：

```bash
npm run desktop:renderer
cargo test --manifest-path src-tauri/Cargo.toml
```

## 自动发布

推送 `v*` 标签后，GitHub Actions 会构建 Windows x64/ARM64、macOS Apple Silicon/Intel、Linux x64/ARM64 安装包并加入 GitHub Release。

## 许可证与来源

PicLite 使用 [GPL-3.0-or-later](LICENSE) 发布。基于 Clop 的部分继续遵循 GPL，并保留来源、版权与修改说明。PicLite 与 FuzzyIdeas 无关联，也未获得其背书。
