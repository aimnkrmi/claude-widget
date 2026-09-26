import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const dir of ["dist", "dist-test"]) {
  await rm(join(root, dir), { recursive: true, force: true });
}
