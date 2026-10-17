
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "./index";

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
  it("does not require x402 payment for reservation routes", async () => {
    const response = await worker.request(
      "/v1/tasks/test-task-id/reservations",
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
});
