// 计量代理：审查者与顾问是内存会话，用量不落盘，所以把运行的模型请求经本地代理转发，从响应里记下用量。
// 每次运行有独立的 Agent 目录，其中 models.json 的自定义供应商 baseUrl 指向 /<运行>/<供应商>，代理按它转发回原地址。
// 只计得到 models.json 里写了 baseUrl 的供应商；宿主内置供应商不经代理、不计量（见 README）。
import { appendFileSync } from "node:fs";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Request {
	run: string;
	provider: string;
	model: string;
	start: number;
	end: number;
	status: number;
	usage?: Usage;
	cost?: number;
}

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };

interface Provider {
	baseUrl: string;
	api?: string;
	models?: Array<{ id: string; api?: string; cost?: Rates }>;
}


/** 与宿主 calculateCost 同一口径（每百万 token 的单价）。 */
function costOf(rates: Rates | undefined, usage: Usage): number | undefined {
	if (!rates) return undefined;
	return (rates.input * usage.input + rates.output * usage.output + rates.cacheRead * usage.cacheRead + rates.cacheWrite * usage.cacheWrite) / 1e6;
}

/** 三种流式协议里的用量字段，与宿主各 provider 的解析口径一致（input 不含缓存读写）。 */
function usageOf(api: string | undefined, event: any, previous: Usage | undefined): Usage | undefined {
	if (api === "anthropic-messages") {
		const raw = event.message?.usage ?? event.usage;
		if (!raw) return previous;
		return {
			input: raw.input_tokens ?? previous?.input ?? 0,
			output: raw.output_tokens ?? previous?.output ?? 0,
			cacheRead: raw.cache_read_input_tokens ?? previous?.cacheRead ?? 0,
			cacheWrite: raw.cache_creation_input_tokens ?? previous?.cacheWrite ?? 0,
		};
	}
	const raw = event.response?.usage ?? event.usage;
	if (!raw) return previous;
	if (raw.input_tokens !== undefined) {
		const cached = raw.input_tokens_details?.cached_tokens ?? 0;
		return { input: Math.max(0, raw.input_tokens - cached), output: raw.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0 };
	}
	const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens ?? 0;
	const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
	return { input: Math.max(0, (raw.prompt_tokens ?? 0) - cacheRead - cacheWrite), output: raw.completion_tokens ?? 0, cacheRead, cacheWrite };
}

export function startMeter(providers: Record<string, Provider>): { port: number; attach(run: string, file: string): void; detach(run: string): Promise<void>; stop(): void } {
	const sinks = new Map<string, string>();
	const pending = new Map<string, Set<Promise<void>>>();
	const controllers = new Map<string, Set<AbortController>>();
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const [, run, name, ...rest] = url.pathname.split("/");
			const provider = name ? providers[name] : undefined;
			if (!run || !provider) return new Response("unknown route", { status: 404 });
			const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
			let model = "";
			try {
				model = body ? JSON.parse(new TextDecoder().decode(body)).model ?? "" : "";
			} catch {}
			const headers = new Headers(request.headers);
			headers.delete("host");
			headers.delete("content-length");
			const started = Date.now();
			const controller = new AbortController();
			controllers.get(run)?.add(controller);
			let upstream: Response;
			try {
				upstream = await fetch(`${provider.baseUrl.replace(/\/$/u, "")}/${rest.join("/")}${url.search}`, { method: request.method, headers, body, signal: AbortSignal.any([request.signal, controller.signal]) });
			} catch (error) {
				controllers.get(run)?.delete(controller);
				const sink = sinks.get(run);
				if (sink) appendFileSync(sink, JSON.stringify({ run, provider: name, model, start: started, end: Date.now(), status: 0, error: String(error) }) + "\n");
				return new Response("upstream failed", { status: 502 });
			}
			const record = (usage: Usage | undefined) => {
				const sink = sinks.get(run);
				if (!sink) return;
				const rates = provider.models?.find((entry) => entry.id === model)?.cost;
				const entry: Request = { run, provider: name!, model, start: started, end: Date.now(), status: upstream.status, ...(usage ? { usage, cost: costOf(rates, usage) } : {}) };
				appendFileSync(sink, JSON.stringify(entry) + "\n");
				controllers.get(run)?.delete(controller);
			};
			if (!upstream.body) {
				record(undefined);
				return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
			}
			const [mine, theirs] = upstream.body.tee();
			const consumed = (async () => {
				let usage: Usage | undefined;
				let pending = "";
				const decoder = new TextDecoder();
				const scan = (line: string) => {
					const data = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
					if (!data.startsWith("{")) return;
					try {
						usage = usageOf(provider.models?.find((entry) => entry.id === model)?.api ?? provider.api, JSON.parse(data), usage);
					} catch {}
				};
				try {
					for await (const chunk of mine) {
						pending += decoder.decode(chunk, { stream: true });
						for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
							scan(pending.slice(0, nl));
							pending = pending.slice(nl + 1);
						}
					}
					scan(pending);
				} catch {}
				record(usage);
			})();
			pending.get(run)?.add(consumed);
			// fetch 已解压响应体，原样转发编码头会让客户端二次解压。
			const outHeaders = new Headers(upstream.headers);
			outHeaders.delete("content-encoding");
			outHeaders.delete("content-length");
			return new Response(theirs, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders });
		},
	});
	return {
		port: server.port!,
		attach: (run, file) => { sinks.set(run, file); pending.set(run, new Set()); controllers.set(run, new Set()); },
		detach: async (run) => {
			for (const controller of controllers.get(run) ?? []) controller.abort();
			await Promise.all(pending.get(run) ?? []);
			sinks.delete(run); pending.delete(run); controllers.delete(run);
		},
		stop: () => void server.stop(true),
	};
}
