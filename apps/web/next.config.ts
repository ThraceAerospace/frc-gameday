import { existsSync } from "node:fs";
import type { NextConfig } from "next";
import path from "node:path";

// Load the single repository-wide file when present; do not require it for builds
// that receive their environment from the hosting platform.
const rootEnvFile = path.resolve(process.cwd(), "../..", ".env");
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

const nextConfig: NextConfig = {
  transpilePackages: [
    "@fieldview/domain",
    "@fieldview/provider-tba",
    "@fieldview/provider-statbotics",
    "@fieldview/provider-frc-colors",
    "@fieldview/analytics",
  ],
  allowedDevOrigins: ['192.168.18.6'],
};

export default nextConfig;
