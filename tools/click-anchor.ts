/** 锚定要的滚动视口：首行、是否跟随末尾、视口高、上次布局的内容总高，以及停在某行与恢复跟随。 */
export interface Scroller {
	readonly top: number;
	readonly following: boolean;
	readonly viewport: number;
	readonly contentHeight: number;
	holdAt(top: number): void;
	follow(): void;
}

/**
 * 点击展开/收起时的视口锚定，主会话与子代理视图共用。被锚定的组件位于滚动内容的末尾（主会话的聊天区、视图的正文），
 * 展开只改变被点行之下的内容。原本跟随末尾的点击只作用于这一次布局变化：展开后被点行仍在视口里就继续跟随；
 * 会被顶出视口时把它停在视口顶行，露出尽量多的展开内容，此后内容高度再变（新输出到达）即恢复跟随。
 * 停住期间用户自己滚动过（首行变了、或滚回末尾）即放弃锚定；原本已上滚的点击不碰视口。
 */
export class ClickAnchor {
	private height = 0;
	/** 等这次点击的布局：被点行在滚动内容里的行号。 */
	private pending: number | undefined;
	private held: { top: number; height: number } | undefined;

	constructor(private readonly scroller: () => Scroller | undefined) {}

	/** 点击改了展开状态时调用；y 是被点行在组件上次布局里的行号。 */
	click(y: number): void {
		const scroller = this.scroller();
		if (!scroller || (!scroller.following && !this.held)) return;
		this.pending = scroller.contentHeight - (this.height - y);
	}

	/** 每次渲染出组件、视口按新高度定位之前调用。 */
	layout(height: number): void {
		const growth = height - this.height;
		this.height = height;
		const scroller = this.scroller();
		if (!scroller) return;
		const line = this.pending;
		this.pending = undefined;
		if (line !== undefined) {
			this.held = undefined;
			if (line >= scroller.contentHeight + growth - scroller.viewport) return scroller.follow();
			scroller.holdAt(line);
			// 宿主按上次布局的内容高夹住首行（内容原本不足一屏时夹到 0）：记实际停住的位置，否则下一次布局会误判成用户滚动过。
			this.held = { top: scroller.top, height };
			return;
		}
		const held = this.held;
		if (!held) return;
		if (scroller.following || scroller.top !== held.top) this.held = undefined;
		else if (height !== held.height) {
			this.held = undefined;
			scroller.follow();
		}
	}
}
