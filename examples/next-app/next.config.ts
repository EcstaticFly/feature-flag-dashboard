import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Strict Mode mounts every component twice in development, which is exactly
  // what FlagProvider must survive without a second request.
  reactStrictMode: true,
};

export default nextConfig;
