import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--experimental-strip-types", "src/evals/v3/offline.ts"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
