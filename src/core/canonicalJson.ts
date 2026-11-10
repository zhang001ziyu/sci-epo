const textEncoder = new TextEncoder();

type CanonicalObjectEntry = {
	readonly key: string;
	readonly keyBytes: Uint8Array;
	readonly value: unknown;
};

export class CanonicalJsonError extends Error {
	readonly name = "CanonicalJsonError";

	constructor(readonly reason: string) {
		super(reason);
	}
}

function normalizeString(value: string): string {
	return value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const sharedLength = Math.min(left.length, right.length);
	for (let index = 0; index < sharedLength; index += 1) {
		const leftByte = left[index];
		const rightByte = right[index];
		if (leftByte === undefined || rightByte === undefined) {
			throw new CanonicalJsonError("UTF-8 comparison index is out of bounds");
		}
		if (leftByte !== rightByte) {
			return leftByte - rightByte;
		}
	}
	return left.length - right.length;
}

function isPlainObject(value: object): boolean {
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function canonicalObjectEntries(value: object): CanonicalObjectEntry[] {
	if (!isPlainObject(value)) {
		throw new CanonicalJsonError("non-plain objects are not JSON values");
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new CanonicalJsonError("symbol object keys are not JSON values");
	}

	const enumerableKeys = Object.keys(value);
	if (Object.getOwnPropertyNames(value).length !== enumerableKeys.length) {
		throw new CanonicalJsonError("non-enumerable object fields are not JSON values");
	}

	const normalizedKeys = new Set<string>();
	const entries: CanonicalObjectEntry[] = [];
	for (const key of enumerableKeys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || !("value" in descriptor)) {
			throw new CanonicalJsonError("accessor object fields are not JSON values");
		}
		const normalizedKey = normalizeString(key);
		if (normalizedKeys.has(normalizedKey)) {
			throw new CanonicalJsonError("normalized object key collision");
		}
		normalizedKeys.add(normalizedKey);
		entries.push({
			key: normalizedKey,
			keyBytes: textEncoder.encode(normalizedKey),
			value: descriptor.value,
		});
	}
	entries.sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
	return entries;
}

function serializeNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new CanonicalJsonError("non-finite numbers are not JSON values");
	}
	const serialized = JSON.stringify(value);
	if (typeof serialized !== "string") {
		throw new CanonicalJsonError("finite number serialization failed");
	}
	return serialized;
}

function serializeArray(value: readonly unknown[], ancestors: WeakSet<object>): string {
	const items: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.hasOwn(value, index)) {
			throw new CanonicalJsonError("sparse arrays are not JSON values");
		}
		items.push(serializeJsonValue(value[index], ancestors));
	}
	return `[${items.join(",")}]`;
}

function serializeObject(value: object, ancestors: WeakSet<object>): string {
	const fields = canonicalObjectEntries(value).map(
		(entry) => `${JSON.stringify(entry.key)}:${serializeJsonValue(entry.value, ancestors)}`,
	);
	return `{${fields.join(",")}}`;
}

function serializeJsonValue(value: unknown, ancestors: WeakSet<object>): string {
	if (value === null) {
		return "null";
	}
	if (typeof value === "string") {
		return JSON.stringify(normalizeString(value));
	}
	if (typeof value === "number") {
		return serializeNumber(value);
	}
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	if (typeof value !== "object") {
		throw new CanonicalJsonError(`unsupported JSON value type: ${typeof value}`);
	}
	if (ancestors.has(value)) {
		throw new CanonicalJsonError("cyclic objects are not JSON values");
	}

	ancestors.add(value);
	const serialized = Array.isArray(value)
		? serializeArray(value, ancestors)
		: serializeObject(value, ancestors);
	ancestors.delete(value);
	return serialized;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
	return textEncoder.encode(serializeJsonValue(value, new WeakSet<object>()));
}

export function canonicalJsonFileBytes(value: unknown): Uint8Array {
	const content = canonicalJsonBytes(value);
	const file = new Uint8Array(content.length + 1);
	file.set(content);
	file[content.length] = 0x0a;
	return file;
}
