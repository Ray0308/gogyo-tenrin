import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const distributionDirectory = path.resolve(currentDirectory, "..");
const rootDocument = readFileSync(
  path.join(distributionDirectory, "client", "index.html"),
  "utf8",
);

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/", (_request, response) => {
  response.type("html").send(rootDocument);
});

app.use(express.static(distributionDirectory));

app.listen(port, () => {
  console.log(`五行転輪 server listening on port ${port}`);
});