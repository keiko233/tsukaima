import { randomUUID } from "node:crypto";
import { users } from "@elaina/db";
import type { ElainaDatabase } from "@elaina/db";

export class UserService {
	constructor(private readonly db: ElainaDatabase) {}

	async ensureUser(input: { displayName: string; kind?: "human" | "bot" | "system" }) {
		const id = randomUUID();
		await this.db.insert(users).values({
			displayName: input.displayName,
			id,
			isAdmin: 0,
			kind: input.kind ?? "human",
			trustLevel: "normal",
		});
		return { id };
	}

	async count(): Promise<number> {
		const rows = await this.db.select({ id: users.id }).from(users);
		return rows.length;
	}
}
