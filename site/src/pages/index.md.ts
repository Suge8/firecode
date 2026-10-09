import { markdown, readmeMarkdown } from "../agent-docs";

export const GET = async () => markdown(await readmeMarkdown("en"));
