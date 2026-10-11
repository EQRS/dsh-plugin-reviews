import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 本切片不做 standalone 打包（属部署阶段）；仅保证本机 dev / build 可用。
  reactStrictMode: true,
  typedRoutes: false,
};

export default nextConfig;
