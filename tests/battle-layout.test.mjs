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
