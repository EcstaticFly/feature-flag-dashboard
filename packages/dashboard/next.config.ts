import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The dashboard talks to the Express API server-to-server only. FLAGS_API_URL
  // is deliberately NOT prefixed NEXT_PUBLIC_, so it never reaches the browser.
  reactStrictMode: true,
};

export default nextConfig;
