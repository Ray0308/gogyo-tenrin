import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { repositoryRoot } from "../scripts/lib/master-data.mjs";

test("hand cards use imagery and expose a long-press detail view", async () => {
  const client = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "card-ui.css"), "utf8");
  assert.match(client, /function cardArtPath/);
  assert.match(client, /renderCardArt\(card, true\)/);
  assert.match(client, /長押しで詳細/);
  assert.match(client, /window\.setTimeout\([\s\S]*420/);
  assert.match(css, /\.hand-card-simple/);
  assert.match(css, /\.card-detail-rich/);
});

test("card details translate jargon without replacing the official terms", async () => {
  const client = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  for (const term of ["転輪", "相生", "相剋", "属性一致", "ステルス", "反撃", "地形"]) {
    assert.match(client, new RegExp(`"${term}"\s*:`));
  }
  assert.match(client, /かんたんに言うと/);
  assert.match(client, /このカードの用語/);
  assert.match(client, /plainCardGuide/);
});

test("terrain and the first CPU battle provide contextual guidance", async () => {
  const client = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  assert.match(client, /data-action="terrain-info"/);
  assert.match(client, /共有地形 · 両者に影響/);
  assert.match(client, /gogyo-tenrin-beginner-guide-v1/);
  assert.match(client, /はじめての対戦/);
  assert.match(client, /次にできること/);
});

test("card imagery is part of the shared client protocol", async () => {
  const protocol = await readFile(path.join(repositoryRoot, "shared", "protocol.ts"), "utf8");
  const server = await readFile(path.join(repositoryRoot, "server", "index.ts"), "utf8");
  assert.equal((protocol.match(/imageId\?: string/g) ?? []).length >= 2, true);
  assert.match(server, /imageId:card\.imageId/);
  assert.match(server, /imageId:selected\.imageId/);
});
