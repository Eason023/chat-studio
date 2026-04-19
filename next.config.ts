import type { NextConfig } from "next";

const customDistDir = process.env.NEXT_DEV_DIST_DIR?.trim();

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  output: "standalone",
  ...(customDistDir ? { distDir: customDistDir } : {}),
};

export default nextConfig;
