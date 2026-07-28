import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 生成可直接由 Node.js 运行的最小产物，供 Docker 与服务器部署使用。
  output: "standalone",
};

export default nextConfig;
