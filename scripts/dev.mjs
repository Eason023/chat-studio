import { spawn } from "node:child_process";
import path from "node:path";

const modeArg = process.argv.includes("--turbopack") ? "--turbopack" : "--webpack";
const modeName = modeArg === "--turbopack" ? "turbopack" : "webpack";
const distDir = `.next-dev-${modeName}`;
const nextBin = path.join(
  process.cwd(),
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
);

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
