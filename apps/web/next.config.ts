import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";
import path from "node:path";

// The repository root is the single local environment-file location.
// npm workspace scripts execute this config from apps/web.
loadEnvConfig(path.resolve(process.cwd(), "../.."));

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
