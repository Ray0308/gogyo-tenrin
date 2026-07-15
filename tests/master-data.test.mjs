import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildData,
  composeDataset,
  loadSourceData,
  readGeneratedData,
  repositoryRoot,
  validateDataset,
} from "../scripts/lib/master-data.mjs";

test("マスターから仕様どおりの実装JSONを生成できる", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "gogyo-data-"));
  try {
    const dataset = await buildData({
      sourceDirectory: path.join(repositoryRoot, "master", "data"),
      outputDirectory,
    });
    assert.equal(dataset.cards.length, 90);
    assert.equal(dataset.cardTemplates.length, 16);
    assert.equal(dataset.shikigami.length, 10);
    assert.equal(dataset.barriers.length, 4);
    assert.equal(dataset.terrains.length, 6);
    assert.equal(dataset.forbiddenArts.length, 6);
    assert.equal(dataset.keywords.length, 6);
    assert.equal(dataset.curses.length, 8);
    assert.equal(dataset.aiScores.length, 16);
    assert.ok(dataset.cards.every((card) => Array.isArray(card.timings)));
    assert.ok(dataset.cards.every((card) => Array.isArray(card.effects)));
    assert.ok(dataset.cards.every((card) => card.effects.length === 1), "all MVP cards must have one structured effect");
    const forbidden = dataset.cards.filter((card) => card.system === "禁術");
    assert.equal(forbidden.length, 6);
    assert.ok(forbidden.every((card) => card.weight === 1.5));
    assert.equal(forbidden.find((card) => card.id === "card_forbidden_yomigaeshi")?.effects[0].hpRatio, 1);
    assert.equal(forbidden.find((card) => card.id === "card_forbidden_tamashii_gui")?.effects[0].heal, 12);
    assert.equal(forbidden.find((card) => card.id === "card_forbidden_kamioroshi")?.effects[0].attack, 4);

    const { manifest } = await readGeneratedData(outputDirectory);
    assert.equal(manifest.schemaVersion, "1.0.0");
    assert.equal(manifest.dataVersion, "0.2.0");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("ID重複を検出する", async () => {
  const source = await loadSourceData(path.join(repositoryRoot, "master", "data"));
  const dataset = composeDataset(source);
  dataset.cards[1] = { ...dataset.cards[1], id: dataset.cards[0].id };
  assert.throws(() => validateDataset(dataset), /IDが重複しています/);
});

test("参照切れを検出する", async () => {
  const source = await loadSourceData(path.join(repositoryRoot, "master", "data"));
  const dataset = composeDataset(source);
  const summonCard = dataset.cards.find((card) => card.effects[0]?.type === "summon");
  assert.ok(summonCard);
  summonCard.effects[0].shikigamiId = "shikigami_missing";
  assert.throws(() => validateDataset(dataset), /存在しない式神参照/);
});
