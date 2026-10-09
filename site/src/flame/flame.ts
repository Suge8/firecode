import { CanvasTexture, LinearFilter, Mesh, MeshBasicNodeMaterial, NoColorSpace, OrthographicCamera, PlaneGeometry, Scene, Vector2, WebGPURenderer } from "three/webgpu";
import { Fn, clamp, color, dot, exp, float, floor, fract, fwidth, length, max, mix, mx_noise_float, sin, smoothstep, step, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";

// 着色器全部在像素空间里算：q 以火苗底部中点为原点、以标志高度为单位，y 向上
const MARK_ASPECT = 2916 / 3552;
const MASK_PAD = 0.3;
const MASK_HEIGHT = 440;
const SOFT_HEIGHT = 128;
// 模糊半径按遮罩高度的比例：inner 给火焰内芯的热度，outer 给火舌与光晕
const INNER_BLUR = 0.035;
const OUTER_BLUR = 0.1;
// 开场：光标先闪，IGNITE_AT 秒时点燃，火焰带回弹窜起，GROW_SECONDS 内落定
const IGNITE_AT = 0.9;
const GROW_SECONDS = 1.5;
const BURST_SPARKS = 18;
const MAX_PIXEL_RATIO = 2;
const WIND_RESPONSE = 6;
const WIND_LIMIT = 2400;
const PRESENCE_RESPONSE = 3;
// 滚出首屏时火焰缩到这个比例
const SCROLL_SHRINK = 0.4;
// 静止模式取的时刻：火舌轮廓干净、没有脱离的团块
const STILL_AT = 3;
const BACKGROUND = "#0c0a09";

type Mount = { canvas: HTMLCanvasElement; box: HTMLElement; markUrl: string; reduce: boolean; onIgnite: () => void };

export async function mountFlame({ canvas, box, markUrl, reduce, onIgnite }: Mount) {
	const renderer = new WebGPURenderer({ canvas, antialias: false, powerPreference: "high-performance" });
	const [masks] = await Promise.all([markMasks(markUrl), renderer.init()]);

	const u = {
		res: uniform(new Vector2(1, 1)),
		base: uniform(new Vector2()),
		size: uniform(1),
		grow: uniform(0),
		since: uniform(-1),
		time: uniform(0),
		pointer: uniform(new Vector2(-1e5, -1e5)),
		presence: uniform(0),
		wind: uniform(new Vector2()),
		lean: uniform(0),
		fade: uniform(0),
	};
	const material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
	material.colorNode = flameNode(u, masks);
	const scene = new Scene();
	scene.add(new Mesh(new PlaneGeometry(2, 2), material));
	const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2);
	camera.position.z = 1;
	await renderer.compileAsync(scene, camera);
	if (reduce) {
		u.grow.value = 1;
		u.since.value = 60;
		u.time.value = STILL_AT;
		onIgnite();
	}

	let rect = canvas.getBoundingClientRect();
	let markHeight = 1;
	let fade = 0;
	const layout = () => {
		rect = canvas.getBoundingClientRect();
		const mark = box.getBoundingClientRect();
		renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
		renderer.setSize(rect.width, rect.height, false);
		u.res.value.set(rect.width, rect.height);
		u.base.value.set(mark.left - rect.left + mark.width / 2, rect.bottom - mark.bottom);
		markHeight = mark.height;
		u.size.value = markHeight;
		// 静止模式只画一帧；改尺寸会清空画布，所以每次布局后重画
		if (reduce) renderer.render(scene, camera);
	};
	layout();
	const resize = new ResizeObserver(layout);
	resize.observe(canvas);
	resize.observe(box);

	// 首屏滚出的进度（0–1），由区块的滚动触发器写入
	const setFade = (progress: number) => (fade = progress);
	if (reduce) return { setFade };

	const pointer = new Vector2();
	const pending = new Vector2();
	let pointerInside = false;
	addEventListener("pointermove", (event) => {
		rect = canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = rect.bottom - event.clientY;
		if (pointerInside) pending.add(new Vector2(x - pointer.x, y - pointer.y));
		pointer.set(x, y);
		pointerInside = y >= 0 && y <= rect.height;
	});
	document.documentElement.addEventListener("pointerleave", () => (pointerInside = false));

	let start = -1;
	let last = 0;
	let ignited = false;
	const frame = (ms: number) => {
		const now = ms / 1000;
		if (start < 0) start = last = now;
		const dt = Math.min(now - last, 1 / 20);
		last = now;
		const life = now - start;
		const since = life - IGNITE_AT;
		if (!ignited && since >= 0) {
			ignited = true;
			onIgnite();
		}
		u.time.value = life;
		u.since.value = since;
		u.grow.value = since < 0 ? 0 : easeOutBack(clamp01(since / GROW_SECONDS));
		u.fade.value = fade;
		u.size.value = markHeight * (1 - SCROLL_SHRINK * fade);

		const follow = 1 - Math.exp(-dt * WIND_RESPONSE);
		const velocity = dt > 0 ? pending.clone().divideScalar(dt).clampLength(0, WIND_LIMIT) : new Vector2();
		pending.set(0, 0);
		u.wind.value.lerp(velocity, follow);
		u.pointer.value.copy(pointer);
		u.presence.value += ((pointerInside ? 1 : 0) - u.presence.value) * (1 - Math.exp(-dt * PRESENCE_RESPONSE));
		const leanTarget = pointerInside ? clampTo((pointer.x - u.base.value.x) / rect.width, -0.5, 0.5) * 0.3 : 0;
		u.lean.value += (leanTarget - u.lean.value) * follow * 0.5;

		renderer.render(scene, camera);
	};

	// 离开视口就停帧，回来再续
	new IntersectionObserver(([entry]) => renderer.setAnimationLoop(entry.isIntersecting ? frame : null)).observe(canvas);
	return { setFade };
}

type Uniforms = {
	res: Node<"vec2">;
	base: Node<"vec2">;
	size: Node<"float">;
	grow: Node<"float">;
	since: Node<"float">;
	time: Node<"float">;
	pointer: Node<"vec2">;
	presence: Node<"float">;
	wind: Node<"vec2">;
	lean: Node<"float">;
	fade: Node<"float">;
};

function flameNode(u: Uniforms, { sharp, inner, outer }: Record<"sharp" | "inner" | "outer", CanvasTexture>) {
	const fbm = (p: Node<"vec3">) =>
		mx_noise_float(p)
			.add(mx_noise_float(p.mul(2.03)).mul(0.5))
			.add(mx_noise_float(p.mul(4.07)).mul(0.25))
			.mul(0.62);
	const hash = (p: Node<"vec2">) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
	const gauss = (d: Node<"float">, r: Node<"float"> | number) => exp(d.div(r).mul(d.div(r)).negate());

	return Fn(() => {
		const p = uv().mul(u.res).toVar();
		const t = u.time;
		const raw = p.sub(u.base).div(u.size);
		// 热浪：火焰上方的空气按噪声横向抖动，火舌、火星与光晕一起扭曲
		const shimmer = mx_noise_float(vec3(raw.x.mul(6), raw.y.mul(4.5).sub(t.mul(3.4)), t.mul(0.7)));
		const q = raw.add(vec2(shimmer.mul(0.022).mul(smoothstep(0.35, 1.4, raw.y)), 0)).toVar();

		// 指针：靠近火焰时火更旺，指针附近的火星被推开
		const ptr = u.pointer.sub(u.base).div(u.size);
		const toPtr = q.sub(ptr);
		const dist = length(toPtr);
		const stoke = gauss(length(ptr.sub(vec2(0, 0.5))), 0.9).mul(u.presence);

		const since = max(u.since, 0);
		const lit = step(0, u.since);
		const flare = exp(since.mul(-1.6)).mul(lit);
		const g = max(u.grow.mul(stoke.mul(0.07).add(1)), 0.04);
		const wild = clamp(float(1).sub(u.grow), 0, 1).add(flare.mul(0.8));
		const height = clamp(q.y, 0, 1.8);

		const n1 = fbm(vec3(q.x.mul(3.2), q.y.mul(2.4).sub(t.mul(1.7)), t.mul(0.22))).toVar();
		const n2 = fbm(vec3(q.x.mul(5.8).add(7.3), q.y.mul(4.4).sub(t.mul(2.7)), t.mul(0.37))).toVar();
		const n3 = fbm(vec3(q.x.mul(4.1).sub(3.1), q.y.mul(3.1).sub(t.mul(3.4)), t.mul(0.5))).toVar();

		// 指针带起的气流：越靠近指针、越往上，偏得越多
		const push = u.wind.div(u.size).mul(0.16).mul(gauss(dist, 0.9));
		const swing = float(0.022).add(height.mul(0.085)).mul(wild.mul(1.8).add(1)).mul(mix(0.35, 1, u.grow));
		const sway = vec2(
			n1.mul(swing).add(u.lean.mul(height).mul(height)).add(push.x.mul(height)),
			n2.mul(0.5).add(0.5).mul(height).mul(0.13).add(push.y.mul(height).mul(0.4)),
		).toVar();

		// 遮罩外一律为 0：贴边夹取会把边缘像素拉成横贯全屏的光带
		const mask = (map: CanvasTexture, v: Node<"vec2">) => {
			const at = vec2(v.x.div(g.mul(MARK_ASPECT)).add(0.5 + MASK_PAD), v.y.div(g).add(MASK_PAD)).div(1 + 2 * MASK_PAD);
			const inside = step(0, at.x).mul(step(at.x, 1)).mul(step(0, at.y)).mul(step(at.y, 1));
			return texture(map, at).r.mul(inside);
		};
		// 模糊遮罩按随噪声浮动的阈值切开，得到边缘清晰、形状一直在变的火舌
		const lick = (v: Node<"vec2">, n: Node<"float">, edge: number) => smoothstep(edge, edge + 0.12, mask(outer, v).add(n.mul(0.22)));
		const rel = q.y.div(g);

		// 主体按屏幕像素宽度抗锯齿：遮罩先轻微模糊，再在 0.5 处按导数宽度切边
		const bodyMask = mask(sharp, q.sub(sway));
		const aa = max(fwidth(bodyMask), 0.02);
		const body = smoothstep(float(0.5).sub(aa), float(0.5).add(aa), bodyMask);
		// 标志中间的洞：模糊遮罩高、主体为 0 的地方；洞里不进火舌和光晕，让 >_ 读得清
		const hole = smoothstep(0.55, 0.8, mask(outer, q.sub(sway.mul(0.6)))).mul(float(1).sub(body));
		const open = float(1).sub(hole);
		const core = mask(inner, q.sub(sway.mul(0.6)));
		const fringe = lick(q.sub(sway.mul(1.35)).sub(vec2(0, height.mul(0.08))), n2, 0.42).mul(smoothstep(0.1, 0.5, rel)).mul(open);
		const tongueA = lick(q.sub(vec2(sway.x.mul(1.8), n3.mul(0.5).add(0.5).mul(height).mul(0.5))), n3, 0.6)
			.mul(smoothstep(0.35, 0.75, rel))
			.mul(smoothstep(1.2, 0.9, rel))
			.mul(open);
		const tongueB = lick(q.sub(vec2(sway.x.mul(2.4).add(n2.mul(0.05)), n1.mul(0.5).add(0.5).mul(height).mul(0.75))), n1, 0.64)
			.mul(smoothstep(0.55, 0.95, rel))
			.mul(smoothstep(1.3, 1.0, rel))
			.mul(open);
		const flow = n1.mul(0.5).add(n2.mul(0.5));
		const density = max(max(body, fringe.mul(0.8)), max(tongueA, tongueB.mul(0.85)));
		// 脱离主体的火舌不靠内芯取热，单独给一档温度，免得烧成暗红的烟
		const tongueHeat = max(tongueA, tongueB.mul(0.85)).mul(float(1.0).sub(clamp(rel, 0, 1.9).mul(0.4)));
		const heat = max(density.mul(core.mul(1.08).add(0.26)).mul(float(1.25).sub(clamp(rel, 0, 1.6).mul(0.5))), tongueHeat)
			.mul(flow.mul(0.45).add(0.9))
			.mul(flare.mul(0.7).add(stoke.mul(0.25)).add(1));

		const ramp = mix(
			mix(mix(vec3(0), color(0x7a1405), smoothstep(0.02, 0.3, heat)), color(0xff6a0a), smoothstep(0.25, 0.66, heat)),
			mix(color(0xffb547), color(0xfff6e6), smoothstep(1.2, 1.6, heat)),
			smoothstep(0.66, 0.98, heat),
		);

		const hx = q.x.div(g.mul(0.62));
		const hy = q.y.sub(g.mul(0.45)).div(g.mul(0.7));
		const halo = exp(hx.mul(hx).add(hy.mul(hy)).negate());
		const pulse = sin(t.mul(2.3)).mul(0.06).add(sin(t.mul(7.1)).mul(0.03)).add(0.92);
		const floorGlow = exp(q.x.div(0.6).mul(q.x.div(0.6)).add(q.y.div(0.05).mul(q.y.div(0.05))).negate());
		const bloom = mask(outer, q.sub(sway.mul(0.8))).mul(0.2);
		const glow = color(0xff4d06).mul(halo.mul(0.17).add(bloom).mul(pulse).mul(flare.mul(1.2).add(1)).mul(hole.mul(-0.85).add(1)).add(floorGlow.mul(0.07)));
		const fire = ramp.add(glow).mul(smoothstep(0, 0.05, u.grow));

		// 点燃瞬间：光标处一点白光，沿地面铺开一圈热浪
		const ex = q.x;
		const ey = q.y.sub(0.02).mul(2.6);
		const er = length(vec2(ex, ey));
		const flash = exp(since.mul(-5)).mul(lit);
		const spot = gauss(er, 0.07).mul(flash).mul(2.2);
		const wave = gauss(er.add(n1.mul(0.08)).sub(since.mul(1.1)), since.mul(0.1).add(0.03)).mul(exp(since.mul(-4))).mul(lit).mul(0.25);
		const ignition = color(0xfff1d6).mul(spot).add(color(0xff7a0f).mul(wave));

		// 点燃时迸出的一把火星：减速外飞、缓慢上浮、逐渐熄灭
		const flight = float(1).sub(exp(since.mul(-2.2))).div(2.2);
		let burst: Node<"float"> = float(0);
		for (let i = 0; i < BURST_SPARKS; i++) {
			const angle = (seeded(i, 1) - 0.5) * 2.6;
			const speed = 0.7 + seeded(i, 2) * 1.3;
			const at = vec2(Math.sin(angle) * speed, Math.cos(angle) * speed * 0.8).mul(flight).add(vec2(0, since.mul(since).mul(0.18)));
			burst = burst.add(smoothstep(0.012 + seeded(i, 3) * 0.012, 0, length(q.sub(at))));
		}
		const embersBurst = color(0xffc070).mul(burst.mul(exp(since.mul(-0.9)).mul(lit)).mul(1.6));

		// 火星：三层随时间上移的网格，每格按哈希决定有没有一颗；被风带走、被指针推开，靠近指针时更亮
		const shove = toPtr.div(max(dist, 0.001)).mul(gauss(dist, 0.22).mul(0.11).mul(u.presence));
		const carry = u.wind.div(u.size).mul(0.12).mul(gauss(dist, 0.7)).mul(smoothstep(0, 1, q.y));
		const sq = q.sub(shove).sub(carry);
		let sparks: Node<"float"> = float(0);
		for (const [layer, scale, speed] of [[0, 8, 0.34], [1, 13, 0.5], [2, 21, 0.68]] as const) {
			const cellPos = vec2(sq.x.mul(scale), sq.y.sub(t.mul(speed)).mul(scale));
			const cell = floor(cellPos).add(layer * 37);
			const local = fract(cellPos).sub(0.5);
			const seed = hash(cell);
			const drift = vec2(hash(cell.add(11)).sub(0.5).mul(0.6).add(sin(t.mul(1.7).add(seed.mul(40))).mul(0.18)), hash(cell.add(23)).sub(0.5).mul(0.6));
			const spark = smoothstep(0.1, 0, length(local.sub(drift)));
			const twinkle = sin(t.mul(9).add(seed.mul(70))).mul(0.35).add(0.65);
			sparks = sparks.add(spark.mul(step(0.88, seed)).mul(twinkle));
		}
		const column = gauss(sq.x, 0.62).mul(smoothstep(0.2, 0.75, sq.y)).mul(smoothstep(2.6, 1.1, sq.y));
		const stoked = gauss(dist, 0.3).mul(u.presence).mul(1.6).add(1);
		const embers = color(0xffa040).mul(sparks.mul(column).mul(stoked).mul(u.grow));

		// 滚出首屏时火焰压暗，火星留得久一些
		const dim = float(1).sub(smoothstep(0.1, 0.4, u.fade));
		const lightOut = fire.add(ignition).mul(dim).add(embers.add(embersBurst).mul(smoothstep(0.45, 0.15, u.fade)));
		const dither = vec3(hash(p).sub(0.5).div(1200));
		return vec4(lightOut.add(color(BACKGROUND)).add(dither), 1);
	})();
}

// 开场火星的参数：固定种子，每次打开都一样
const seeded = (i: number, k: number) => {
	const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
	return x - Math.floor(x);
};

// 把标志画进三张遮罩：清晰的主体，加两张不同半径的模糊图；四周留白避免采样贴边
async function markMasks(url: string) {
	const height = MASK_HEIGHT;
	const width = Math.round(height * MARK_ASPECT);
	const svg = (await (await fetch(url)).text()).replace("<svg ", `<svg width="${width}" height="${height}" `);
	const image = new Image();
	image.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
	await image.decode();
	URL.revokeObjectURL(image.src);

	const pad = Math.round(height * MASK_PAD);
	const sharp = drawCanvas(width + 2 * pad, height + 2 * pad, (ctx) => ctx.drawImage(image, pad, pad, width, height));
	const softWidth = Math.round((SOFT_HEIGHT * sharp.width) / sharp.height);
	const soft = (radius: number) =>
		blur(
			drawCanvas(softWidth, SOFT_HEIGHT, (ctx) => ctx.drawImage(sharp, 0, 0, softWidth, SOFT_HEIGHT)),
			Math.round(radius * SOFT_HEIGHT),
		);
	return { sharp: maskTexture(blur(sharp, 1)), inner: maskTexture(soft(INNER_BLUR)), outer: maskTexture(soft(OUTER_BLUR)) };
}

// 三遍盒式模糊近似高斯；只用红通道
function blur(canvas: HTMLCanvasElement, radius: number) {
	const { width, height } = canvas;
	const ctx = canvas.getContext("2d")!;
	const image = ctx.getImageData(0, 0, width, height);
	let a = Float32Array.from({ length: width * height }, (_, i) => image.data[i * 4]);
	let b = new Float32Array(a.length);
	const pass = (from: Float32Array, to: Float32Array, step: number, lines: number, span: number, stride: number) => {
		for (let line = 0; line < lines; line++) {
			for (let i = 0; i < span; i++) {
				let sum = 0;
				for (let k = -radius; k <= radius; k++) sum += from[line * stride + Math.min(span - 1, Math.max(0, i + k)) * step];
				to[line * stride + i * step] = sum / (2 * radius + 1);
			}
		}
	};
	for (let round = 0; round < 3; round++) {
		pass(a, b, 1, height, width, width);
		pass(b, a, width, width, height, 1);
	}
	for (let i = 0; i < a.length; i++) image.data[i * 4] = a[i];
	ctx.putImageData(image, 0, 0);
	return canvas;
}

function drawCanvas(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, width, height);
	ctx.imageSmoothingQuality = "high";
	draw(ctx);
	return canvas;
}

function maskTexture(canvas: HTMLCanvasElement) {
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = NoColorSpace;
	texture.minFilter = LinearFilter;
	texture.magFilter = LinearFilter;
	texture.generateMipmaps = false;
	return texture;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const clampTo = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
// 越过终点约 10% 再落回：火焰窜起后回落
const easeOutBack = (x: number) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;
