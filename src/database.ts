import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS creators (
  creator_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS creator_attribution_rules (
  signal_type TEXT NOT NULL CHECK (signal_type IN ('coupon', 'utm')),
  signal_value TEXT NOT NULL,
  creator_id TEXT NOT NULL REFERENCES creators(creator_id),
  PRIMARY KEY (signal_type, signal_value)
) STRICT;

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  refunded_total_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL CHECK (currency = 'BRL'),
  status TEXT NOT NULL CHECK (status = 'paid'),
  coupon TEXT,
  utm_json TEXT,
  payload_fingerprint TEXT NOT NULL,
  creator_id TEXT REFERENCES creators(creator_id),
  attribution_source TEXT NOT NULL CHECK (attribution_source IN ('coupon', 'utm', 'none')),
  created_at TEXT NOT NULL,
  CHECK (refunded_total_cents >= 0 AND refunded_total_cents <= total_cents),
  CHECK ((creator_id IS NULL AND attribution_source = 'none') OR
         (creator_id IS NOT NULL AND attribution_source IN ('coupon', 'utm')))
) STRICT;

CREATE TABLE IF NOT EXISTS refunds (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL,
  requested_cents INTEGER NOT NULL CHECK (requested_cents > 0),
  applied_cents INTEGER NOT NULL DEFAULT 0 CHECK (applied_cents >= 0),
  excess_cents INTEGER NOT NULL DEFAULT 0 CHECK (excess_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING_ORDER', 'APPLIED', 'CLAMPED')),
  payload_fingerprint TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied_order_id TEXT REFERENCES orders(order_id),
  applied_at TEXT,
  CHECK (requested_cents = applied_cents + excess_cents OR status = 'PENDING_ORDER'),
  CHECK (
    (status = 'PENDING_ORDER' AND applied_cents = 0 AND excess_cents = 0 AND applied_order_id IS NULL AND applied_at IS NULL)
    OR
    (status = 'APPLIED' AND applied_cents = requested_cents AND excess_cents = 0 AND applied_order_id = order_id AND applied_at IS NOT NULL)
    OR
    (status = 'CLAMPED' AND applied_cents + excess_cents = requested_cents AND excess_cents > 0 AND applied_order_id = order_id AND applied_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS refunds_by_order_and_sequence ON refunds(order_id, sequence);

CREATE TRIGGER IF NOT EXISTS refund_applied_total_insert
BEFORE INSERT ON refunds
WHEN NEW.status IN ('APPLIED', 'CLAMPED')
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM orders
      WHERE order_id = NEW.order_id
        AND refunded_total_cents <= total_cents
        AND refunded_total_cents = NEW.applied_cents + COALESCE((
          SELECT SUM(applied_cents) FROM refunds WHERE order_id = NEW.order_id
        ), 0)
    ) THEN RAISE(ABORT, 'refund exceeds available order balance')
  END;
END;

CREATE TRIGGER IF NOT EXISTS refund_applied_total_update
BEFORE UPDATE ON refunds
WHEN NEW.status IN ('APPLIED', 'CLAMPED')
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM orders
      WHERE order_id = NEW.order_id
        AND refunded_total_cents <= total_cents
        AND refunded_total_cents = NEW.applied_cents + COALESCE((
          SELECT SUM(applied_cents) FROM refunds
          WHERE order_id = NEW.order_id AND sequence <> NEW.sequence
        ), 0)
    ) THEN RAISE(ABORT, 'refund exceeds available order balance')
  END;
END;
`;

export function createDatabase(path = process.env.DB_PATH ?? "data/vendas.sqlite"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const database = new DatabaseSync(path, { timeout: 5000 });
  database.exec(SCHEMA);
  return database;
}

export function inTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function seedCreators(database: DatabaseSync): void {
  inTransaction(database, () => {
    const creator = database.prepare("INSERT INTO creators (creator_id, name) VALUES (?, ?) ON CONFLICT (creator_id) DO NOTHING");
    creator.run("creator_01", "Maria Silva");
    creator.run("creator_02", "João Costa");

    const rule = database.prepare("INSERT INTO creator_attribution_rules (signal_type, signal_value, creator_id) VALUES (?, ?, ?) ON CONFLICT (signal_type, signal_value) DO NOTHING");
    rule.run("coupon", "MARIA10", "creator_01");
    rule.run("coupon", "JOAO15", "creator_02");
    rule.run("utm", "creator_01", "creator_01");
    rule.run("utm", "creator_02", "creator_02");
  });
}
