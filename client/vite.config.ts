import path from "path";
import { defineConfig } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { config } from "dotenv";

config({ path: path.resolve(__dirname, "../.env") });

// https://vite.dev/config/
export default defineConfig({
    plugins: [wasm(), topLevelAwait(), react()],
    optimizeDeps: {
        exclude: ["onnxruntime-node", "@anush008/tokenizers"],
    },
    build: {
        commonjsOptions: {
            exclude: ["onnxruntime-node", "@anush008/tokenizers"],
        },
        rollupOptions: {
            external: ["onnxruntime-node", "@anush008/tokenizers"],
        },
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
            "react-router-dom": "react-router-dom/dist/index.js"
        },
    },
    server: {
        host: true,
        proxy: {
            "/api": {
                target: `http://127.0.0.1:${process.env.SERVER_PORT || 3000}`,
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, ""),
                configure: (proxy, _options) => {
                    proxy.on('error', (err, _req, _res) => {
                        console.log('proxy error', err);
                    });
                    proxy.on('proxyReq', (proxyReq, req, _res) => {
                        console.log('Sending Request to:', req.method, req.url);
                    });
                    proxy.on('proxyRes', (proxyRes, req, _res) => {
                        console.log('Received Response from:', req.method, req.url, proxyRes.statusCode);
                    });
                }
            },
        },
    },
});
