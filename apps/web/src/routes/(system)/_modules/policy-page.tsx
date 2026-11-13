"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@elaina/ui/components/motion/button";
import { Card } from "@elaina/ui/components/motion/card";
import { CardContent } from "@elaina/ui/components/motion/card";
import { Input } from "@elaina/ui/components/motion/input";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { SystemPage } from "./page-header";

export function PolicyPage() {
	const toast = useToast();
	const [capability, setCapability] = useState("basic-chat");
	const [primaryProvider, setPrimaryProvider] = useState("openai-compatible");
	const [primaryModel, setPrimaryModel] = useState("");
	const queryClient = useQueryClient();

	const policiesQuery = useQuery(orpc.admin.modelPolicies.list.queryOptions());
	const savePolicy = useMutation(
		orpc.admin.modelPolicies.set.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_policy_save_failed(), {
					description: errorMessage(error),
				}),
			onSuccess: async () => {
				toast.success(m.toast_policy_saved());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.key() });
			},
		}),
	);

	if (policiesQuery.isError) {
		return <Card className="p-4">{policiesQuery.error.message}</Card>;
	}

	return (
		<SystemPage description={m.policies_page_description()} title={m.nav_policies()}>
			<Card size="compact">
				<CardContent className="space-y-4">
					<div className="space-y-3">
						{policiesQuery.data?.map((policy) => (
							<div key={policy.id} className="text-sm">
								<span className="font-medium">{policy.capability}</span>
								<span className="ml-2 text-muted-foreground">
									{policy.primaryProvider}/{policy.primaryModel}
								</span>
							</div>
						))}
					</div>
					<Input
						label={m.policy_capability_label()}
						placeholder={m.policy_capability_placeholder()}
						value={capability}
						onChange={setCapability}
					/>
					<Input
						label={m.policy_primary_provider_label()}
						value={primaryProvider}
						onChange={setPrimaryProvider}
					/>
					<Input
						label={m.policy_primary_model_label()}
						value={primaryModel}
						onChange={setPrimaryModel}
					/>
					<Button
						disabled={primaryModel.trim().length === 0 || savePolicy.isPending}
						onClick={() =>
							savePolicy.mutate({
								capability: capability.trim(),
								primaryModel: primaryModel.trim(),
								primaryProvider: primaryProvider.trim(),
							})
						}
					>
						{m.policy_save()}
					</Button>
				</CardContent>
			</Card>
		</SystemPage>
	);
}
