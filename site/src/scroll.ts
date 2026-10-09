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

export { gsap, ScrollTrigger };
