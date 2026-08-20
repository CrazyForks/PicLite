import sharp from "sharp";
import { fileURLToPath } from "node:url";

function traySvg(card, plus) {
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <g fill="${card}">
        <rect x="7" y="17" width="34" height="34" rx="9" opacity=".42" transform="rotate(-9 24 34)"/>
        <rect x="16" y="12" width="34" height="34" rx="9" opacity=".68" transform="rotate(8 33 29)"/>
        <rect x="10" y="7" width="39" height="39" rx="11"/>
      </g>
      <circle cx="39" cy="16" r="3.2" fill="${plus}"/>
      <path d="M17 38 25 29l6 6 6-8 8 11Z" fill="${plus}" opacity=".72"/>
      <path d="M47 43v16M39 51h16" fill="none" stroke="${plus}" stroke-width="5" stroke-linecap="round"/>
    </svg>
  `);
}

await sharp(traySvg("#ffffff", "#111615")).png().toFile(fileURLToPath(new URL("../src-tauri/icons/tray-light.png", import.meta.url)));
await sharp(traySvg("#111615", "#ffffff")).png().toFile(fileURLToPath(new URL("../src-tauri/icons/tray-dark.png", import.meta.url)));
