declare module "jsdom" {
	export class JSDOM {
		constructor(
			html?: string,
			options?: {
				readonly pretendToBeVisual?: boolean;
			},
		);
		readonly window: unknown;
	}
}
