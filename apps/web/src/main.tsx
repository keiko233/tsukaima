import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./route-tree.gen";
import { initializeLocale } from "./lib/locale";
import { initializeTheme } from "./lib/theme";
import { ToastProvider } from "./lib/toast";
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
