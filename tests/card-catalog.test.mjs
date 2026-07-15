import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

test("public card catalog exposes the complete implementation pool", async () => {
  process.env.PORT = "0";
  const { server } = await import("../dist/server/index.js");
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/api/cards`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.cards.length, 90);
  assert.ok(payload.cards.every((card) => card.cardId && card.name && card.effectText));
  assert.equal("weight" in payload.cards[0], false);

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
