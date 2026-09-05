import { app } from "@azure/functions";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
// Serve the small React build from the same app: no extra hosting service or CORS setup.
app.http("web", {
  methods: ["GET"],
  route: "index/{*file}",
  authLevel: "anonymous",
  handler: async (request) => {
    const root = resolve(__dirname, "../public");
    const file = resolve(root, request.params.file || "index.html");
    if (!file.startsWith(root + sep)) return { status: 404 };
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
    };
    try {
      return {
        body: await readFile(file),
        headers: {
          "Content-Type": types[extname(file)] ?? "application/octet-stream",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      };
    } catch {
      return { status: 404 };
    }
  },
});
