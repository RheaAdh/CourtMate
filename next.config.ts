import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/__/auth/:path*',
        destination: 'https://firebaseapp.com*',
      },
    ];
  },
};

export default nextConfig;
