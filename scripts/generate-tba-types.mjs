import { execFileSync } from "node:child_process";

execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "openapi-typescript",
    "https://www.thebluealliance.com/swagger/api_v3.json",
    "-o",
    "apps/web/src/lib/tba/generated.ts",
  ],
  { stdio: "inherit" }
);
