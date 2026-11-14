import { PluginRegistryError } from "./registry.ts";

const jsonScalarTypes = new Set(["boolean", "number", "string"]);

function validateJsonSchema(value: unknown, input: unknown, path: string): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new PluginRegistryError(`Invalid JSON schema at ${path || "root"}`);
	}
	const schema = value as Record<string, unknown>;
	const branches = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(branches) && branches.length > 0) {
		// Union shapes (for example `boolean | { … }`) pass when any branch accepts the value.
		const accepted = branches.some((branch) => {
			try {
				validateJsonSchema(branch, input, path);
				return true;
			} catch {
				return false;
			}
		});
		if (!accepted) {
			throw new PluginRegistryError(`Config key "${path}" has an invalid type`);
		}
		return;
	}
	const type = schema.type;
	const types = typeof type === "string" ? [type] : Array.isArray(type) ? type : [];
	if (types.includes("object")) {
		if (typeof input !== "object" || input === null || Array.isArray(input)) {
			throw new PluginRegistryError(`Config key "${path}" must be an object`);
		}
		const properties =
			typeof schema.properties === "object" &&
			schema.properties !== null &&
			!Array.isArray(schema.properties)
				? (schema.properties as Record<string, unknown>)
				: {};
		const required = Array.isArray(schema.required) ? schema.required : [];
		for (const key of required) {
			if (typeof key === "string" && !(key in input)) {
				throw new PluginRegistryError(`Config key "${path}.${key}" is required`);
			}
		}
		for (const [key, childSchema] of Object.entries(properties)) {
			if (key in input) {
				validateJsonSchema(
					childSchema,
					(input as Record<string, unknown>)[key],
					path ? `${path}.${key}` : key,
				);
			}
		}
		return;
	}
	if (types.includes("array")) {
		if (!Array.isArray(input))
			throw new PluginRegistryError(`Config key "${path}" must be an array`);
		const items = schema.items;
		input.forEach((item, index) => {
			if (items !== undefined) validateJsonSchema(items, item, `${path}[${index}]`);
		});
		return;
	}
	const matches = types.some((schemaType) =>
		schemaType === "null"
			? input === null
			: schemaType === "integer"
				? typeof input === "number"
				: jsonScalarTypes.has(schemaType) && typeof input === schemaType,
	);
	if (!matches) {
		throw new PluginRegistryError(`Config key "${path}" has an invalid type`);
	}
	const allowed = schema.enum;
	if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(input)) {
		throw new PluginRegistryError(`Config key "${path}" is not one of the allowed values`);
	}
}

export function validatePluginConfig(
	schema: Record<string, unknown> | undefined,
	config: Record<string, unknown>,
	pluginId: string,
): void {
	try {
		validateJsonSchema(schema ?? { properties: {}, type: "object" }, config, "");
	} catch (error) {
		throw new PluginRegistryError(`Invalid config for plugin ${pluginId}`, { cause: error });
	}
}
