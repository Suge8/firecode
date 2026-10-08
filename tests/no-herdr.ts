// 在 herdr pane 里跑测试时，继承来的 HERDR_* 会让 herdr 投影把测试会话报到真实 pane；用例需要时自己设置。
for (const key of Object.keys(process.env)) if (key.startsWith("HERDR_")) delete process.env[key];
