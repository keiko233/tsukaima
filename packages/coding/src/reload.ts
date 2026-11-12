export interface ReloadContext {
	readonly proposalId?: string;
	readonly reason: string;
}

export interface ReloadResult {
	readonly message: string;
	readonly reloadedAtMs: number;
	readonly success: boolean;
}

export interface ReloadController {
	reload(componentId: string, context: ReloadContext): Promise<ReloadResult>;
}

export class NoopReloadController implements ReloadController {
	async reload(componentId: string, context: ReloadContext): Promise<ReloadResult> {
		return {
			message: `No-op reload for "${componentId}" (reason: ${context.reason})`,
			reloadedAtMs: Date.now(),
			success: true,
		};
	}
}
