import path from "node:path";
import { readGeneratedData, repositoryRoot } from "./lib/master-data.mjs";

const outputDirectory = path.join(repositoryRoot, "server", "data");
const { dataset, manifest } = await readGeneratedData(outputDirectory);

console.log(
  `Validated schema ${manifest.schemaVersion}, data ${manifest.dataVersion}, ${dataset.cards.length} cards`,
);
