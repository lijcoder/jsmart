import { resolve } from "path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			outDir: "dist/main",
			rollupOptions: {
				input: {
					index: resolve(__dirname, "src/main/index.ts"),
				},
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			outDir: "dist/preload",
			rollupOptions: {
				input: {
					index: resolve(__dirname, "src/preload/index.ts"),
				},
			},
		},
	},
	renderer: {
		plugins: [react()],
		build: {
			outDir: "dist/renderer",
			rollupOptions: {
				input: {
					index: resolve(__dirname, "src/renderer/index.html"),
				},
			},
		},
	},
});
