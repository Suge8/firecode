import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

// 全页唯一的滚动引擎：Lenis 平滑滚动，由 GSAP 的 ticker 驱动并同步 ScrollTrigger。
// 区块从这里拿 gsap 与 ScrollTrigger，不各自注册插件、不另起滚动库。
gsap.registerPlugin(ScrollTrigger);

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!reducedMotion) {
	const lenis = new Lenis({ autoRaf: false });
	lenis.on("scroll", ScrollTrigger.update);
	gsap.ticker.add((time) => lenis.raf(time * 1000));
	gsap.ticker.lagSmoothing(0);
}

// 区块离开视口时标上 data-offscreen，全局样式据此暂停其中的循环 CSS 动画
const visibility = new IntersectionObserver((entries) => {
	for (const entry of entries) entry.target.toggleAttribute("data-offscreen", !entry.isIntersecting);
});
for (const section of document.querySelectorAll("main > section")) visibility.observe(section);

type Story = {
	/** 滚动轨道：钉住层后面跟一块垫块（各区块用 ::after 给出高度），垫块高度就是钉住的滚动距离 */
	track: HTMLElement;
	/** 轨道的第一个子元素，sticky 钉住 */
	pin: HTMLElement;
	timeline: gsap.core.Timeline;
	/** 每一拍在时间轴上的起点，与 Story 组件里的条目一一对应 */
	beats: number[];
};

/**
 * 钉住一幕，滚动推进它的时间轴，并让 Story 组件的当前条目与进度线跟着时间轴走。
 * 钉住用 CSS sticky：钉住层比视口高时把 sticky 的 top 设成负值，让底边贴住视口底，整幕始终完整可见；
 * 每次 ScrollTrigger 刷新（含改尺寸、转屏）都重算，不在加载时定死。
 */
export function scrollStory({ track, pin, timeline, beats }: Story) {
	track.toggleAttribute("data-live", true);
	const list = track.querySelector<HTMLElement>(".beats")!;
	const items = [...list.children] as HTMLElement[];
	const rail = track.querySelector<HTMLElement>(".rail-fill")!;
	const stickTop = () => Math.min(0, innerHeight - pin.offsetHeight);

	let active = -1;
	const sync = () => {
		const now = beats.findLastIndex((time) => timeline.time() >= time);
		if (now === active) return;
		active = now;
		items.forEach((item, i) => item.toggleAttribute("aria-current", i === now));
		const item = items[now];
		rail.style.setProperty("--reach", String((item.offsetTop + item.offsetHeight) / list.offsetHeight));
	};
	timeline.eventCallback("onUpdate", sync);

	// 钉上之前停在第 0 帧：ScrollTrigger 接管前时间轴一帧都没渲染过，各元素会露出 DOM 原样（窗格、汇总表、状态行全叠在一起）。
	// 先走到末尾再回到开头，每个 set 与 fromTo 都记下了起止值，回到 0 时画面就是第一拍之前的样子
	timeline.progress(1, true).progress(0, true);

	// 时间轴从钉上播到松开，滚动距离恰好是垫块高度
	const stick = () => pin.style.setProperty("--stick-top", `${stickTop()}px`);
	stick();
	ScrollTrigger.create({
		trigger: track,
		animation: timeline,
		start: () => `top ${stickTop()}px`,
		end: () => `bottom ${stickTop() + pin.offsetHeight}px`,
		scrub: 0.6,
		invalidateOnRefresh: true,
		onRefreshInit: stick,
	});
	sync();
}

export { gsap, ScrollTrigger };
