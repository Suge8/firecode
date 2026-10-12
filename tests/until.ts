/** 等条件成立再往下断言；超时抛错并带上条件源码，不静默放行。固定 sleep 在慢机器上会先于事件到达。 */
export async function until(condition: () => unknown, timeoutMs = 10_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!(await condition())) {
		if (performance.now() > deadline) throw new Error(`等待超时：${condition}`);
		await Bun.sleep(2);
	}
}
