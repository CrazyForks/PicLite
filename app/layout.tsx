import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  return {
    metadataBase,
    title: { default: "PicLite 图轻", template: "%s · PicLite 图轻" },
    description: "本地优先的图片压缩工作台。支持无损优化、尺寸调整、前后对比、剪贴板导入与 Windows 文件夹监测。",
    applicationName: "PicLite 图轻",
    openGraph: {
      title: "PicLite 图轻",
      description: "清晰，轻一点。浏览器与 Windows 上的本地图片压缩工作台。",
      type: "website",
      images: [{ url: "/og.png", width: 1731, height: 909, alt: "PicLite 图轻 — 清晰，轻一点。" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "PicLite 图轻",
      description: "清晰，轻一点。浏览器与 Windows 上的本地图片压缩工作台。",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
