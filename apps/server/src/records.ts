import { isPlainObject } from "es-toolkit";

/** JSON/config-shaped record guard. Plain objects only: class instances, `Date`, and arrays are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value);
}

/** JSON/RPC payload as a record; non-object input becomes an empty record. */
export function record(value: unknown): Record<string, unknown> {
	return isPlainObject(value) ? value : {};
}
