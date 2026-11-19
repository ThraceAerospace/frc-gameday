import type { NextConfig } from "next";

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
