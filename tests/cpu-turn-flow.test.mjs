import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const waitFor = (socket, event) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 5000);
  socket.once(event, (...args) => { clearTimeout(timeout); resolve(args); });
});

const emit = (socket, event, payload) => new Promise((resolve) => {
  if (payload === undefined) socket.emit(event, resolve);
  else socket.emit(event, payload, resolve);
});

const expectNoEvent = (socket, event, duration = 60) => new Promise((resolve, reject) => {
  const onEvent = () => {
    clearTimeout(timeout);
    reject(new Error(`Unexpected ${event} while reaction input is pending`));
  };
  const timeout = setTimeout(() => {
    socket.off(event, onEvent);
    resolve();
  }, duration);
  socket.once(event, onEvent);
});

test("CPU turn completes after the player ends the turn", async () => {
  process.env.PORT = "0";
  process.env.CPU_TURN_START_DELAY_MS = "20";
  const serverModule = await import("../dist/server/index.js");
  if (!serverModule.server.listening) await new Promise((resolve) => serverModule.server.once("listening", resolve));
  const address = serverModule.server.address();
  assert.equal(typeof address, "object");

  const source = await readFile(new URL("../node_modules/socket.io/client-dist/socket.io.esm.min.js", import.meta.url), "utf8");
  const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const url = `http://127.0.0.1:${address.port}`;

  try {
    for (let game = 0; game < 30; game += 1) {
      const socket = client.io(url, { transports: ["websocket"], forceNew: true });
      try {
        await waitFor(socket, "connect");
        assert.equal((await emit(socket, "cpu:start", { playerName: "Tester", poolMode: "core" })).ok, true);
        assert.equal((await emit(socket, "attribute:select", { attribute: "wood" })).ok, true);
        const entered = await emit(socket, "match:enter");
        assert.equal(entered.state.battle.activePlayer, "player");
        assert.equal(entered.state.battle.player.hp, 40);
        assert.equal(entered.state.battle.cpu.hp, 40);
        assert.equal(entered.state.battle.player.mp, 10);
        assert.equal(entered.state.battle.cpu.mp, 10);
        const openingHandIds = new Set(entered.state.battle.player.hand.map((card) => card.instanceId));
        for (const card of entered.state.battle.player.hand) {
          assert.match(card.cardId, /^card_(reidan|zanfu|shufu|tenrin|summon)_/);
        }

        const cpuStartUpdate = waitFor(socket, "session:state");
        let result = await emit(socket, "turn:end");
        assert.equal(result.ok, true);
        assert.equal(result.state.battle.activePlayer, "cpu");
        assert.equal(result.state.battle.phase, "resolving");
        await cpuStartUpdate;
        socket.emit("presentation:complete");

        const cpuStartedAt = Date.now();
        const [cpuState] = await waitFor(socket, "session:state");
        result = { ok: true, state: cpuState };
        assert.ok(Date.now() - cpuStartedAt >= 15, "CPU should pause before taking its first action");
        if (result.state.battle.activePlayer === "cpu" && result.state.battle.phase === "resolving") {
          await expectNoEvent(socket, "session:state", 60);
        }

        for (let steps = 0; result.state.battle.activePlayer === "cpu" && steps < 40; steps += 1) {
          if (result.state.battle.phase === "reaction") {
            await expectNoEvent(socket, "session:state");
            const reactionUpdate = waitFor(socket, "session:state");
            const response = await emit(socket, "reaction:respond", {});
            assert.equal(response.ok, true, response.message);
            const [reactionState] = await reactionUpdate;
            result = { ok: true, state: reactionState };
            continue;
          }
          const nextStep = waitFor(socket, "session:state");
          socket.emit("presentation:complete");
          const [nextState] = await nextStep;
          result = { ok: true, state: nextState };
        }

        assert.equal(result.state.battle.turnNumber, 2);
        assert.equal(result.state.battle.activePlayer, "player");
        assert.equal(result.state.battle.phase, "card_use");
        assert.equal(result.state.battle.player.hand.length, 5);
        assert.equal(result.state.battle.player.discard.length, 5);
        assert.equal(result.state.battle.player.hand.some((card) => openingHandIds.has(card.instanceId)), false);
      } finally {
        if (socket.connected) await emit(socket, "session:reset").catch(() => undefined);
        socket.close();
      }
    }
  } finally {
    await new Promise((resolve) => serverModule.io.close(resolve));
    if (serverModule.server.listening) await new Promise((resolve) => serverModule.server.close(resolve));
  }
});
