import type { APIRoute } from "astro";
import { llmsTxt } from "../repo";

export const GET: APIRoute = ({ site }) => new Response(llmsTxt(site!), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
