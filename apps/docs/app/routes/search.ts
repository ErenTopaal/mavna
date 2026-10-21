import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

const server = createFromSource(source, { language: "english" });

// written to a static file at build time, and searched in the browser
export async function loader(): Promise<Response> {
  return server.staticGET();
}
