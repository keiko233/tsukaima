import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createRouterUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "./api-router";

export type AppRouterClient = RouterClient<AppRouter>;

export const rpcLink = new RPCLink({
	url: "http://127.0.0.1:7420/rpc",
});

export const rpcClient: AppRouterClient = createORPCClient(rpcLink);
export const rpc = createRouterUtils(rpcClient);
