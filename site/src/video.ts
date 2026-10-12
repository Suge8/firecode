import { reducedMotion } from "./scroll";

type Options = {
	/** 进入视口时是否自动播放，每次进出视口时判定（Review 在手机上不自动播） */
	autoplay: () => boolean;
	/** 首次播放从第几秒开始 */
	start?: number;
	/** 用户点播放、开播之前调用（Review 在手机上借此进全屏） */
	beforeUserPlay?: () => void;
};

// 区块里的视频共用一套控制：PlayToggle 盖住画面，任何时候都能停；允许动效且 autoplay() 为真时进入视口才加载播放、离开就停；
// 用户手动暂停后不再自动续播。减少动效时只显示海报，点了才播
export function controlVideo(video: HTMLVideoElement, toggle: HTMLButtonElement, { autoplay, start = 0, beforeUserPlay }: Options) {
	let userPaused = false;
	const sync = () => {
		const playing = !video.paused;
		toggle.toggleAttribute("data-playing", playing);
		const label = playing ? toggle.dataset.pause! : toggle.dataset.play!;
		toggle.setAttribute("aria-label", label);
		toggle.title = label;
	};
	const play = () => {
		if (video.currentTime === 0 && start) video.currentTime = start;
		video.play().catch((error: DOMException) => {
			if (error.name !== "AbortError") throw error;
		});
	};
	video.addEventListener("play", sync);
	video.addEventListener("pause", sync);
	toggle.addEventListener("click", () => {
		userPaused = !video.paused;
		if (userPaused) return video.pause();
		beforeUserPlay?.();
		play();
	});
	if (reducedMotion) return;
	new IntersectionObserver(
		([entry]) => {
			if (userPaused || !autoplay()) return;
			if (entry.isIntersecting) play();
			else video.pause();
		},
		{ threshold: 0.35 },
	).observe(video);
}
