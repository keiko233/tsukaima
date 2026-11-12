import { paraglideVitePlugin } from "@inlang/paraglide-js";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		tanstackRouter({
			target: "react",
			autoCodeSplitting: true,
			generatedRouteTree: `src/route-tree.gen.ts`,
			routeFileIgnorePattern: "_modules",
		}),
		paraglideVitePlugin({
			project: "./project.inlang",
			outdir: "./src/paraglide",
			strategy: ["globalVariable", "baseLocale"],
			emitTsDeclarations: true,
		}),
		react(),
		tailwindcss(),
	],
	resolve: {
		alias: {
			"@": resolve(import.meta.dirname, "src"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 7421,
		proxy: {
			"/rpc": {
				changeOrigin: true,
				target: "http://127.0.0.1:7420",
			},
		},
		strictPort: true,
	},
});
