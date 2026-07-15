import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadSourceData, repositoryRoot } from "../scripts/lib/master-data.mjs";

test("all MVP shikigami portraits are present and optimized for board display", async () => {
  const dataset = await loadSourceData(path.join(repositoryRoot, "master", "data"));
  assert.equal(dataset.shikigami.length, 10);

  for (const shikigami of dataset.shikigami) {
    assert.match(shikigami.imageId, /^img_shikigami_[a-z0-9_]+$/);
    const filename = `${shikigami.imageId}.png`;
    const sourcePath = path.join(repositoryRoot, "client", "assets", "shikigami", filename);
    const builtPath = path.join(repositoryRoot, "dist", "client", "assets", "shikigami", filename);
    await access(sourcePath);
    await access(builtPath);

    const png = await readFile(sourcePath);
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(png.readUInt32BE(20), 512);
  }
});
