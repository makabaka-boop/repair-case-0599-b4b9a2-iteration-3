import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 开发环境：/api 与 /health 代理到 FastAPI，端口可用 API_PORT 覆盖（与 compose 一致）
const apiPort = process.env.API_PORT ?? "8001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      "/health": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: false,
    // e2e 目录由 Playwright 运行，Vitest 不收集
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
