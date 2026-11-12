"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/motion/button";
import { Card } from "@/components/motion/card";
import { CardContent } from "@/components/motion/card";
import { Input } from "@/components/motion/input";
import { api } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { SystemPage } from "./page-header";

export function PolicyPage() {
	const [capability, setCapability] = useState("basic-chat");
	const [primaryProvider, setPrimaryProvider] = useState("openai-compatible");
	const [primaryModel, setPrimaryModel] = useState("");
	const queryClient = useQueryClient();

	const policiesQuery = useQuery({
		queryFn: api.modelPolicies.list,
		queryKey: ["admin", "model-policies"],
	});
	const savePolicy = useMutation({
		mutationFn: api.modelPolicies.set,
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["admin"] });
		},
	});

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
					{savePolicy.isSuccess ? (
						<div className="text-xs text-muted-foreground">{m.policy_saved()}</div>
					) : null}
					{savePolicy.isError ? (
						<div className="text-xs text-destructive">{savePolicy.error.message}</div>
					) : null}
				</CardContent>
			</Card>
		</SystemPage>
	);
}
