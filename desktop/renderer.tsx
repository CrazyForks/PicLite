import "./tauri-bridge";
import { createRoot } from "react-dom/client";
import { PicLiteDesktopApp } from "./clop-desktop-app";
import "./clop-desktop.css";

const root = document.getElementById("root");
if (!root) throw new Error("PicLite renderer root is missing");

createRoot(root).render(<PicLiteDesktopApp />);
