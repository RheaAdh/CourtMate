import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: '/__/auth/:path*',
        destination: 'https://firebaseapp.com*',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
