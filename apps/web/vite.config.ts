import { paraglideVitePlugin } from "@inlang/paraglide-js";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const serverTarget =
	process.env.TSUKAIMA_SERVER_URL ?? `http://127.0.0.1:${process.env.TSUKAIMA_SERVER_PORT ?? "7420"}`;

export default defineConfig({
	clearScreen: false,
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
			strategy: ["localStorage", "baseLocale"],
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
			"/api": {
				changeOrigin: true,
				target: serverTarget,
			},
			"/rpc": {
				changeOrigin: true,
				target: serverTarget,
			},
			"/events": {
				changeOrigin: true,
				target: serverTarget,
			},
		},
		strictPort: true,
	},
});
