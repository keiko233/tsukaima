import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./route-tree.gen";
import { initializeLocale } from "./lib/locale";
import { initializeTheme } from "./lib/theme";
import { ToastProvider } from "./lib/toast";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/outfit";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "cn-fontsource-smiley-sans-oblique-regular/font.css";
import "cn-fontsource-lxgw-neo-xi-hei-regular/font.css";
import "@fontsource/noto-serif-sc/500.css";
import "@fontsource/noto-serif-sc/600.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "./app.css";

initializeTheme();
initializeLocale();

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 10_000 } },
});

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<ToastProvider>
				<RouterProvider router={router} />
			</ToastProvider>
		</QueryClientProvider>
	</StrictMode>,
);
