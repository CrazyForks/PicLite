# PicLite 插件开发

PicLite 工作台插件适合封面生成器、图片标注、颜色工具和其他纯前端图片流程。1.0.1 之后不再使用 `iframe`：桌面端会读取页面源码、解析相对资源，并在 PicLite 的可信插件容器中运行。

## 安装方式

在“设置 → 插件”中可以：

- 导入 `.html`：推荐，页面、样式和脚本放在同一个文件中最稳定。
- 导入 `.js`：PicLite 自动创建 `#piclite-plugin-root` 容器。
- 导入 `manifest.json`：声明中英文名称以及内联 HTML、脚本或 URL。
- 添加网页插件：填写自定义名称和 HTTP(S) 地址，桌面端读取页面后挂载，不受 `X-Frame-Options` 限制。

URL 页面及外部资源合计应保持轻量。当前可信运行容器支持普通脚本；使用 `type="module"` 的站点需要先打包成一个普通 JavaScript 文件。

## 最小 HTML 插件

```html
<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 24px; font: 16px system-ui; }
  button { padding: 10px 16px; }
</style>
<main>
  <h1>我的图片工具</h1>
  <button id="ready">准备完成</button>
</main>
<script>
  document.querySelector("#ready").addEventListener("click", () => {
    window.PicLitePlugin.post("ready", { version: 1 });
  });
</script>
```

## JavaScript 插件

导入 `.js` 后可直接使用运行时根节点：

```js
const root = window.PicLitePlugin.root;
root.innerHTML = `<section style="padding:24px"><h1>图片工具</h1></section>`;
window.PicLitePlugin.post("mounted", { ok: true });
```

运行时对象：

```ts
window.PicLitePlugin = {
  version: "1.0.0",
  root: HTMLElement,
  post(type: string, payload?: unknown): void
}
```

## 清单格式

```json
{
  "name": "Banner Maker",
  "nameZh": "封面设计大师",
  "nameEn": "Banner Maker",
  "url": "https://example.com/plugin/"
}
```

也可将 `url` 换成 `html` 或 `script` 字段。安装后仍可在设置中重新命名，名称会作为工作台标签保存。

## 资源路径

- URL 插件中的相对 `src`、`href`、`action`、`poster` 和 CSS `url(...)` 会按照插件 URL 转为绝对地址。
- 为减少兼容问题，推荐把依赖和资源与插件部署在同一 HTTPS 域名下。
- 本地 HTML 推荐使用 data URL 或内联资源；不要依赖用户电脑上的绝对路径。

## 安全与发布

非 iframe 插件可以执行页面脚本，因此它是“可信插件”，不是安全沙箱。不要安装来源不明的代码，不要在插件中写入密钥。PicLite 图床凭证不会通过公开运行时 API 暴露给插件。

发布前请测试浅色/深色主题、窄窗口、离线提示和错误状态，并在插件仓库说明许可证、联网行为与数据处理方式。
