import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      // R2 public bucket (will be wired in M3)
    ],
  },
  typedRoutes: true,
};

export default nextConfig;
