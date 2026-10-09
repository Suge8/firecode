/**
 * 进程唯一的共享状态。pi 的扩展加载器（jiti，moduleCache: false）在子会话 cwd 变化或宿主 reload 后会重新求值整个模块图，
 * 模块级变量在两份拷贝间互不相通；凡要跨拷贝共享的状态（会话进行中的聚合器、单写者登记、子会话角色、分组补丁的所有者）
 * 都经这里挂在 globalThis 上，首次调用创建、之后命中同一份。
 */
export function processShared<T>(name: string, create: () => T): T {
	const key = Symbol.for(`firecode.${name}`);
	const store = globalThis as Record<symbol, unknown>;
	return (store[key] ??= create()) as T;
}
