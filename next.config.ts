import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allows production verification while a local dev server owns `.next`.
  // Vercel and normal local commands continue to use the default directory.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
