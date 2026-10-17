
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

test("task budget cannot be exceeded by reservations", () => {
  const db = new DatabaseSync(":memory:");

  try {
    db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

    db.prepare(`
      INSERT INTO tasks
        (task_id, token_hash, currency, budget_micros)
      VALUES (?, ?, ?, ?)
    `).run("task-test", "hash-test", "USDC", 2_000_000);

    const reserve = db.prepare(`
      UPDATE tasks
      SET reserved_micros = reserved_micros + ?
      WHERE task_id = ?
        AND spent_micros + reserved_micros + ? <= budget_micros
    `);

    assert.equal(
      reserve.run(750_000, "task-test", 750_000).changes,
      1
    );
    assert.equal(
      reserve.run(750_000, "task-test", 750_000).changes,
      1
    );
    assert.equal(
      reserve.run(750_000, "task-test", 750_000).changes,
      0
    );

    const task = db.prepare(
      "SELECT budget_micros, reserved_micros FROM tasks WHERE task_id = ?"
    ).get("task-test");

    assert.equal(task.budget_micros, 2_000_000);
    assert.equal(task.reserved_micros, 1_500_000);
  } finally {
    db.close();
  }
});
