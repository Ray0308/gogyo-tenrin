import path from "node:path";
import { buildData, repositoryRoot } from "./lib/master-data.mjs";

const sourceDirectory = path.join(repositoryRoot, "master", "data");
const outputDirectory = path.join(repositoryRoot, "server", "data");
const dataset = await buildData({ sourceDirectory, outputDirectory });

console.log(
  `Generated master data: ${dataset.cards.length} cards, ${dataset.shikigami.length} shikigami, ${dataset.barriers.length} barriers, ${dataset.terrains.length} terrains`,
);
