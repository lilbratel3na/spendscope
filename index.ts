import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { formatUnits, parseMicros, randomToken, sha256Hex } from "./money.js";

type Env = {
  DB: D1Database;
  PAY_TO: string;
  FACILITATOR_URL?: string;
};
type TaskRow = {
  task_id: string; token_hash: string; currency: string;
  budget_micros: number; spent_micros: number; reserved_micros: number;
  created_at: string;
};
const app = new Hono<{ Bindings: Env }>();

app.get("/", c => c.json({
  name: "SpendScope",
  version: "0.2.0",
  description: "Persistent task-level spending reservations for agent workflows.",
  status: "ready",
  endpoints: ["/health", "/openapi.json", "POST /v1/tasks", "GET /v1/tasks/:id", "POST /v1/tasks/:id/reservations", "POST /v1/tasks/:id/reservations/:reservationId/settle", "POST /v1/tasks/:id/reservations/:reservationId/release"],
  important: "SpendScope only governs spends routed through its reservation workflow. PayBox grants and approvals remain authoritative."
}));
app.get("/health", c => c.json({ ok: true, service: "spendscope" }));
app.get("/openapi.json", c => c.json({
  openapi: "3.1.0",
  info: { title: "SpendScope", version: "0.2.0", description: "Persistent task-level budget reservation API" },
  servers: [{ url: new URL(c.req.url).origin }],
  paths: {
    "/v1/tasks": { post: { summary: "Create a task budget", description: "Returns a one-time task bearer token. Store it securely.", responses: { "201": { description: "Task created" }, "402": { description: "x402 payment required" } } } },
    "/v1/tasks/{id}": { get: { summary: "Get task budget and remaining balance", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Budget state" } } } },
    "/v1/tasks/{id}/reservations": { post: { summary: "Atomically reserve budget before a spend", responses: { "201": { description: "Reservation created" }, "409": { description: "Budget exhausted or reservation ID reused" } } } },
    "/v1/tasks/{id}/reservations/{reservationId}/settle": { post: { summary: "Mark reservation settled after independently confirming payment", responses: { "200": { description: "Reservation settled" } } } },
    "/v1/tasks/{id}/reservations/{reservationId}/release": { post: { summary: "Release a reservation only if payment definitely did not occur", responses: { "200": { description: "Reservation released" } } } }
  }
}));

// x402 payments plus Bazaar metadata make these HTTP routes describable to
// compatible discovery catalogs. Catalog inclusion still depends on the facilitator
// and on a client echoing the discovery extension in its paid request.
app.use("*", async (c, next) => {
  if (c.req.path === "/health" || c.req.path === "/" || c.req.path === "/openapi.json") return next();
  if (!c.env.PAY_TO) return c.json({ error: "server_not_configured", detail: "Set PAY_TO before enabling paid routes." }, 503);
  const origin = new URL(c.req.url).origin;
  const facilitator = new HTTPFacilitatorClient({ url: c.env.FACILITATOR_URL || "https://x402.org/facilitator" });
  const resourceServer = new x402ResourceServer(facilitator)
    .register("eip155:84532", new ExactEvmScheme());
  const accepts = [{ scheme: "exact" as const, price: "$0.001", network: "eip155:84532", payTo: c.env.PAY_TO }];
  const jsonMime = "application/json";
  const routes = {
    "POST /v1/tasks": {
      accepts,
      description: "Create a persistent task-level spending budget",
      mimeType: jsonMime,
      resource: { url: `${origin}/v1/tasks`, description: "Create a task budget", mimeType: jsonMime, serviceName: "SpendScope", tags: ["agent-budget", "spending", "finance"] },
      extensions: { ...declareDiscoveryExtension({
        input: { taskId: "research-17", budget: "2", currency: "USDC" },
        bodyType: "json" as const,
        inputSchema: { type: "object", properties: { taskId: { type: "string", description: "Unique task identifier" }, budget: { type: "string", description: "Positive decimal budget, up to six decimal places" }, currency: { type: "string", description: "Budget currency code" } }, required: ["taskId", "budget", "currency"] },
        output: { example: { taskId: "research-17", currency: "USDC", budget: "2", spent: "0", reserved: "0", remaining: "2", taskToken: "returned-once" } }
      }) }
    },
    "GET /v1/tasks/:id": {
      accepts,
      description: "Read the current budget, spent, reserved, and remaining amounts for a task",
      mimeType: jsonMime,
      resource: { url: `${origin}/v1/tasks/demo-task`, description: "Read task budget status", mimeType: jsonMime, serviceName: "SpendScope", tags: ["agent-budget", "spending", "finance"] },
      extensions: { ...declareDiscoveryExtension({
        input: { id: "demo-task" },
        inputSchema: { type: "object", properties: { id: { type: "string", description: "Task identifier" } }, required: ["id"] },
        output: { example: { taskId: "demo-task", currency: "USDC", budget: "2", spent: "0.75", reserved: "0.75", remaining: "0.5" } }
      }) }
    },
    "POST /v1/tasks/:id/reservations": {
      accepts,
      description: "Atomically reserve task budget before a proposed spend",
      mimeType: jsonMime,
      resource: { url: `${origin}/v1/tasks/demo-task/reservations`, description: "Reserve task budget before spending", mimeType: jsonMime, serviceName: "SpendScope", tags: ["agent-budget", "spending", "finance"] },
      extensions: { ...declareDiscoveryExtension({
        input: { reservationId: "call_00000001", amount: "0.75", currency: "USDC" },
        bodyType: "json" as const,
        inputSchema: { type: "object", properties: { reservationId: { type: "string", description: "Unique idempotency key for this spend attempt" }, amount: { type: "string", description: "Positive amount to reserve" }, currency: { type: "string", description: "Must match the task budget currency" } }, required: ["reservationId", "amount", "currency"] },
        output: { example: { decision: "ALLOW", reservationId: "call_00000001", budget: "2", spent: "0", reserved: "0.75", remaining: "1.25" } }
      }) }
    },
    "POST /v1/tasks/:id/reservations/:reservationId/settle": {
      accepts,
      description: "Settle a reservation after independently verifying that payment succeeded",
      mimeType: jsonMime,
      resource: { url: `${origin}/v1/tasks/demo-task/reservations/call_00000001/settle`, description: "Settle a task budget reservation", mimeType: jsonMime, serviceName: "SpendScope", tags: ["agent-budget", "spending", "finance"] },
      extensions: { ...declareDiscoveryExtension({
        input: { confirmationRef: "testnet-tx-or-provider-reference" },
        bodyType: "json" as const,
        inputSchema: { type: "object", properties: { confirmationRef: { type: "string", description: "Evidence reference for the independently verified payment" } }, required: ["confirmationRef"] },
        output: { example: { ok: true, status: "settled", spent: "0.75", reserved: "0", remaining: "1.25" } }
      }) }
    },
    "POST /v1/tasks/:id/reservations/:reservationId/release": {
      accepts,
      description: "Release a reservation only when payment definitely did not occur",
      mimeType: jsonMime,
      resource: { url: `${origin}/v1/tasks/demo-task/reservations/call_00000001/release`, description: "Release an unpaid task budget reservation", mimeType: jsonMime, serviceName: "SpendScope", tags: ["agent-budget", "spending", "finance"] },
      extensions: { ...declareDiscoveryExtension({
        input: {},
        bodyType: "json" as const,
        inputSchema: { type: "object", properties: {} },
        output: { example: { ok: true, status: "released", spent: "0", reserved: "0", remaining: "2" } }
      }) }
    }
  };
  const gate = paymentMiddleware(routes, resourceServer);
  return gate(c, next);
});

function taskAuthHeader(c: any): string | null {
  const h = c.req.header("x-spendscope-task-token");
  return h && h.length >= 32 ? h : null;
}
async function authorizedTask(c: any, taskId: string): Promise<TaskRow | null> {
  const token = taskAuthHeader(c);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return await c.env.DB.prepare("SELECT * FROM tasks WHERE task_id = ? AND token_hash = ?")
    .bind(taskId, tokenHash).first() as TaskRow | null;
}
function state(t: TaskRow) {
  return {
    taskId: t.task_id, currency: t.currency,
    budget: formatUnits(t.budget_micros),
    spent: formatUnits(t.spent_micros),
    reserved: formatUnits(t.reserved_micros),
    remaining: formatUnits(t.budget_micros - t.spent_micros - t.reserved_micros),
    createdAt: t.created_at
  };
}

app.post("/v1/tasks", async c => {
  const body = await c.req.json().catch(() => null) as any;
  if (!body || typeof body.taskId !== "string" || !/^[a-zA-Z0-9_-]{3,80}$/.test(body.taskId))
    return c.json({ error: "invalid_task_id", detail: "taskId must be 3-80 letters, digits, _ or -." }, 400);
  const budget = parseMicros(body.budget);
  if (!budget) return c.json({ error: "invalid_budget", detail: "budget must be a positive decimal with at most 6 places." }, 400);
  const currency = typeof body.currency === "string" ? body.currency.toUpperCase() : "";
  if (!/^[A-Z0-9]{2,12}$/.test(currency)) return c.json({ error: "invalid_currency" }, 400);
  const token = randomToken();
  try {
    await c.env.DB.prepare("INSERT INTO tasks (task_id, token_hash, currency, budget_micros) VALUES (?, ?, ?, ?)")
      .bind(body.taskId, await sha256Hex(token), currency, budget).run();
  } catch {
    return c.json({ error: "task_id_exists_or_database_error" }, 409);
  }
  return c.json({ ...state({ task_id: body.taskId, token_hash: "", currency, budget_micros: budget, spent_micros: 0, reserved_micros: 0, created_at: new Date().toISOString() } as TaskRow), taskToken: token, warning: "Store taskToken securely; it is returned only at creation. This API cannot block payments made outside SpendScope." }, 201);
});

app.get("/v1/tasks/:id", async c => {
  const t = await authorizedTask(c, c.req.param("id"));
  if (!t) return c.json({ error: "unauthorized_or_unknown_task" }, 401);
  return c.json(state(t));
});

app.post("/v1/tasks/:id/reservations", async c => {
  const taskId = c.req.param("id");
  const t = await authorizedTask(c, taskId);
  if (!t) return c.json({ error: "unauthorized_or_unknown_task" }, 401);
  const body = await c.req.json().catch(() => null) as any;
  const amount = parseMicros(body?.amount);
  const reservationId = typeof body?.reservationId === "string" ? body.reservationId : "";
  const currency = typeof body?.currency === "string" ? body.currency.toUpperCase() : "";
  if (!amount || !/^[a-zA-Z0-9_-]{8,100}$/.test(reservationId) || !currency)
    return c.json({ error: "invalid_reservation", detail: "Provide a positive amount, currency, and unique reservationId (8-100 safe characters)." }, 400);
  if (currency !== t.currency)
    return c.json({ decision: "BLOCK", reason: "currency_mismatch", expectedCurrency: t.currency, suppliedCurrency: currency }, 409);
  // The conditional UPDATE is the atomic gate. D1 serializes writes; only a request
  // that fits the current available balance can increment reserved_micros.
  let reservationResults: D1Result[];
  try {
    // D1 batch is transactional: if the reservation insert fails (including a
    // duplicate reservationId), the preceding budget increment rolls back too.
    reservationResults = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE tasks SET reserved_micros = reserved_micros + ? WHERE task_id = ? AND token_hash = ? AND spent_micros + reserved_micros + ? <= budget_micros"
      ).bind(amount, taskId, t.token_hash, amount),
      c.env.DB.prepare(
        "INSERT INTO reservations (reservation_id, task_id, amount_micros, status) SELECT ?, ?, ?, 'reserved' WHERE changes() = 1"
      ).bind(reservationId, taskId, amount)
    ]);
  } catch {
    return c.json({ error: "reservation_id_conflict_or_database_error" }, 409);
  }
  if (!reservationResults[0]?.meta?.changes) {
    const fresh = await authorizedTask(c, taskId);
    return c.json({ decision: "BLOCK", reason: "task_budget_exceeded", ...(fresh ? state(fresh) : {}) }, 409);
  }
  const fresh = await authorizedTask(c, taskId);
  return c.json({ decision: "ALLOW", reservationId, ...(fresh ? state(fresh) : {}) }, 201);
});

  // Fail closed until server-side payment verification exists.
  if (targetStatus === "settled") {
    return c.json({
      error: "payment_verification_unavailable",
      detail: "Settlement is disabled until server-side payment verification is configured."
    }, 503);
  } {
  const taskId = c.req.param("id");
  const reservationId = c.req.param("reservationId");
  const t = await authorizedTask(c, taskId);
  if (!t) return c.json({ error: "unauthorized_or_unknown_task" }, 401);
  const body = await c.req.json().catch(() => ({})) as any;
  const confirmationRef = typeof body?.confirmationRef === "string" ? body.confirmationRef.slice(0, 200) : null;
  if (targetStatus === "settled" && !confirmationRef)
    return c.json({ error: "confirmation_ref_required" }, 400);
  const reservation = await c.env.DB.prepare("SELECT * FROM reservations WHERE reservation_id = ? AND task_id = ? AND status = 'reserved'")
    .bind(reservationId, taskId).first() as any;
  if (!reservation) return c.json({ error: "reservation_not_pending" }, 409);
  // Atomic single statement: state changes only if reservation is still pending.
  const results = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE reservations SET status = ?, confirmation_ref = ?, updated_at = CURRENT_TIMESTAMP WHERE reservation_id = ? AND task_id = ? AND status = 'reserved' AND EXISTS (SELECT 1 FROM tasks WHERE task_id = ? AND reserved_micros >= (SELECT amount_micros FROM reservations WHERE reservation_id = ? AND task_id = ?))")
      .bind(targetStatus, confirmationRef, reservationId, taskId, taskId, reservationId, taskId),
    c.env.DB.prepare(targetStatus === "settled"
      ? "UPDATE tasks SET reserved_micros = reserved_micros - ?, spent_micros = spent_micros + ? WHERE task_id = ? AND reserved_micros >= ? AND changes() = 1"
      : "UPDATE tasks SET reserved_micros = reserved_micros - ? WHERE task_id = ? AND reserved_micros >= ? AND changes() = 1")
      .bind(...(targetStatus === "settled" ? [reservation.amount_micros, reservation.amount_micros, taskId, reservation.amount_micros] : [reservation.amount_micros, taskId, reservation.amount_micros]))
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes) return c.json({ error: "reservation_transition_conflict" }, 409);
  const fresh = await authorizedTask(c, taskId);
  return c.json({ ok: true, status: targetStatus, reservationId, ...(fresh ? state(fresh) : {}) });
}
app.post("/v1/tasks/:id/reservations/:reservationId/settle", c => changeReservation(c, "settled"));
app.post("/v1/tasks/:id/reservations/:reservationId/release", c => changeReservation(c, "released"));

app.notFound(c => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error("SpendScope error", err);
  return c.json({ error: "internal_error" }, 500);
});
export default app;
