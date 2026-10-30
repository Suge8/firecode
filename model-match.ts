import type { Api, Model } from "@earendil-works/pi-ai";

/** 按完整名称优先，其次按段边界匹配，保留宿主模型列表的顺序。 */
export function matchModels(models: readonly Model<Api>[], name: string): Model<Api>[] {
	const exact = models.filter((model) => `${model.provider}/${model.id}` === name);
	return exact.length ? exact : models.filter((model) => `${model.provider}/${model.id}`.endsWith(`/${name}`));
}
