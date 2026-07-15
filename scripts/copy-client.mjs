import { cpSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { existsSync } from "node:fs";

const output = path.resolve("dist", "client");
mkdirSync(output, { recursive: true });
for (const file of ["index.html", "styles.css", "shikigami.css", "battle-v2.css", "catalog.css"]) {
  copyFileSync(path.resolve("client", file), path.join(output, file));
}

const clientAssets = path.resolve("client", "assets");
if (existsSync(clientAssets)) {
  cpSync(clientAssets, path.join(output, "assets"), { recursive: true });
}

cpSync(path.resolve("server", "data"), path.resolve("dist", "server", "data"), {
  recursive: true,
});
