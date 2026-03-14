import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  transpilePackages: ["@social/shared"],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@automerge/automerge$": fileURLToPath(
        new URL(
          "../../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js",
          import.meta.url
        )
      )
    };

    return config;
  }
};

export default nextConfig;
