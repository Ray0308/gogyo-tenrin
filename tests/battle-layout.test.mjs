import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { repositoryRoot } from "../scripts/lib/master-data.mjs";

test("battle UI uses a fixed board and bottom command console", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "battle-v2.css"), "utf8");

  assert.match(source, /class="battle-board"/);
  assert.match(source, /class="hand battle-console"/);
  assert.match(source, /class="battle-command-row"/);
  assert.match(source, /class="battle-utility"/);
  assert.match(css, /height:\s*100svh/);
  assert.match(css, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
});

test("battle redesign retains all primary battle actions", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  for (const action of ["end-turn", "rules", "settings", "reset"]) {
    assert.match(source, new RegExp(`data-action="${action}"|button\\([^\\n]+,\\s*"${action}"`));
  }
});

test("target guidance and battle motion effects are present", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "battle-v2.css"), "utf8");
  assert.match(source, /target-option/);
  assert.match(source, /金色に光っている対象/);
  assert.match(source, /showReidanProjectile/);
  assert.match(css, /\.target-badge/);
  assert.match(css, /\.reidan-projectile/);
  assert.match(css, /shikigami-lunge-up/);
});

test("turn labels use the local player perspective", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  assert.doesNotMatch(source, /title:\s*"CPUのターン"/);
  assert.match(source, /battle\.activePlayer === "player" \? "自分" : "相手"/);
  assert.match(source, /state\.mode === "cpu"/);
});

test("all card systems have a shared presentation effect", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "battle-v2.css"), "utf8");
  for (const system of ["占事略决", "霊符術", "陰陽秘術", "使役術", "結界術", "地脈術", "禁術"]) {
    assert.match(source, new RegExp(`"${system}"`));
  }
  assert.match(source, /showSystemEffect/);
  assert.match(css, /\.card-effect-layer/);
  assert.match(css, /forbidden-effect-ring/);
});

test("battle presentation uses a more readable default pace", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  assert.match(source, /settings\.speed === "fast" \? 600 : settings\.speed === "slow" \? 1250 : 900/);
});

test("dramatic battle HUD shows HP gauges and elemental tension", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "battle-v2.css"), "utf8");
  assert.match(source, /hpGauge/);
  assert.match(source, /elementTension/);
  assert.match(source, /相剋優勢 ＋4/);
  assert.match(css, /\.hp-gauge/);
  assert.match(css, /\.element-tension\.danger/);
});

test("battle presentation locks input and gives retired shikigami a dedicated effect", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "battle-v2.css"), "utf8");
  assert.match(source, /battlePresentationLocked/);
  assert.match(source, /showRetireEffect/);
  assert.match(css, /battle-presentation-locked/);
  assert.match(css, /shikigami-retire-layer/);
  assert.match(css, /shikigami-dissolve/);
});
