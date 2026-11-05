import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  // The app has no server part, so hosting serves plain files built with STATIC_EXPORT=1.
  ...(process.env.STATIC_EXPORT ? { output: "export" as const } : {}),
  turbopack: {
    root: process.cwd(),
    rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } },
  },
};
export default nextConfig;
