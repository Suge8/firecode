import { rewrite } from "@vercel/functions";

// Vercel 路由中间件：Agent 用 Accept: text/markdown 请求首页时返回由 README 生成的 Markdown。
// 不能用 vercel.json 的 rewrites：静态文件先于 rewrites 命中，首页的 index.html 永远会被直接返回。
export const config = { matcher: ["/", "/zh", "/zh/"] };

export default function middleware(request: Request) {
	if (!request.headers.get("accept")?.includes("text/markdown")) return;
	const url = new URL(request.url);
	return rewrite(new URL(url.pathname.startsWith("/zh") ? "/zh/index.md" : "/index.md", url));
}
