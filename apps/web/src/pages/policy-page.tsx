import { Card } from "@/components/motion/card";
import { Input } from "@/components/motion/input";
import { Button } from "@/components/motion/button";

export function PolicyPage() {
	return (
		<Card className="p-4">
			<Input label="Capability" placeholder="basic-chat" />
			<Button className="mt-4">Save policy</Button>
		</Card>
	);
}
