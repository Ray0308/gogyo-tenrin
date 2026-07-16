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
  const css = await readFile(path.join(repositoryRoot, "client", "battle-v2.css"), "utf8");
  assert.match(source, /settings\.speed === "fast" \? 650 : settings\.speed === "slow" \? 1500 : 1000/);
  assert.match(source, /function presentationGap/);
  assert.match(css, /animation-duration:.*--combat-duration/);
  assert.match(source, /orderBattleVisualChanges/);
  assert.match(source, /variant: `impact \$\{change\.type\}`/);
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

test("opponent actions wait for acknowledgement or advance after five seconds", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "battle-v2.css"), "utf8");
  assert.match(source, /showOpponentAcknowledgement/);
  assert.match(source, /buildOpponentAckDetail/);
  assert.match(source, /了解　次へ/);
  assert.match(source, /相手が使用/);
  assert.match(source, /usedCard\?\.effectText/);
  assert.match(source, /change\.amount.*ダメージ/);
  assert.match(source, /Date\.now\(\) \+ 5_000/);
  assert.match(source, /setTimeout\(resolveOpponentAcknowledgement, 5_000\)/);
  assert.match(source, /change\.side === "cpu"/);
  assert.match(css, /\.opponent-ack-layer/);
  assert.match(css, /\.opponent-ack button/);
  assert.match(css, /\.opponent-ack-summary/);
});

test("battle state is revealed at its result cue and completion unlocks the next action", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  assert.match(source, /let pendingPresentationState: SessionState \| null = null/);
  assert.match(source, /const baselineState = pendingPresentationState \?\? state/);
  assert.match(source, /pendingPresentationState = nextState;[\s\S]*presentationCompletionPending = true;[\s\S]*animateBattleChanges\(changes\)/);
  assert.match(source, /function revealPendingPresentationState/);
  assert.match(source, /socket\.emit\("presentation:complete"\)/);
  assert.match(source, /else commitPendingPresentationState\(\)/);
  assert.match(source, /if \(enteringReaction \|\| nextState\.phase !== "battle"\)/);
});

test("reaction decisions preempt presentation and do not run behind animations", async () => {
  const client = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const server = await readFile(path.join(repositoryRoot, "server", "index.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "styles.css"), "utf8");
  assert.match(client, /function cancelBattlePresentation/);
  assert.match(client, /if \(enteringReaction \|\| nextState\.phase !== "battle"\) \{/);
  assert.match(client, /cancelBattlePresentation\(\);\s*applyDisplayedState\(nextState\)/);
  assert.match(client, /battlePresentationLocked\(\) && !reactionInteraction/);
  assert.match(client, /let presentationBlockedByReaction = false/);
  assert.match(client, /generation !== battlePresentationGeneration \|\| presentationBlockedByReaction/);
  assert.match(client, /presentationBlockedByReaction = enteringReaction/);
  assert.match(css, /\.reaction-panel\{z-index:120!important\}/);
  assert.match(server, /pausedTurnRemainingMs/);
  assert.match(server, /if\(pausedTurnSide\)clearTurnTimer\(session\)/);
  assert.match(server, /pending\.pausedTurnSide===battle\.activePlayer/);
  assert.match(server, /if\(session\.pendingReaction\|\|battle\.phase==="reaction"\|\|session\.presentationContinuation\)return/);
  assert.match(server, /if\(session\.pendingReaction\|\|state\.battle\?\.phase==="reaction"\|\|session\.presentationContinuation\)return/);
  assert.match(client, /選択完了まで対戦処理は停止中/);
});

test("reaction window closes immediately and separates consecutive reactions", async () => {
  const client = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "card-ui.css"), "utf8");
  assert.match(client, /let reactionSubmitting = false/);
  assert.match(client, /reaction && !reactionSubmitting/);
  assert.match(client, /submittedReactionDeadline = state\.battle\?\.reaction\?\.deadline/);
  assert.match(client, /document\.querySelector\("\.reaction-panel"\)\?\.remove\(\)/);
  assert.match(client, /防御結果を処理中/);
  assert.match(client, /}, 360\)/);
  assert.match(css, /\.reaction-resolving/);
});

test("field attacks make each shikigami visibly tappable and cancelling fully resets selection", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  assert.match(source, /enemyFieldTarget/);
  assert.match(source, /data-target="cpu_field"/);
  assert.match(source, /function clearCardSelection/);
  assert.match(source, /action === "cancel-target"\) \{ clearCardSelection\(\)/);
});

test("title and in-battle rules expose the shared card catalog", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "catalog.css"), "utf8");
  assert.match(source, /data-action="catalog"><span>カード一覧/);
  assert.match(source, /button\("カード一覧を見る", "catalog"/);
  assert.match(source, /fetch\("\/api\/cards"\)/);
  assert.match(css, /\.catalog-grid/);
});

test("rules explain curses, keywords, reactions, and counterattack order", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "catalog.css"), "utf8");
  for (const topic of ["呪いと状態", "キーワード能力", "防御・反応", "攻撃と反撃の順序", "貫通", "反撃から反撃は発生しません"]) {
    assert.match(source, new RegExp(topic));
  }
  assert.match(css, /\.rules-guide/);
  assert.match(css, /\.rule-grid/);
  assert.match(css, /\.rule-flow/);
});

test("CPU turn presents a deliberate start pause", async () => {
  const server = await readFile(path.join(repositoryRoot, "server", "index.ts"), "utf8");
  assert.match(server, /CPU_TURN_START_DELAY_MS=Number\(process\.env\.CPU_TURN_START_DELAY_MS\?\?1_200\)/);
  assert.match(server, /scheduleCpuTurn\(session\)/);
});

test("title cycles five elemental shikigami around a five-element circle and overcoming star", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "title.css"), "utf8");
  assert.match(source, /class="title-gallery"/);
  for (const shikigami of ["kanko", "hinotori", "genki", "hakuro", "kappa"]) {
    assert.match(source, new RegExp(`img_shikigami_${shikigami}\\.png`));
  }
  assert.equal((source.match(/class="title-slide title-slide-/g) ?? []).length, 5);
  assert.match(source, /five-star-cycle/);
  assert.match(source, /five-star-overcome/);
  assert.match(source, /polyline/);
  for (const element of ["wood", "fire", "earth", "metal", "water"]) {
    assert.match(css, new RegExp(`\\.five-node-${element}`));
  }
  assert.match(css, /\.title-lobby[\s\S]*align-items:\s*stretch/);
  assert.match(css, /@keyframes title-slide-cycle/);
  assert.match(css, /\.title-slide:first-child[\s\S]*opacity:\s*\.96/);
});

test("initial attribute selection uses a compact five-element wheel", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "title.css"), "utf8");
  assert.match(source, /class="attribute-wheel"/);
  assert.match(source, /attribute-choice-/);
  assert.match(source, /attribute-screen/);
  assert.match(css, /\.attribute-wheel[\s\S]*aspect-ratio:\s*1/);
  assert.match(css, /\.attribute-screen \.ambient-ring[\s\S]*display:\s*none/);
});

test("card effects can expand into practical Japanese guidance", async () => {
  const source = await readFile(path.join(repositoryRoot, "client", "main.ts"), "utf8");
  const css = await readFile(path.join(repositoryRoot, "client", "card-ui.css"), "utf8");
  for (const terrain of [
    "card_terrain_chinju_forest",
    "card_terrain_scorched_earth",
    "card_terrain_clear_stream",
    "card_terrain_mineral_vein",
    "card_terrain_sacred_domain",
    "card_terrain_yomi_road",
  ]) {
    assert.match(source, new RegExp(terrain));
  }
  assert.match(source, /data-action="toggle-effect-details"/);
  assert.match(source, /タップで詳しく見る/);
  assert.match(source, /function renderMechanicGuide/);
  assert.match(source, /localizeUiMessage\(card\.unusableReason/);
  assert.match(source, /document\.querySelector\("\.modal-backdrop"\)\?\.remove\(\)/);
  assert.match(css, /\.card-effect-copy > button/);
  assert.match(css, /\.mechanic-guide/);
  assert.match(css, /\.modal-backdrop[\s\S]*z-index:\s*140/);
});
