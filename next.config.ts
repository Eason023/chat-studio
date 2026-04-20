import type { NextConfig } from "next";

const customDistDir = process.env.NEXT_DEV_DIST_DIR?.trim();
const traceExcludes = [
  "./.git/**/*",
  "./media/**/*",
  "./scripts/**/*",
  "./README.md",
  "./LICENSE",
  "./NOTICE",
  "./tsconfig.tsbuildinfo",
  "./chat-studio*.tar",
  "./*.tar",
  "./*.tar.*",
  "./.tmp-*.tar*",
  "./npm-debug.log*",
  "./yarn-debug.log*",
  "./yarn-error.log*",
];

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  output: "standalone",
  experimental: {
    optimizePackageImports: ["lucide-react", "radix-ui"],
  },
  outputFileTracingExcludes: {
    // Do not exclude the active dist output here. Standalone runtime chunks
    // live under `.next/server/**` and must remain traceable.
    "next-server": traceExcludes,
    "/*": traceExcludes,
  },
  ...(customDistDir ? { distDir: customDistDir } : {}),
};

export default nextConfig;
