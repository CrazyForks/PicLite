import type { Metadata } from "next";
import { PicLiteApp } from "./piclite-app";

export const metadata: Metadata = {
  title: "PicLite 图轻 — 图片压缩工作台",
  description:
    "在浏览器或 Windows 上批量压缩图片、调整尺寸、对比画质，并自动监测本地文件夹。",
};

export default function Home() {
  return <PicLiteApp />;
}
