import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "renderer");
const to = join(root, "dist", "renderer");

await mkdir(to, { recursive: true });
await cp(from, to, {
  recursive: true,
  // Only the static assets ship; the TypeScript is compiled separately.
  filter: (src) => !src.endsWith(".ts"),
});
