/**
 * 火焰动效：全局唯一动画时钟、盲文火苗与落定过渡。凡是“正在运行”的东西都用这里的火苗；
 * 所有动效由同一个时钟驱动，没有订阅者时计时器停止，帧号取绝对时间，多处火苗天然同步。
 */
export type Rgb = readonly [number, number, number];

/** 火焰色板：heat 从余烬烧到白金；ash 是冷却后的灰，与主题中性色无关以免冷却过程跳色。 */
export const HEAT_COLORS = {
	ember: [110, 30, 22],
	red: [255, 47, 32],
	orange: [255, 119, 28],
	gold: [255, 195, 61],
	white: [255, 239, 184],
	ash: [128, 123, 115],
	green: [124, 196, 120],
	failDim: [150, 52, 44],
	fail: [226, 78, 66],
} as const satisfies Record<string, Rgb>;

const FPS = 12;
const FRAME_MS = 1000 / FPS;
const COOL_MS = 600;
const SETTLE_MS = 400;
/** 一格火苗与三格火苗的火舌高度轮廓（每格两个点列）。 */
const PROFILE = { 1: [0.75, 1], 3: [0.3, 0.6, 0.9, 1, 0.7, 0.35] } as const;
// 盲文点位：左列自上而下 1 2 3 7，右列 4 5 6 8。
const DOT = [
	[0x01, 0x02, 0x04, 0x40],
	[0x08, 0x10, 0x20, 0x80],
] as const;
const HEAT_STOPS: readonly [number, Rgb][] = [
	[0, HEAT_COLORS.ember],
	[0.3, HEAT_COLORS.red],
	[0.55, HEAT_COLORS.orange],
	[0.8, HEAT_COLORS.gold],
	[1, HEAT_COLORS.white],
];

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/** 订阅动画帧；返回取消函数。最后一个订阅者离开时计时器随之停止。 */
export function onFrame(listener: () => void): () => void {
	listeners.add(listener);
	if (!timer) {
		timer = setInterval(() => {
			for (const notify of listeners) notify();
		}, FRAME_MS);
		timer.unref?.();
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size || !timer) return;
		clearInterval(timer);
		timer = undefined;
	};
}

/** 按帧量化的绝对秒数；所有火苗共用同一相位基准。 */
const frameSeconds = () => Math.floor(Date.now() / FRAME_MS) / FPS;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const easeOut = (k: number) => 1 - (1 - clamp(k)) ** 3;

export function mix(from: Rgb, to: Rgb, k: number): Rgb {
	const t = clamp(k);
	return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

export function heat(value: number): Rgb {
	const x = clamp(value);
	for (let index = 1; index < HEAT_STOPS.length; index++) {
		const [at, color] = HEAT_STOPS[index];
		const [fromAt, from] = HEAT_STOPS[index - 1];
		if (x <= at) return mix(from, color, (x - fromAt) / (at - fromAt));
	}
	return HEAT_COLORS.white;
}

/** 只设置/复位前景色，不注入全量 reset，可安全嵌进带背景的行。 */
export function paint(color: Rgb, text: string): string {
	return text ? `\x1b[38;2;${color[0] | 0};${color[1] | 0};${color[2] | 0}m${text}\x1b[39m` : "";
}

/** 三个不可公约频率叠加的火势，0.1–1 之间起伏。 */
export function flicker(phase: number, t = frameSeconds()): number {
	const tau = Math.PI * 2;
	return 0.55
		+ 0.2 * Math.sin(tau * (1.1 * t + phase))
		+ 0.15 * Math.sin(tau * (2.7 * t + 1.7 * phase) + 1.3)
		+ 0.1 * Math.sin(tau * (5.9 * t + 3.1 * phase) + 0.4);
}

/**
 * 盲文火苗：每个点列是一根随时钟起伏的火舌，火尖随风摆，顶行只留一个点保持尖顶。
 * phase 让并列的火苗错开；cool 0→1 把火势压低并褪成灰。
 */
export function flame(cells: 1 | 3, phase: number, cool = 0): string {
	const profile = PROFILE[cells];
	const columns = cells * 2;
	const t = frameSeconds();
	const sway = Math.round(Math.sin(Math.PI * 2 * (0.7 * t + phase)) * 0.6 * (1 - cool));
	const heights = Array.from({ length: columns }, (_, index) => {
		const base = profile[Math.min(columns - 1, Math.max(0, index - sway))];
		return Math.round(clamp(base * (0.7 + 0.45 * flicker(phase + index * 0.37, t)) * (1 - 0.6 * cool)) * 4);
	});
	const peak = Math.max(...heights);
	let topSeen = false;
	let out = "";
	for (let cell = 0; cell < cells; cell++) {
		let bits = 0;
		for (let side = 0; side < 2; side++) {
			let height = heights[cell * 2 + side];
			if (height === peak && height > 1) {
				if (topSeen) height -= 1;
				topSeen = true;
			}
			for (let row = 0; row < height; row++) bits |= DOT[side][3 - row];
		}
		const core = cells === 1 ? 0.5 : 1 - Math.abs(cell - (cells - 1) / 2) / cells;
		const color = mix(heat(0.35 + 0.45 * core + 0.2 * flicker(phase + cell, t)), HEAT_COLORS.ash, cool);
		out += paint(color, String.fromCodePoint(0x2800 + bits));
	}
	return out;
}

export type Settle = "done" | "failed";

/** 落定标记：火苗先在 0.6 秒内冷却（失败则沉到暗红），再落成 ✓/✗ 并在 0.4 秒内转到终色。 */
export function settleMark(kind: Settle, sinceMs: number, phase = 0): string {
	if (sinceMs < COOL_MS) {
		const k = easeOut(sinceMs / COOL_MS);
		return kind === "done" ? flame(1, phase, k) : paint(mix(HEAT_COLORS.orange, HEAT_COLORS.failDim, k), "⣴");
	}
	const k = easeOut((sinceMs - COOL_MS) / SETTLE_MS);
	return kind === "done"
		? paint(mix(HEAT_COLORS.ash, HEAT_COLORS.green, k), "✓")
		: paint(mix(HEAT_COLORS.failDim, HEAT_COLORS.fail, k), "✗");
}

/** 落定过渡是否仍在播放；调用方据此决定是否继续订阅时钟。 */
export const settling = (sinceMs: number) => sinceMs < COOL_MS + SETTLE_MS;

/** 审查：菱形在火焰色里缓慢呼吸。 */
export function reviewMark(phase = 0): string {
	return paint(heat(0.62 + 0.18 * Math.sin(Math.PI * 2 * (0.8 * frameSeconds() + phase))), "◈");
}

/** 并列火苗的相位：按序号错开，避免一排火苗同起同落。 */
export const phaseOf = (index: number) => index * 0.23 + 0.11;
