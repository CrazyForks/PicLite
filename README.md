# PicLite 图轻

PicLite 是一款本地优先的图片压缩工作台，同时支持网页端和 Windows 桌面端。

## 已实现

- 拖放、多文件选择与剪贴板粘贴
- JPG / PNG 无损元数据清理
- JPG / PNG / WebP 格式转换、三档预设与 1–100% 连续画质调节
- 0.1–100% 等比例尺寸滑块、继续减半、最大宽高限制与禁止放大小图
- 滑动后自动从原图试压，执行批量处理前即可看到真实输出体积、像素和画质对比
- 批量处理、体积统计与一键导出
- Windows 文件夹监测，新图片自动使用 Sharp / jpegtran 压缩
- Windows 安装包与便携版构建工作流

网页端的处理发生在浏览器内，图片不会上传。由于浏览器安全限制，持续监测本地文件夹只在 Windows 客户端提供。

## 本地运行网页端

需要 Node.js 24（最低 22.13）。

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。

## 本地运行桌面端

先保持网页开发服务运行，再打开第二个终端：

```bash
npm run desktop:dev
```

开发模式连接 `http://localhost:3000`，通过隔离的 preload bridge 提供本地文件夹选择和监测能力。正式安装包会内置同一套界面，可离线启动。

## 构建 Windows 版本

建议在 Windows 或仓库自带的 GitHub Actions 工作流中构建：

```bash
npm run desktop:build:win
```

安装包和便携版输出到 `release/`。构建过程会先生成桌面端内置界面，因此不依赖在线网页地址。

## 压缩策略

- 无损优先：JPG 使用 jpegtran 优化编码并保留像素数据；PNG 使用 Sharp 的最高无损压缩；WebP / AVIF 使用 lossless 编码。
- 智能平衡：适合日常照片和网页素材，兼顾清晰度与体积。
- 更小体积：降低质量或使用 PNG 调色板，适合缩略图和加载性能敏感场景。
- 连续试压：画质最低可设为 1%，尺寸比例最低可设为 0.1%（最终不少于 1 × 1 像素）。每次调整都从原始文件重新编码，避免重复压缩造成累积损伤。
- PNG 画质：网页端通过颜色量化让画质滑块真实影响 PNG 体积，并保留透明通道；Windows 自动监测使用 Sharp 调色板量化。

自动监测默认将结果写入来源文件夹下的 `PicLite/`，并使用 `-piclite` 后缀，绝不覆盖源文件。

## 项目结构

- `app/`：网页与桌面端共享界面、浏览器压缩逻辑
- `desktop/`：Electron 主进程、Sharp 压缩器、文件夹监听
- `.github/workflows/build-windows.yml`：Windows 构建工作流
- `.openai/hosting.json`：网页部署配置
