import type { NativeCompactionRuntime } from "./native-runtime";
import type { NativeCompactionRequest } from "./responses-input";

const JSON_CONTENT_TYPE = "application/json";

type CompactResponse = {
	created_at?: number | string;
	output: Record<string, unknown>[];
};

export type NativeCompactionFailureReason =
	| "aborted"
	| "network-error"
	| "non-2xx"
	| "empty-body"
	| "invalid-json"
	| "malformed-response"
	| "empty-output";

export type NativeCompactionResult =
	| {
			ok: true;
			compactedWindow: unknown[];
			createdAt?: string;
	  }
	| {
			ok: false;
			reason: NativeCompactionFailureReason;
			status?: number;
			detail?: string;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}

function normalizeResponseTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
		return new Date(milliseconds).toISOString();
	}
	if (typeof value !== "string" || !value.trim()) {
		return undefined;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? value.trim() : new Date(parsed).toISOString();
}

function isCompactResponse(value: unknown): value is CompactResponse {
	return isRecord(value) && Array.isArray(value.output) && value.output.every(isRecord);
}

function parseErrorDetail(responseText: string): string | undefined {
	try {
		const parsed = JSON.parse(responseText);
		if (!isRecord(parsed) || !isRecord(parsed.error) || typeof parsed.error.message !== "string") {
			return undefined;
		}
		return parsed.error.message.trim() || undefined;
	} catch {
		return undefined;
	}
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return undefined;
	}
	try {
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
		return isRecord(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

function codexAccountId(token: string): string | undefined {
	const authClaims = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
	if (!isRecord(authClaims) || typeof authClaims.chatgpt_account_id !== "string") {
		return undefined;
	}
	return authClaims.chatgpt_account_id.trim() || undefined;
}

function codexUserAgent(): string {
	return `pi (${process.platform}; ${process.arch})`;
}

function buildHeaders(runtime: NativeCompactionRuntime): Record<string, string> {
	const headers = new Headers(runtime.currentModel.headers ?? {});
	for (const [key, value] of Object.entries(runtime.headers ?? {})) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
	headers.set("accept", JSON_CONTENT_TYPE);
	headers.set("content-type", JSON_CONTENT_TYPE);
	if (!headers.has("authorization")) {
		headers.set("authorization", `Bearer ${runtime.apiKey}`);
	}
	if (runtime.provider === "openai-codex") {
		const accountId = codexAccountId(runtime.apiKey);
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}
		headers.set("originator", "pi");
		headers.set("user-agent", codexUserAgent());
		headers.set("openai-beta", "responses=experimental");
	}
	return Object.fromEntries(headers.entries());
}

export async function executeNativeCompaction(args: {
	runtime: NativeCompactionRuntime;
	request: NativeCompactionRequest;
	signal?: AbortSignal;
}): Promise<NativeCompactionResult> {
	const { runtime, request, signal } = args;
	if (signal?.aborted) {
		return { ok: false, reason: "aborted" };
	}

	try {
		const response = await fetch(runtime.compactUrl, {
			method: "POST",
			headers: buildHeaders(runtime),
			body: JSON.stringify(request),
			signal,
		});
		const responseText = await response.text();
		if (!response.ok) {
			const detail = parseErrorDetail(responseText);
			return {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				...(detail ? { detail } : {}),
			};
		}
		if (!responseText.trim()) {
			return { ok: false, reason: "empty-body", status: response.status };
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(responseText);
		} catch {
			return { ok: false, reason: "invalid-json", status: response.status };
		}
		if (!isCompactResponse(parsed)) {
			return { ok: false, reason: "malformed-response", status: response.status };
		}
		if (parsed.output.length === 0) {
			return { ok: false, reason: "empty-output", status: response.status };
		}

		return {
			ok: true,
			compactedWindow: parsed.output,
			createdAt: normalizeResponseTimestamp(parsed.created_at),
		};
	} catch (error) {
		return isAbortError(error)
			? { ok: false, reason: "aborted" }
			: { ok: false, reason: "network-error" };
	}
}
