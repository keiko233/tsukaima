export const DECISION_ACTIONS = ["direct", "remap", "review", "discard"] as const;

export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export interface DecisionEntry {
	readonly source: string;
	readonly target: string;
	readonly action: DecisionAction;
	readonly area?: string;
	readonly reason?: string;
	readonly valueClass?: string;
	readonly redacted?: boolean;
}

export interface DecisionCounts extends Record<DecisionAction, number> {}

export interface DecisionReport {
	readonly entries: readonly DecisionEntry[];
	readonly counts: DecisionCounts;
	readonly unresolved: readonly DecisionEntry[];
	readonly secretPaths: readonly string[];
	readonly redactedValues: number;
}

export function emptyDecisionCounts(): DecisionCounts {
	return { direct: 0, discard: 0, remap: 0, review: 0 };
}

export function summarizeDecisions(
	entries: readonly DecisionEntry[],
	secretPaths: readonly string[] = [],
): DecisionReport {
	const counts = emptyDecisionCounts();
	for (const entry of entries) {
		counts[entry.action] += 1;
	}
	return {
		counts,
		entries,
		redactedValues: entries.filter((entry) => entry.redacted === true).length,
		secretPaths: [...new Set(secretPaths)].toSorted((left, right) => left.localeCompare(right)),
		unresolved: entries.filter((entry) => entry.action === "review"),
	};
}

export function mergeDecisionReports(reports: readonly DecisionReport[]): DecisionReport {
	const entries = reports.flatMap((report) => report.entries);
	const secretPaths = reports.flatMap((report) => report.secretPaths);
	const counts = emptyDecisionCounts();
	for (const report of reports) {
		for (const action of DECISION_ACTIONS) {
			counts[action] += report.counts[action];
		}
	}
	return {
		counts,
		entries,
		redactedValues: reports.reduce((total, report) => total + report.redactedValues, 0),
		secretPaths: [...new Set(secretPaths)].toSorted((left, right) => left.localeCompare(right)),
		unresolved: entries.filter((entry) => entry.action === "review"),
	};
}
