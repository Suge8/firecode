import { markdown, readmeMarkdown } from "../repo";

export const GET = () => markdown(readmeMarkdown("en"));
