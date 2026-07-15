import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const output = path.resolve("dist", "client");
mkdirSync(output, { recursive: true });
for (const file of ["index.html", "styles.css"]) {
  copyFileSync(path.resolve("client", file), path.join(output, file));
}