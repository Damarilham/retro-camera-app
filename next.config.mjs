/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
    resolveAlias: {
      sharp: { browser: "./empty-module.js" },
      "onnxruntime-node": { browser: "./empty-module.js" },
    },
  },
};

export default nextConfig;