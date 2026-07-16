import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { repositoryRoot } from "../scripts/lib/master-data.mjs";

test("hand cards use imagery and expose a long-press detail view", async () => {
  const client = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "card-ui.css"), "utf8");
  assert.match(client, /function cardSigil/);
  assert.match(client, /renderCardArt\(card, true\)/);
  assert.match(client, /長押しで詳細/);
  assert.match(client, /window\.setTimeout\([\s\S]*420/);
  assert.match(css, /\.hand-card-simple/);
  assert.match(css, /\.card-detail-rich/);
});

test("only summon cards reuse shikigami portraits", async () => {
  const client = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "card-ui.css"), "utf8");
  assert.doesNotMatch(client, /attributeArt/);
  assert.match(client, /const summonImageId = summonArt\[card\.cardId\]/);
  assert.match(client, /card-art-sigil/);
  assert.match(client, /reidan:\s*"●"/);
  assert.match(client, /sigil-\$\{sigil\.key\}/);
  assert.match(css, /\.card-art-sigil/);
  assert.match(css, /\.sigil-reidan \.sigil-mark/);
});

test("card details translate jargon without replacing the official terms", async () => {
  const client = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  for (const term of ["転輪", "相生", "相剋", "属性一致", "ステルス", "反撃", "地形"]) {
    assert.match(client, new RegExp(`"${term}"\s*:`));
  }
  assert.match(client, /かんたんに言うと/);
  assert.match(client, /このカードの用語/);
  assert.match(client, /plainCardGuide/);
  assert.match(client, /showBeginnerHelp \? `<section class="card-plain-guide"/);
  assert.match(client, /state\.mode === "cpu" && cpuExperienceMode === "tutorial"/);
});

test("terrain guidance and beginner help are separated into the tutorial", async () => {
  const client = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  assert.match(client, /data-action="terrain-info"/);
  assert.match(client, /共有地形 · 両者に影響/);
  assert.match(client, /data-action="cpu-battle"/);
  assert.match(client, /data-action="cpu-tutorial"/);
  assert.match(client, /cpuExperienceMode === "tutorial"/);
  assert.match(client, /次にできること/);
  assert.doesNotMatch(client, /gogyo-tenrin-beginner-guide-v1/);
});

test("decorative English labels are localized without renaming formal abbreviations", async () => {
  const client = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  for (const label of ["SERVER CONNECTION", "GOGYO TENRIN", "CPU MATCH", "ONLINE MATCH", "INITIAL ATTRIBUTE", "ATTRIBUTE REVEAL", ">REACTION<", "HOW TO PLAY", "CARD CATALOG", "COST ", "ATK "]) {
    assert.doesNotMatch(client, new RegExp(label));
  }
  for (const label of ["霊脈接続", "五行の巡り", "五行選択", "防御判断", "遊び方", "収録札", "コスト ", "攻 "]) {
    assert.match(client, new RegExp(label));
  }
  assert.match(client, /HP /);
  assert.match(client, /霊気/);
});

test("card imagery is part of the shared client protocol", async () => {
  const protocol = await readFile(path.join(repositoryRoot, "shared", "protocol.ts"), "utf8");
  const server = await readFile(path.join(repositoryRoot, "server", "index.ts"), "utf8");
  assert.equal((protocol.match(/imageId\?: string/g) ?? []).length >= 2, true);
  assert.match(server, /imageId:card\.imageId/);
  assert.match(server, /imageId:selected\.imageId/);
});
