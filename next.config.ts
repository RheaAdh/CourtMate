import type { NextConfig } from "next";

const firebaseAuthHost = "https://mttn-portal.firebaseapp.com";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  async rewrites() {
    // Firebase's popup/redirect helpers must be served from the configured auth domain.
    return [
      { source: "/__/auth/:path*", destination: `${firebaseAuthHost}/__/auth/:path*` },
      { source: "/__/firebase/:path*", destination: `${firebaseAuthHost}/__/firebase/:path*` },
    ];
  },
};

export default nextConfig;
