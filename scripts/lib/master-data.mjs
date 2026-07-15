import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "1.0.0";
export const DATA_VERSION = "0.2.0";

export const DATA_FILES = {
  cards: "cards.json",
  cardTemplates: "cardTemplates.json",
  shikigami: "shikigami.json",
  barriers: "barriers.json",
  terrains: "terrains.json",
  forbiddenArts: "forbiddenArts.json",
  keywords: "keywords.json",
  curses: "curses.json",
  aiScores: "aiScores.json",
};

const ID_PATTERN = /^[a-z0-9_]+$/;
const REQUIRED_TEXT = {
  cards: ["id", "name", "category", "system", "attribute", "target", "timing", "effectText", "description"],
  cardTemplates: ["id", "name", "category", "system", "imageId", "description"],
  shikigami: ["id", "name", "attribute", "aiProfile", "ability", "description", "imageId"],
  barriers: ["id", "name", "attribute", "system", "timing", "target", "effectText", "description"],
  terrains: ["id", "name", "attribute", "system", "timing", "target", "effectText", "description"],
  forbiddenArts: ["id", "name", "attribute", "category", "system", "target", "effectText", "description"],
  keywords: ["id", "name", "classification", "effectText", "description"],
  curses: ["id", "name", "effectText", "removalCondition", "stacking", "description"],
  aiScores: ["id", "target", "notes"],
};

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`必須文字列がありません: ${label}`);
  }
}

function requiredNumber(value, label, minimum = Number.NEGATIVE_INFINITY) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`数値が不正です: ${label}`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`配列ではありません: ${label}`);
  }
}

function uniqueIds(items, label, globalIds) {
  const localIds = new Set();
  for (const item of items) {
    requiredString(item.id, `${label}.id`);
    if (!ID_PATTERN.test(item.id)) {
      throw new Error(`ID形式が不正です: ${item.id}`);
    }
    if (localIds.has(item.id)) {
      throw new Error(`IDが重複しています: ${item.id}`);
    }
    localIds.add(item.id);
    if (globalIds.has(item.id)) {
      throw new Error(`異なるデータ間でIDが重複しています: ${item.id}`);
    }
    globalIds.add(item.id);
  }
  return localIds;
}

function validateEffects(cards, references) {
  for (const card of cards) {
    assertArray(card.effects, `${card.id}.effects`);
    for (const [index, effect] of card.effects.entries()) {
      requiredString(effect.type, `${card.id}.effects[${index}].type`);
      if (effect.cardId !== undefined && effect.cardId !== card.id) {
        throw new Error(`効果のcardIdが一致しません: ${card.id}`);
      }
      if (effect.type === "summon" && !references.shikigami.has(effect.shikigamiId)) {
        throw new Error(`存在しない式神参照です: ${effect.shikigamiId}`);
      }
      if (effect.type === "barrier" && !references.barriers.has(effect.fieldId)) {
        throw new Error(`存在しない結界参照です: ${effect.fieldId}`);
      }
      if (effect.type === "terrain" && !references.terrains.has(effect.fieldId)) {
        throw new Error(`存在しない地形参照です: ${effect.fieldId}`);
      }
      const curseId = effect.curseId ?? effect.attributeMatchEffect?.curseId;
      if (curseId && !references.curses.has(curseId)) {
        throw new Error(`存在しない呪い参照です: ${curseId}`);
      }
    }
  }
}

export function validateDataset(dataset) {
  const globalIds = new Set();
  const references = {};
  for (const key of Object.keys(DATA_FILES)) {
    assertArray(dataset[key], key);
    references[key] = uniqueIds(dataset[key], key, globalIds);
    for (const item of dataset[key]) {
      for (const field of REQUIRED_TEXT[key]) {
        requiredString(item[field], `${key}.${item.id}.${field}`);
      }
    }
  }

  for (const card of dataset.cards) {
    requiredNumber(card.cost, `${card.id}.cost`, 0);
    requiredNumber(card.mpCost, `${card.id}.mpCost`, 0);
    requiredNumber(card.weight, `${card.id}.weight`, 0);
    assertArray(card.timings, `${card.id}.timings`);
    if (card.templateId !== null && card.templateId !== undefined && !references.cardTemplates.has(card.templateId)) {
      throw new Error(`存在しないテンプレート参照です: ${card.templateId}`);
    }
  }
  if (dataset.cards.reduce((sum, card) => sum + card.weight, 0) <= 0) {
    throw new Error("抽選可能なカードがありません。");
  }

  for (const unit of dataset.shikigami) {
    requiredNumber(unit.maxHp, `${unit.id}.maxHp`, 1);
    requiredNumber(unit.attack, `${unit.id}.attack`, 0);
    assertArray(unit.keywordIds, `${unit.id}.keywordIds`);
    for (const keywordId of unit.keywordIds) {
      if (!references.keywords.has(keywordId)) {
        throw new Error(`存在しないキーワード参照です: ${keywordId}`);
      }
    }
  }

  for (const art of dataset.forbiddenArts) {
    requiredNumber(art.cost, `${art.id}.cost`, 0);
    requiredNumber(art.mpCost, `${art.id}.mpCost`, 0);
    requiredNumber(art.weight, `${art.id}.weight`, 0);
  }

  for (const score of dataset.aiScores) {
    if (typeof score.score !== "number" && typeof score.score !== "string") {
      throw new Error(`AI評価値が不正です: ${score.id}`);
    }
  }

  validateEffects(dataset.cards, references);
  return dataset;
}

function keywordIds(value, keywords) {
  if (!value) return [];
  const names = String(value).split("・").map((name) => name.trim()).filter(Boolean);
  return names.map((name) => {
    const keyword = keywords.find((candidate) => candidate.name === name);
    if (!keyword) throw new Error(`式神が未知のキーワードを参照しています: ${name}`);
    return keyword.id;
  });
}

export async function loadSourceData(sourceDirectory) {
  const source = {};
  for (const [key, filename] of Object.entries(DATA_FILES)) {
    source[key] = await readJson(path.join(sourceDirectory, filename));
  }
  source.cardEffects = await readJson(path.join(sourceDirectory, "cardEffects.json"));
  return source;
}

export function composeDataset(source) {
  const effectsByCardId = new Map();
  for (const effect of source.cardEffects) {
    if (effectsByCardId.has(effect.cardId)) {
      throw new Error(`1枚のカードに複数のルート効果定義があります: ${effect.cardId}`);
    }
    effectsByCardId.set(effect.cardId, effect);
  }
  const templates = source.cardTemplates.map((template) => ({
    ...template,
    hasAttributeVariants: template.hasAttributeVariants === true || template.hasAttributeVariants === "有",
  }));
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const cards = source.cards.map((variant) => {
    const template = variant.templateId ? templateById.get(variant.templateId) : undefined;
    if (variant.templateId && !template) {
      throw new Error(`存在しないテンプレートです: ${variant.templateId}`);
    }
    const effect = effectsByCardId.get(variant.id);
    return {
      ...variant,
      category: variant.category || template?.category,
      system: variant.system || template?.system,
      imageId: variant.imageId || template?.imageId,
      timings: [variant.timing],
      effects: effect ? [effect] : [],
    };
  });
  const shikigami = source.shikigami.map((unit) => ({
    ...unit,
    keywordIds: keywordIds(unit.keywords, source.keywords),
  }));
  return {
    cards,
    cardTemplates: templates,
    shikigami,
    barriers: source.barriers,
    terrains: source.terrains,
    forbiddenArts: source.forbiddenArts,
    keywords: source.keywords,
    curses: source.curses,
    aiScores: source.aiScores,
  };
}

export function createManifest(dataset) {
  return {
    schemaVersion: SCHEMA_VERSION,
    dataVersion: DATA_VERSION,
    files: Object.fromEntries(
      Object.entries(DATA_FILES).map(([key, filename]) => [
        key,
        { filename, count: dataset[key].length },
      ]),
    ),
  };
}

export async function writeDataset(dataset, outputDirectory) {
  validateDataset(dataset);
  await mkdir(outputDirectory, { recursive: true });
  const obsoleteFiles = ["cardEffects.json", "cpuEvaluations.json", "forbiddenTechniques.json"];
  await Promise.all(obsoleteFiles.map((name) => rm(path.join(outputDirectory, name), { force: true })));
  for (const [key, filename] of Object.entries(DATA_FILES)) {
    await writeFile(path.join(outputDirectory, filename), `${JSON.stringify(dataset[key], null, 2)}\n`, "utf8");
  }
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    `${JSON.stringify(createManifest(dataset), null, 2)}\n`,
    "utf8",
  );
}

export async function buildData({ sourceDirectory, outputDirectory }) {
  const source = await loadSourceData(sourceDirectory);
  const dataset = composeDataset(source);
  await writeDataset(dataset, outputDirectory);
  return dataset;
}

export async function readGeneratedData(outputDirectory) {
  const dataset = {};
  for (const [key, filename] of Object.entries(DATA_FILES)) {
    dataset[key] = await readJson(path.join(outputDirectory, filename));
  }
  const manifest = await readJson(path.join(outputDirectory, "manifest.json"));
  validateDataset(dataset);
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.dataVersion !== DATA_VERSION) {
    throw new Error("manifest.jsonのバージョンが一致しません。");
  }
  for (const [key, filename] of Object.entries(DATA_FILES)) {
    const entry = manifest.files?.[key];
    if (!entry || entry.filename !== filename || entry.count !== dataset[key].length) {
      throw new Error(`manifest.jsonの内容が一致しません: ${key}`);
    }
  }
  return { dataset, manifest };
}

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
