import { isPlainObject } from "es-toolkit";

/**
 * JSON/config-shaped record guard. Plain objects only: class instances, `Date`, `Map`, and
 * arrays are not records.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value);
}
