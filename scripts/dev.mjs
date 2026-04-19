import { existsSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const modeArg = process.argv.includes("--turbopack") ? "--turbopack" : "--webpack";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const stableDistDir = ".next-dev";
let distDir = stableDistDir;
const nextBin = path.join(
  process.cwd(),
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
);

if (existsSync(stableDistDir)) {
  try {
    renameSync(stableDistDir, `.next-dev-stale-${stamp}-${process.pid}`);
  } catch {
    distDir = `.next-dev-fallback-${stamp}-${process.pid}`;
  }
}

const child = spawn(process.execPath, [nextBin, "dev", modeArg], {
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_DEV_DIST_DIR: distDir,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
