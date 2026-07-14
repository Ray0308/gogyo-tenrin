import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/client", { recursive: true });
await copyFile("client/index.html", "dist/client/index.html");