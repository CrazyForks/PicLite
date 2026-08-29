# PicLite 图轻

PicLite 图轻：开源跨平台本地图片动图压缩工具，智能择优压缩，本地文件夹监控，强大自定义悬浮窗。自动图片格式转换，批量压缩，添加水印，上传图床。支持 Windows、macOS、Linux 与可自托管 Web 端。
帮助自媒体工作人员和开发人员提升工作效率

[English](README.en-US.md) · [下载桌面版](https://github.com/amiaoapp/PicLite/releases) · [Web 演示](https://amiaoapp.github.io/PicLite/) · [插件开发](docs/PLUGIN_DEVELOPMENT.md) · [问题反馈](https://github.com/amiaoapp/PicLite/issues)

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

## 截图

<img width="2924" height="1602" alt="image" src="https://github.com/user-attachments/assets/2379e6d7-e1ef-444d-890f-e2ea7942abe9" />


## 下载

在 [Releases](https://github.com/amiaoapp/PicLite/releases) 下载：

- Windows x64 / ARM64：`.exe` 或 `.msi`
- macOS Apple Silicon / Intel：`.dmg`
- Linux x64 / ARM64：`.AppImage` 或 `.deb`

macOS 构建目前为 ad-hoc 签名，首次运行可能需要在“系统设置 → 隐私与安全性”中允许打开。

## Web 与 Docker

[GitHub Pages 在线 Demo](https://amiaoapp.github.io/PicLite/) 是无需安装的静态版本，图片直接在浏览器本地处理，不会上传到服务器。系统托盘、全局快捷键、剪贴板持续监听和文件夹监测等系统级功能请使用桌面端。

需要局域网访问、固定域名或自己的服务入口时，可部署 Docker 版本：

```bash
docker run -d \
  --name piclite \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/amiaoapp/piclite:latest
```

浏览器打开 `http://服务器IP:3000`。GitHub Pages 与 Docker Web 端都保留压缩工作台；受浏览器权限限制，不提供系统托盘、全局快捷键和持续文件夹监测。

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

## 创建工作台插件

PicLite 插件不再用 `iframe` 嵌入。桌面端会读取 HTML/CSS/JavaScript，并挂载到工作台的可信插件容器；因此不会被站点的 `X-Frame-Options` 阻止，也支持自定义标签名称。请只安装你信任的代码。

最小插件只需一个 HTML 文件：

```html
<!doctype html>
<meta charset="utf-8">
<main id="tool">
  <h1>我的图片工具</h1>
  <button id="ready">完成</button>
</main>
<script>
  document.querySelector("#ready").onclick = () => {
    window.PicLitePlugin.post("ready", { ok: true });
  };
</script>
```

打开“设置 → 插件”，可直接导入 `.html`、`.js` 或 `manifest.json`；也可填写自定义名称和 HTTPS 地址，由桌面端读取后运行。清单示例：

```json
{
  "nameZh": "封面设计大师",
  "nameEn": "Banner Maker",
  "url": "https://example.com/plugin/"
}
```

完整的运行时 API、资源路径规则和发布注意事项见[插件开发教程](docs/PLUGIN_DEVELOPMENT.md)。

## 隐私与许可证

图片压缩默认在浏览器或桌面客户端本地完成；只有主动使用图床上传时，文件才会发送到你配置的服务。

PicLite 使用 [GPL-3.0-or-later](LICENSE)。桌面自动化工作流借鉴并改编自 GPL 项目 [FuzzyIdeas/Clop](https://github.com/FuzzyIdeas/Clop)，PicLite 不使用 Clop 商标；详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
