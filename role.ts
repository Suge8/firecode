import { AsyncLocalStorage } from "node:async_hooks";
import { processShared } from "./process-shared.js";

export type SubsessionRole = "worker" | "observer" | "reviewer" | "advisor";

// 角色标记必须跨模块拷贝共享，否则新拷贝读不到 spawn 侧设置的角色，watcher/master 会级联注册进子会话。
const ROLE = processShared("subsession-role", () => new AsyncLocalStorage<SubsessionRole>());

export function currentSubsessionRole(): SubsessionRole | undefined {
	return ROLE.getStore();
}

export function withSubsessionRole<T>(role: SubsessionRole, run: () => Promise<T>): Promise<T> {
	return ROLE.run(role, run);
}
