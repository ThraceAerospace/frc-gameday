import type { NextConfig } from "next";
import path from "node:path";

// Node 22+ loads the repository-wide file without workspace env variants.
process.loadEnvFile(path.resolve(process.cwd(), "../..", ".env"));

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
