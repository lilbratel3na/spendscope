import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "./index";
import { sha256Hex } from "./money.js";

describe("SpendScope Worker API", () => {
  it("returns healthy status", async () => {
    const response = await worker.request("/health", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "spendscope",
    });
  });

  it("serves the public root route", async () => {
    const response = await worker.request("/", {}, env);
    expect(response.status).toBe(200);
  });

  it("serves the OpenAPI document", async () => {
    const response = await worker.request("/openapi.json", {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/json",
    );
  });

  it("rejects reservation requests without a task token", async () => {
    const response = await worker.request(
      "/v1/tasks/missing-task/reservations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          amount: "1",
          currency: "USDC",
          reservationId: "test-reservation-001",
        }),
      },
      env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "unauthorized_or_unknown_task",
    });
  });

  it("allows reservations within budget and blocks overspending", async () => {
    const taskId = `budget-test-${crypto.randomUUID()}`;
    const token = `test-token-${crypto.randomUUID()}-secure`;
    const tokenHash = await sha256Hex(token);

    await env.DB.prepare(`
      INSERT INTO tasks
        (task_id, token_hash, currency, budget_micros)
      VALUES (?, ?, 'USDC', 2000000)
    `).bind(taskId, tokenHash).run();

    const headers = {
      "content-type": "application/json",
      "x-spendscope-task-token": token,
    };

    const reserve = (reservationId: string, amount: string) =>
      worker.request(`/v1/tasks/${taskId}/reservations`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          reservationId,
          amount,
          currency: "USDC",
        }),
      }, env);

    const first = await reserve("reserve-test-0001", "0.75");
    expect(first.status).toBe(201);
    expect((await first.json() as any).decision).toBe("ALLOW");

    const second = await reserve("reserve-test-0002", "0.75");
    expect(second.status).toBe(201);
    expect((await second.json() as any).decision).toBe("ALLOW");

    const third = await reserve("reserve-test-0003", "0.75");
    expect(third.status).toBe(409);
    expect((await third.json() as any).reason).toBe(
      "task_budget_exceeded",
    );

    const stateResponse = await worker.request(`/v1/tasks/${taskId}`, {
      headers: { "x-spendscope-task-token": token },
    }, env);

    expect(stateResponse.status).toBe(200);
    const state = await stateResponse.json() as any;
    expect(state.budget).toBe("2");
    expect(state.reserved).toBe("1.5");
    expect(state.remaining).toBe("0.5");
  });

  it("releases a reservation and restores available budget", async () => {
    const taskId = `release-test-${crypto.randomUUID()}`;
    const token = `test-token-${crypto.randomUUID()}-secure`;
    const tokenHash = await sha256Hex(token);

    await env.DB.prepare(`
      INSERT INTO tasks
        (task_id, token_hash, currency, budget_micros)
      VALUES (?, ?, 'USDC', 1000000)
    `).bind(taskId, tokenHash).run();

    await env.DB.prepare(`
      INSERT INTO reservations
        (reservation_id, task_id, amount_micros, status)
      VALUES (?, ?, 750000, 'reserved')
    `).bind("release-test-0001", taskId).run();

    await env.DB.prepare(`
      UPDATE tasks SET reserved_micros = 750000 WHERE task_id = ?
    `).bind(taskId).run();

    const response = await worker.request(
      `/v1/tasks/${taskId}/reservations/release-test-0001/release`,
      {
        method: "POST",
        headers: { "x-spendscope-task-token": token },
      },
      env,
    );

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.status).toBe("released");
    expect(result.reserved).toBe("0");
    expect(result.remaining).toBe("1");
  });
});