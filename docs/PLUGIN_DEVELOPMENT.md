# PicLite 插件开发

PicLite 1.0 可以把一个本地 HTML、JavaScript 文件或 HTTPS 页面加载为工作台标签页。插件运行在隔离的 `iframe` 中，适合封面生成器、图片标注器、颜色工具等纯前端功能。

## 三种安装方式

在“设置 → 插件”中选择：

- 导入 `.html`：直接运行完整页面。
- 导入 `.js`：PicLite 自动创建页面，并提供 `window.PicLitePlugin`。
- 添加 URL：填写 HTTPS 地址，例如 `https://banner.xmit.dev/`。

也可以导入 JSON 清单：

```json
{
  "name": "Banner Maker",
  "nameZh": "封面生成器",
  "nameEn": "Banner Maker",
  "url": "https://banner.example.com/"
}
```

## JavaScript 插件

```js
const root = window.PicLitePlugin.root;
root.innerHTML = `
  <style>
    .card { padding: 24px; font: 16px system-ui; }
  </style>
  <section class="card">
    <h1>我的图片工具</h1>
    <button id="ready">准备完成</button>
  </section>
`;

document.querySelector("#ready").addEventListener("click", () => {
  window.PicLitePlugin.post("ready", { version: 1 });
});
```

运行时对象：

```ts
window.PicLitePlugin = {
  version: "1.0.0",
  root: HTMLElement,
  post(type: string, payload?: unknown): void
}
```

`post` 是插件向宿主发送事件的通道。1.0 仅保证事件隔离与元数据传递，插件不应依赖未公开的文件或压缩 API。

## 安全边界

- 本地插件在无 `allow-same-origin` 的沙箱中运行，不能读取 PicLite 的本地存储、图床凭证或系统文件。
- URL 插件是否可显示取决于目标站点的 `Content-Security-Policy` / `X-Frame-Options`。
- 不要在插件中嵌入密钥；需要上传时使用 PicLite 自带图床配置。
- PicLite 会记住已安装插件和启用状态，但不会自动更新第三方插件。

## 发布建议

将插件作为静态站点部署，提供 HTTPS，并在仓库中写明数据处理方式、浏览器兼容性和许可证。发布前请在浅色、深色主题及窄窗口下分别测试。
