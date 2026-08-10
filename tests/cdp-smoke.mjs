import { writeFile } from "node:fs/promises";
import gifenc from "gifenc";

const { applyPalette, GIFEncoder, quantize } = gifenc;

const GIF_PATH = "/private/tmp/piclite-test.gif";
const SCREENSHOT_PATH = "/private/tmp/piclite-v03-test.png";

function createAnimatedGif() {
  const width = 240;
  const height = 160;
  const encoder = GIFEncoder();
  for (let frame = 0; frame < 8; frame += 1) {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const inside = x >= 18 + frame * 22 && x < 78 + frame * 22 && y >= 45 && y < 110;
        rgba[offset] = inside ? 220 : Math.round(20 + 160 * x / width);
        rgba[offset + 1] = inside ? 255 : Math.round(40 + 150 * y / height);
        rgba[offset + 2] = inside ? 80 : 125 + frame * 8;
        rgba[offset + 3] = 255;
      }
    }
    const palette = quantize(rgba, 128);
    encoder.writeFrame(applyPalette(rgba, palette), width, height, { palette, delay: 90, repeat: 0 });
  }
  encoder.finish();
  return encoder.bytes();
}

const gifBytes = createAnimatedGif();
await writeFile(GIF_PATH, gifBytes);
const pages = await fetch("http://127.0.0.1:9333/json/list").then((response) => response.json());
const page = pages.find((candidate) => candidate.type === "page" && candidate.url.includes("localhost:3000"));
if (!page) throw new Error("PicLite page not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const exceptions = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
});

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

async function setControl(selector, value) {
  return evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error("Missing control: " + ${JSON.stringify(selector)});
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value;
  })()`);
}

await send("Page.enable");
await send("DOM.enable");
await send("Runtime.enable");
await evaluate(`document.fonts.ready.then(() => ({ title: document.title, imageDecoder: typeof ImageDecoder }))`);

await evaluate(`(() => {
  [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "清空")?.click();
  document.querySelector(".reset-button")?.click();
})()`);
await delay(300);
await evaluate(`(() => {
  const demo = [...document.querySelectorAll("button")].find((button) => button.textContent.includes("载入演示图片"));
  if (demo) demo.click();
  return Boolean(demo) || Boolean(document.querySelector(".queue-item"));
})()`);
await delay(1600);
const staticBefore = await evaluate(`document.querySelector(".live-size-card strong").textContent`);
await evaluate(`document.querySelector("#watermark-toggle").click()`);
await delay(1200);
const staticAfter = await evaluate(`document.querySelector(".live-size-card strong").textContent`);
const watermarkState = await evaluate(`({
  enabled: document.querySelector("#watermark-toggle").getAttribute("aria-checked"),
  layouts: [...document.querySelectorAll(".segmented-control button")].map((button) => button.textContent),
  fontButtons: [...document.querySelectorAll(".font-picker-row button")].map((button) => button.textContent)
})`);

await evaluate(`(() => {
  const binary = atob(${JSON.stringify(Buffer.from(gifBytes).toString("base64"))});
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], "piclite-test.gif", { type: "image/gif" }));
  const input = document.querySelector('input[type="file"][accept="image/*"]');
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
})()`);
await delay(800);
await evaluate(`([...document.querySelectorAll(".queue-item")].find((item) => item.textContent.includes("piclite-test.gif"))).click()`);
await delay(3200);
const gifQuality100 = await evaluate(`(async () => ({
  size: document.querySelector(".live-size-card strong").textContent,
  status: [...document.querySelectorAll(".queue-item")].find((item) => item.textContent.includes("piclite-test.gif")).textContent,
  frames: await (async () => {
    try {
      const source = document.querySelector(".compare-after").src;
      const blob = await fetch(source).then((response) => response.blob());
      const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: "image/gif" });
      await decoder.tracks.ready;
      const count = decoder.tracks.selectedTrack.frameCount;
      decoder.close();
      return count;
    } catch (error) {
      return "decode-error: " + error.message + " · " + document.querySelector(".compare-after")?.src;
    }
  })()
}))()`);

await setControl("#quality-range", "20");
await delay(3200);
const gifQuality20 = await evaluate(`document.querySelector(".live-size-card strong").textContent`);
await setControl("#scale-range", "50");
await delay(3200);
const gifScale50 = await evaluate(`({ size: document.querySelector(".live-size-card strong").textContent, dimensions: document.querySelector(".dimension-preview strong").textContent })`);

await setControl("#export-mode", "same-folder");
const sameFolderHint = await evaluate(`document.querySelector(".export-settings .setting-hint").textContent`);
await setControl("#export-mode", "fixed-folder");
const fixedFolderUi = await evaluate(`({ picker: document.querySelector(".folder-picker-button")?.textContent, overwriteOption: !![...document.querySelectorAll("#export-mode option")].find((option) => option.value === "overwrite") })`);

await evaluate(`document.querySelector(".settings-panel").scrollTop = document.querySelector(".settings-panel").scrollHeight`);
await delay(250);
const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));

socket.close();
console.log(JSON.stringify({
  staticWatermark: { before: staticBefore, after: staticAfter, ...watermarkState },
  gif: { quality100: gifQuality100, quality20: gifQuality20, scale50: gifScale50 },
  export: { sameFolderHint, fixedFolderUi },
  exceptions,
  screenshot: SCREENSHOT_PATH,
}, null, 2));
