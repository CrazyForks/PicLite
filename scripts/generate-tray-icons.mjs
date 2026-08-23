import sharp from "sharp";
import { fileURLToPath } from "node:url";

function traySvg(card, plus) {
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="3" y="3" width="58" height="58" rx="15" fill="${card}"/>
      <circle cx="47" cy="16" r="4" fill="${plus}"/>
      <path d="M12 47 24 32l9 9 9-12 12 18Z" fill="${plus}" opacity=".72"/>
      <path d="M51 45v14M44 52h14" fill="none" stroke="${plus}" stroke-width="4.5" stroke-linecap="round"/>
    </svg>
  `);
}

await sharp(traySvg("#ffffff", "#111615")).png().toFile(fileURLToPath(new URL("../src-tauri/icons/tray-light.png", import.meta.url)));
await sharp(traySvg("#111615", "#ffffff")).png().toFile(fileURLToPath(new URL("../src-tauri/icons/tray-dark.png", import.meta.url)));
