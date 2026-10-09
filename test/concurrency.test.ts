import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, seedCreators } from "../src/database.js";
import { ingestOrder } from "../src/service.js";

function runRefundWorker(path: string, id: string) {
  return new Promise<{ duplicate: boolean; refund: { applied_cents: number; excess_cents: number } }>((resolve, reject) => {
    const worker = new Worker(new URL("./concurrency.worker.ts", import.meta.url), {
      workerData: { path, refund: { id, order_id: "concurrent_order", amount_cents: 15000 } },
      execArgv: ["--import", "tsx"],
    });
    worker.once("message", (message: { duplicate?: boolean; refund?: { applied_cents: number; excess_cents: number }; error?: string }) => {
      if (message.error || !message.refund) reject(new Error(message.error ?? "Worker returned an invalid response"));
      else resolve(message as { duplicate: boolean; refund: { applied_cents: number; excess_cents: number } });
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
    });
  });
}

describe("independent SQLite writer concurrency", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("never applies competing refunds beyond the order total", async () => {
    directory = mkdtempSync(join(tmpdir(), "conty-concurrency-"));
    const path = join(directory, "sales.sqlite");
    const database = createDatabase(path);
    seedCreators(database);
    ingestOrder(database, {
      id: "concurrent_order",
      total_cents: 20000,
      currency: "BRL",
      status: "paid",
      coupon: "MARIA10",
    });
    database.close();

    const results = await Promise.all([runRefundWorker(path, "refund_a"), runRefundWorker(path, "refund_b")]);
    expect(results.map((result) => [result.refund.applied_cents, result.refund.excess_cents]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [5000, 10000],
      [15000, 0],
    ]);

    const check = createDatabase(path);
    try {
      expect(check.prepare("SELECT refunded_total_cents FROM orders WHERE order_id = ?").get("concurrent_order")).toEqual({ refunded_total_cents: 20000 });
      expect(check.prepare("SELECT SUM(applied_cents) AS applied FROM refunds WHERE order_id = ?").get("concurrent_order")).toEqual({ applied: 20000 });
    } finally {
      check.close();
    }
  }, 20000);
});
