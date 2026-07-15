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

test("online room reaches a shared battle with private hands", async () => {
  process.env.PORT = "0";
  const serverModule = await import("../dist/server/index.js");
  if (!serverModule.server.listening) await new Promise((resolve) => serverModule.server.once("listening", resolve));
  const address = serverModule.server.address();
  assert.equal(typeof address, "object");
  const source = await readFile(new URL("../node_modules/socket.io/client-dist/socket.io.esm.min.js", import.meta.url), "utf8");
  const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const url = `http://127.0.0.1:${address.port}`;
  const host = client.io(url, { transports: ["websocket"], forceNew: true });
  const guest = client.io(url, { transports: ["websocket"], forceNew: true });
  try {
    await Promise.all([waitFor(host, "connect"), waitFor(guest, "connect")]);
    const created = await emit(host, "room:create", { playerName: "Host" });
    assert.equal(created.ok, true);
    assert.equal(created.state.phase, "room_waiting");
    const joined = await emit(guest, "room:join", { playerName: "Guest", roomId: created.state.roomId });
    assert.equal(joined.state.role, "guest");
    assert.equal((await emit(host, "room:start")).state.phase, "attribute_selection");
    await emit(host, "attribute:select", { attribute: "wood" });
    const selected = await emit(guest, "attribute:select", { attribute: "fire" });
    assert.equal(selected.state.phase, "attribute_reveal");
    const hostBattle = await emit(host, "match:enter");
    const guestBattle = await emit(guest, "match:enter");
    assert.equal(hostBattle.state.battle.player.hp, 40);
    assert.equal(hostBattle.state.battle.player.mp, 10);
    assert.equal(guestBattle.state.battle.player.hp, 40);
    assert.equal(guestBattle.state.battle.player.mp, 10);
    assert.equal(hostBattle.state.battle.player.hand.length, 5);
    assert.equal(guestBattle.state.battle.player.hand.length, 5);
    assert.equal(Object.hasOwn(guestBattle.state.battle.cpu, "hand"), false);
    assert.equal(Object.hasOwn(guestBattle.state.battle.cpu, "discard"), false);
    assert.equal(hostBattle.state.battle.activePlayer, "player");
    assert.equal(guestBattle.state.battle.activePlayer, "cpu");
    assert.equal(guestBattle.state.battle.player.hand.some((card) => card.playable), false);
    const card = hostBattle.state.battle.player.hand.find((item) => item.playable);
    if (card) {
      const targetByMode = { cpu_player: "cpu_player", cpu_unit: "cpu_player", cpu_any: "cpu_player", cpu_field: "cpu_field", player: "player", player_unit: "player", player_field: "player_field", shared_field: "shared_field", retired_unit: "player" };
      const used = await emit(host, "card:use", { instanceId: card.instanceId, target: targetByMode[card.playTarget] ?? "player", choice: card.choiceOptions?.[0]?.value });
      assert.equal(used.ok, true);
      assert.ok(used.state.battle.player.hand.length <= 5);
    }
    await emit(host, "room:leave");
  } finally {
    if (host.connected) await emit(host, "room:leave").catch(() => undefined);
    host.close(); guest.close();
    await new Promise((resolve) => serverModule.io.close(resolve));
    if (serverModule.server.listening) await new Promise((resolve) => serverModule.server.close(resolve));
  }
});
