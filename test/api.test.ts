import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDatabase, seedCreators } from "../src/database.js";

function harness(path = ":memory:") {
  const database = createDatabase(path);
  seedCreators(database);
  const app = buildApp({ database });
  return { app, database };
}

const order = (overrides: Record<string, unknown> = {}) => ({
  id: "order_1001",
  total_cents: 20000,
  currency: "BRL",
  status: "paid",
  coupon: "MARIA10",
  utm: { content: "creator_02", source: "instagram" },
  ...overrides,
});

const refund = (overrides: Record<string, unknown> = {}) => ({
  id: "refund_001",
  order_id: "order_1001",
  amount_cents: 5000,
  ...overrides,
});

describe("sales and refund webhooks", () => {
  const apps: Array<ReturnType<typeof harness>> = [];
  const tempDirectories: string[] = [];

  function makeHarness(path?: string) {
    const instance = harness(path);
    apps.push(instance);
    return instance;
  }

  afterEach(async () => {
    for (const instance of apps.splice(0)) {
      await instance.app.close();
      if (instance.database.isOpen) instance.database.close();
    }
    for (const path of tempDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("creates a single attributed sale when the order webhook is repeated", async () => {
    const { app, database } = makeHarness();
    const first = await app.inject({ method: "POST", url: "/webhooks/orders", payload: order() });
    const repeated = await app.inject({ method: "POST", url: "/webhooks/orders", payload: order() });

    expect(first.statusCode).toBe(201);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().duplicate).toBe(true);
    expect(repeated.json().order.creator_id).toBe("creator_01");
    expect(database.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 1 });
    expect(repeated.json().net_attributed_cents).toBe(20000);
  });

  it("accepts equivalent normalized payloads and rejects conflicting order IDs", async () => {
    const { app } = makeHarness();
    await app.inject({ method: "POST", url: "/webhooks/orders", payload: order() });

    const equivalent = await app.inject({
      method: "POST",
      url: "/webhooks/orders",
      payload: order({ coupon: " maria10 ", utm: { source: " instagram ", content: " creator_02 " } }),
    });
    const conflict = await app.inject({ method: "POST", url: "/webhooks/orders", payload: order({ total_cents: 30000 }) });

    expect(equivalent.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
  });

  it("applies partial and total refunds once and records the amount above the sale", async () => {
    const { app } = makeHarness();
    await app.inject({ method: "POST", url: "/webhooks/orders", payload: order() });

    const partial = await app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund({ amount_cents: 5000 }) });
    const duplicate = await app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund({ amount_cents: 5000 }) });
    const total = await app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund({ id: "refund_002", amount_cents: 15000 }) });
    const tooMuch = await app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund({ id: "refund_003", amount_cents: 1000 }) });
    const result = await app.inject({ method: "GET", url: "/orders/order_1001/attribution" });

    expect(partial.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().refund.applied_cents).toBe(5000);
    expect(total.json().refund.status).toBe("APPLIED");
    expect(tooMuch.json().refund).toMatchObject({ status: "CLAMPED", applied_cents: 0, excess_cents: 1000 });
    expect(result.json()).toMatchObject({
      net_attributed_cents: 0,
      order: { total_cents: 20000, refunded_total_cents: 20000, creator_id: "creator_01" },
    });
    expect(result.json().order.refunds).toHaveLength(3);
  });

  it("preserves an early refund and applies it when the order arrives", async () => {
    const { app } = makeHarness();
    const early = await app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund({ amount_cents: 5000 }) });
    const pendingView = await app.inject({ method: "GET", url: "/orders/order_1001/attribution" });
    const created = await app.inject({ method: "POST", url: "/webhooks/orders", payload: order() });
    const repeated = await app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund({ amount_cents: 5000 }) });

    expect(early.statusCode).toBe(202);
    expect(pendingView.json()).toMatchObject({ order_received: false, original_total_cents: null });
    expect(created.json()).toMatchObject({ order: { refunded_total_cents: 5000 }, net_attributed_cents: 15000 });
    expect(repeated.json()).toMatchObject({ duplicate: true, refund: { status: "APPLIED", applied_cents: 5000 } });
  });

  it("reconciles multiple pending refunds in receive order and clamps the excess", async () => {
    const { app, database } = makeHarness();
    await app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund({ id: "refund_a", amount_cents: 12000 }) });
    await app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund({ id: "refund_b", amount_cents: 12000 }) });
    const created = await app.inject({ method: "POST", url: "/webhooks/orders", payload: order({ total_cents: 20000 }) });

    expect(created.json().order.refunded_total_cents).toBe(20000);
    expect(created.json().order.refunds.map((entry: { status: string; applied_cents: number; excess_cents: number }) => ({
      status: entry.status,
      applied_cents: entry.applied_cents,
      excess_cents: entry.excess_cents,
    }))).toEqual([
      { status: "APPLIED", applied_cents: 12000, excess_cents: 0 },
      { status: "CLAMPED", applied_cents: 8000, excess_cents: 4000 },
    ]);
    expect(database.prepare("SELECT SUM(applied_cents) AS applied FROM refunds").get()).toEqual({ applied: 20000 });
  });

  it("returns a conflict when an existing refund ID is reused with a different payload", async () => {
    const { app } = makeHarness();
    await app.inject({ method: "POST", url: "/webhooks/orders", payload: order() });
    await app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund() });
    const conflict = await app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund({ amount_cents: 6000 }) });

    expect(conflict.statusCode).toBe(409);
  });

  it("validates paid BRL orders and leaves unmatched orders unattributed", async () => {
    const { app } = makeHarness();
    const invalid = await app.inject({ method: "POST", url: "/webhooks/orders", payload: order({ status: "pending" }) });
    const unmatched = await app.inject({
      method: "POST",
      url: "/webhooks/orders",
      payload: order({ id: "order_unmatched", coupon: "UNKNOWN", utm: { content: "unknown" } }),
    });

    expect(invalid.statusCode).toBe(400);
    expect(unmatched.json()).toMatchObject({ order: { creator_id: null, attribution_source: "none" }, net_attributed_cents: 0 });
  });

  it("preserves pending refunds across a database restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conty-sales-"));
    tempDirectories.push(directory);
    const path = join(directory, "sales.sqlite");
    const first = makeHarness(path);
    const pending = await first.app.inject({ method: "POST", url: "/webhooks/refunds", payload: refund() });
    expect(pending.statusCode).toBe(202);
    await first.app.close();
    first.database.close();
    apps.splice(apps.indexOf(first), 1);

    const second = makeHarness(path);
    const orderResult = await second.app.inject({ method: "POST", url: "/webhooks/orders", payload: order() });
    expect(orderResult.json()).toMatchObject({ order: { refunded_total_cents: 5000 }, net_attributed_cents: 15000 });
  });
});
