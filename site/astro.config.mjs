import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// 中英两页互为 hreflang 由页面头里的 <link rel="alternate"> 声明，站点地图不再重复一份
export default defineConfig({
	site: "https://firecode.si",
	integrations: [sitemap()],
	devToolbar: { enabled: false },
	// 品牌素材的唯一来源在仓库根的 design/，开发服务器需要放行上一级目录
	vite: {
		// 固定用本目录的 tsconfig；否则引用 ../design 素材时会去找仓库根的 tsconfig，而它继承的 .pi-mono 只在开发机上存在
		tsconfig: "./tsconfig.json",
		server: { fs: { allow: [".."] } },
		// 预先打包客户端依赖：火焰是动态导入的、各区块脚本按需引入，开发服务器启动时扫不全，首次访问会触发依赖重建而 504
		optimizeDeps: { include: ["three/webgpu", "three/tsl", "gsap", "gsap/ScrollTrigger", "lenis"] },
	},
});
