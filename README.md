# PicLite 图轻

![PicLite 图轻](public/og.png)

[![Build desktop apps](https://github.com/amiaoapp/PicLite/actions/workflows/release-desktop.yml/badge.svg)](https://github.com/amiaoapp/PicLite/actions/workflows/release-desktop.yml)
[![GitHub release](https://img.shields.io/github/v/release/amiaoapp/PicLite?display_name=tag)](https://github.com/amiaoapp/PicLite/releases)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-43853d)](https://nodejs.org/)

PicLite 是一款本地优先、可自托管的图片与 GIF 压缩工作台，支持 Web、Windows、macOS 和 Linux。它可以在执行前实时预估输出体积，并用连续的画质和尺寸控制把文件压到你需要的大小。

[在线体验](https://piclite-image.zwistidjaa331.chatgpt.site) · [下载桌面版](https://github.com/amiaoapp/PicLite/releases) · [报告问题](https://github.com/amiaoapp/PicLite/issues)

![PicLite 压缩、水印与导出界面](docs/images/piclite-workspace.png)

## 功能

- 拖放、多文件选择和剪贴板粘贴导入
- JPG / PNG 无损元数据清理与编码优化
- JPG / PNG / WebP 格式转换，1–100% 连续画质调节
- 动态 GIF 逐帧压缩，保留动画并连续控制色板质量和尺寸
- 0.1–100% 等比例缩放、继续减半、最大宽高和禁止放大小图
- 每次滑动都从原图重新试压，在执行前显示真实输出体积、像素和前后画质对比
- 文字水印：本地字体、角度、字号、透明度、缩放、密度、全屏平铺、自由位置和阴影
- 下载、覆盖源文件、同文件夹重命名、固定文件夹四种导出模式
- 桌面端持续监测本地文件夹，新图片自动用 Sharp / jpegtran 压缩
- Docker 自托管和 GitHub Actions 跨平台自动构建

图片处理在浏览器或桌面客户端本地完成，不会把原图上传到 PicLite 服务器。网页端受浏览器权限限制，持续文件夹监测只在桌面客户端提供。

## 下载桌面版

进入 [GitHub Releases](https://github.com/amiaoapp/PicLite/releases) 下载对应文件：

| 系统 | 架构 | 文件 |
| --- | --- | --- |
| Windows | x64 | 安装版 `.exe` 或便携版 `.exe` |
| macOS | Apple Silicon（M1/M2/M3/M4…） | `arm64.dmg` |
| macOS | Intel | `x64.dmg` |
| Linux | x64 | `x86_64.AppImage` 或 `amd64.deb` |
| Linux | arm64 | `arm64.AppImage` 或 `arm64.deb` |

当前 macOS 包没有 Apple 开发者签名。首次打开时，如果系统提示无法验证开发者，请在“系统设置 → 隐私与安全性”中确认打开。正式公开分发建议配置 Apple Developer ID 签名与公证。

## 在服务器上部署

推荐使用 Ubuntu 22.04/24.04、Docker Compose、Nginx 和 HTTPS。服务器只负责提供页面；图片仍在访问者的浏览器中本地处理。

![PicLite 服务器部署结构](docs/images/deployment.svg)

### 方式一：Docker Compose（推荐）

#### 1. 准备服务器

先通过 SSH 登录服务器：

```bash
ssh 你的用户名@服务器IP
```

安装 Git 和 Nginx：

```bash
sudo apt update
sudo apt install -y git nginx
```

按照 [Docker 官方 Ubuntu 安装教程](https://docs.docker.com/engine/install/ubuntu/) 安装 Docker Engine，并按照 [Compose 插件教程](https://docs.docker.com/compose/install/linux/) 安装 `docker compose`。安装后检查：

```bash
docker --version
docker compose version
```

如果当前用户没有 Docker 权限，可先用 `sudo docker ...`，或按 Docker 官方文档把用户加入 `docker` 用户组后重新登录。

#### 2. 下载 PicLite

```bash
sudo mkdir -p /opt/piclite
sudo chown "$USER":"$USER" /opt/piclite
git clone https://github.com/amiaoapp/PicLite.git /opt/piclite
cd /opt/piclite
```

#### 3. 构建并启动

```bash
docker compose up -d --build
docker compose ps
```

`docker-compose.yml` 默认只把服务开放到服务器本机的 `127.0.0.1:3000`，避免绕过 Nginx 直接暴露应用。先在服务器内检查：

```bash
curl -I http://127.0.0.1:3000
docker compose logs --tail=100 piclite
```

如果状态是 `200`，说明 PicLite 已正常运行。

#### 4. 绑定域名

先在域名服务商处添加一条 `A` 记录，指向服务器公网 IP。然后复制仓库内的 Nginx 模板：

```bash
cd /opt/piclite
sed 's/piclite.example.com/piclite.你的域名.com/g' deploy/nginx/piclite.conf \
  | sudo tee /etc/nginx/sites-available/piclite >/dev/null
sudo ln -s /etc/nginx/sites-available/piclite /etc/nginx/sites-enabled/piclite
sudo nginx -t
sudo systemctl reload nginx
```

把命令中的 `piclite.你的域名.com` 换成真实域名。如果 `/etc/nginx/sites-enabled/piclite` 已存在，不需要重复创建软链接。

#### 5. 开启 HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d piclite.你的域名.com
```

完成后访问 `https://piclite.你的域名.com`。剪贴板、字体和文件夹写入等浏览器能力通常要求 HTTPS 或 localhost，因此正式部署应开启 HTTPS。

#### 6. 更新版本

以后发布新代码，只需在服务器运行：

```bash
cd /opt/piclite
git pull --ff-only origin main
docker compose up -d --build --remove-orphans
docker image prune -f
```

查看日志与停止服务：

```bash
docker compose logs -f piclite
docker compose down
```

PicLite 不保存用户图片，也没有数据库或持久化目录，因此无需备份图片数据；只需备份你修改过的 Nginx、域名和部署配置。

### 方式二：Node.js + systemd

不使用 Docker 时，在服务器安装 Node.js 24（最低 22.13），然后执行：

```bash
sudo mkdir -p /opt/piclite
sudo chown "$USER":"$USER" /opt/piclite
git clone https://github.com/amiaoapp/PicLite.git /opt/piclite
cd /opt/piclite
npm ci
npm run build
node dist/standalone/server.js
```

生产环境可使用仓库附带的 systemd 服务。确认 `/usr/bin/node` 是正确的 Node.js 路径后运行：

```bash
sudo useradd --system --home /opt/piclite --shell /usr/sbin/nologin piclite || true
sudo chown -R piclite:piclite /opt/piclite
sudo cp /opt/piclite/deploy/systemd/piclite.service /etc/systemd/system/piclite.service
sudo systemctl daemon-reload
sudo systemctl enable --now piclite
sudo systemctl status piclite
```

Nginx 和 HTTPS 配置与 Docker 方式相同。

### 用 GitHub Actions 一键更新服务器（可选）

仓库内的 `Deploy web app to server` 工作流可通过 SSH 执行 `git pull` 和 `docker compose up`。在 GitHub 仓库进入 `Settings → Secrets and variables → Actions`，添加：

| Secret | 内容 |
| --- | --- |
| `SERVER_HOST` | 服务器 IP 或域名 |
| `SERVER_USER` | SSH 用户名 |
| `SERVER_PATH` | 项目目录，例如 `/opt/piclite` |
| `SERVER_SSH_KEY` | GitHub Actions 使用的 SSH 私钥全文 |
| `SERVER_KNOWN_HOSTS` | 服务器的 SSH host key |

`SERVER_KNOWN_HOSTS` 可在可信网络中用下面的命令生成，并核对服务器指纹后再保存：

```bash
ssh-keyscan -H 你的服务器IP
```

设置完成后打开仓库的 `Actions → Deploy web app to server → Run workflow`。工作流默认不会在每次提交时自动部署，避免误操作；需要时手动点击即可。

## 本地运行网页端

需要 Node.js 24（最低 22.13）：

```bash
git clone https://github.com/amiaoapp/PicLite.git
cd PicLite
npm install
npm run dev
```

打开 `http://localhost:3000`。

## 本地运行桌面端

先保持网页开发服务运行，再打开第二个终端：

```bash
npm run desktop:dev
```

开发模式连接本机网页服务，通过隔离的 preload bridge 提供本地文件夹选择和监测。正式安装包内置同一套界面，可以离线启动。

## 构建 Windows、macOS 和 Linux

先安装依赖：

```bash
npm ci
```

然后在对应系统运行：

```bash
# Windows：安装版 + 便携版
npm run desktop:build:win

# macOS：当前机器架构，输出 DMG + ZIP
npm run desktop:build:mac

# macOS：指定架构
npm run desktop:build:mac:arm64
npm run desktop:build:mac:x64

# Linux：当前机器架构，输出 AppImage + deb
npm run desktop:build:linux

# Linux：指定架构
npm run desktop:build:linux:arm64
npm run desktop:build:linux:x64
```

产物位于 `release/`。含原生依赖的桌面应用最好在目标操作系统构建；仓库的 GitHub Actions 会分别使用 Windows、macOS 和 Linux 原生 runner。

### 自动生成 GitHub Release

推送版本标签后，GitHub Actions 会构建五组桌面产物，并自动创建 Release：

```bash
git tag v0.4.1
git push origin v0.4.1
```

只想测试构建、不发布版本时，在 GitHub 的 `Actions → Build desktop apps → Run workflow` 手动运行。手动运行的文件会保存在该次工作流的 Artifacts 中。

## 压缩策略

- **无损优先**：JPG 使用 jpegtran 优化编码并保留像素；PNG 使用最高无损压缩；WebP / AVIF 使用 lossless 编码。
- **智能平衡**：适合日常照片和网页素材，兼顾清晰度与体积。
- **更小体积**：降低质量或使用 PNG 调色板，适合缩略图和加载性能敏感场景。
- **连续试压**：画质最低 1%，尺寸最低 0.1%（最终不少于 1 × 1 像素）。每次都从原始文件重新编码，避免重复压缩造成累积损伤。
- **PNG 画质**：网页端通过颜色量化让画质滑块真实影响 PNG 体积，并保留透明通道；自动监测使用 Sharp 调色板量化。
- **GIF 画质**：网页端逐帧重新生成 2–256 色色板；桌面自动监测通过 Sharp 控制色板、抖动和帧间误差。

## 导出说明

- **浏览器下载**：兼容性最好，不需要文件夹权限。
- **覆盖源文件**：需要从“添加图片”按钮导入并授权写入；为避免扩展名与内容不一致，只允许保持原格式。
- **原文件夹重命名**：桌面端自动定位每张源图的文件夹；网页端需要手动授权目标文件夹。
- **固定文件夹**：选择一次输出目录后，批量结果统一写入，并使用可编辑的文件名后缀。

自动监测默认把结果写入来源文件夹下的 `PicLite/`，使用 `-piclite` 后缀，不覆盖源文件。

## 项目结构

```text
app/                         Web 与桌面共享界面、浏览器压缩逻辑
desktop/                     Electron、Sharp 压缩器、文件夹监听
deploy/nginx/                Nginx 反向代理模板
deploy/systemd/              Node.js systemd 服务模板
.github/workflows/           跨平台构建、Release、服务器部署
Dockerfile                   Web 多阶段生产镜像
docker-compose.yml           自托管启动与健康检查
```

## 隐私说明

Web 版通过浏览器的 Canvas、WebCodecs 和文件系统能力本地处理图片；服务器只提供静态资源和应用代码。桌面版同样在设备本地处理，不内置图片上传接口。
