import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/__/auth/:path*',
        // Fixed: Switched from firebaseapp.com to web.app to prevent Vercel 502/DNS errors
        destination: 'https://web.app*',
      },
    ];
  },
};

export default nextConfig;
