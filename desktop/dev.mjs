import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
process.env.ELECTRON_CACHE ||= path.resolve("work/electron-cache");
const electronBinary = require("electron");
const child = spawn(electronBinary, ["."], {
  stdio: "inherit",
  env: { ...process.env, PICLITE_WEB_URL: process.env.PICLITE_WEB_URL || "http://localhost:3000" },
});

child.on("exit", (code) => process.exit(code ?? 0));
