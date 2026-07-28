import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PicLiteApp } from "../app/piclite-app";
import "../app/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("PicLite renderer root is missing");

createRoot(root).render(
  <StrictMode>
    <PicLiteApp />
  </StrictMode>,
);
