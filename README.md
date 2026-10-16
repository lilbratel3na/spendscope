# SpendScope — persistent task-level spend guard (x402 + Cloudflare D1)

## What this fixes
The original MCP prototype kept budgets in a process-local `Map`, which is incompatible with stateless plugin execution. This version moves state to Cloudflare D1 and uses conditional SQL updates to reserve budget atomically before a proposed spend.

## Honest guarantee
SpendScope controls only spends whose workflow calls its reservation API and honors the result. It does **not** intercept PayBox payments or prevent an agent from bypassing the service. PayBox grants and approvals remain the actual payment authorization boundary.

## API flow
1. `POST /v1/tasks` with `{ "taskId":"report-17", "budget":"2", "currency":"USDC" }` creates a budget and returns a one-time `taskToken`.
2. `POST /v1/tasks/report-17/reservations` with header `x-spendscope-task-token: <taskToken>` and `{ "reservationId":"call_00000001", "amount":"0.75" }` atomically reserves budget.
3. If payment succeeds and is independently verified, call `/settle` with `{ "confirmationRef":"<provider transaction/request id>" }`. This converts reserved amount to spent.
4. If payment definitely did not happen, call `/release`. Do **not** release on ambiguous outcomes; keep the reservation until reconciled.
5. `GET /v1/tasks/report-17` returns budget, spent, reserved, and remaining.

Amounts are decimal strings, stored as integer micros (6 decimals) to avoid floating point errors. Task token hashes are stored, not raw tokens.

## x402 / PayBox
This service uses `@x402/hono` and the official x402 EVM exact scheme on Base Sepolia for development. Each API call costs $0.001 in test USDC through x402. The x402 fee is a service fee, separate from the task's tracked spending. The free `/health`, `/`, and `/openapi.json` endpoints are for discovery/health checks.

Before deployment:
- Create a Cloudflare account (Workers Free is sufficient for a small demo).
- Create a D1 database and replace `database_id` in `wrangler.toml`.
- Set a Base Sepolia receiving address: `npx wrangler secret put PAY_TO`.
- Install dependencies: `npm install`.
- Initialize schema: `npm run db:remote`.
- Deploy: `npm run deploy`.
- Test `/health`, then the x402-protected endpoints with an x402-capable client.
- Keep Base Sepolia for demo. Do not switch to Base mainnet without deliberate approval and a configured production receiving wallet.

## Setup commands
```sh
npm install
npx wrangler login
npx wrangler d1 create spendscope-db
# Paste the returned database_id into wrangler.toml
npm run db:remote
npx wrangler secret put PAY_TO
npm run deploy
```

## Local verification performed in this working session

- `node --test test/*.test.mjs`: 3/3 money parsing/formatting tests pass.
- SQLite invariant simulation against `schema.sql`: two 0.75 reservations fit a 2.00 budget; a third 0.75 reservation is rejected; a duplicate reservation ID rolls back without changing the reserved balance; settlement moves reserved funds to spent exactly once.
- These are local checks, not a deployed Cloudflare D1 test or an x402/PayBox end-to-end test.

## Marketplace discovery is a separate gate

An x402 payment challenge by itself does not guarantee catalog discovery. SpendScope now declares x402 Bazaar metadata and input/output schemas on its paid routes. Before claiming PayBox marketplace visibility, validate that metadata against the installed SDK, make a testnet payment with the discovery extension echoed by the client, and query the relevant facilitator/catalog for the listing. Facilitator indexing is external and may be delayed or unsupported.

## Important implementation note
The API has a durable D1 schema, but **deployment and live PayBox marketplace listing have not been performed**. Validate the latest x402 middleware API against installed package versions before publishing. The task token is separate from x402 payment; the agent must retain and send it on subsequent calls.

## Deadline-minded scope
The immediate demo should show: create a 2 USDC task → reserve 0.75 → reserve another 0.75 → a third 0.75 reservation is blocked → settle a reservation → status survives separate requests/restart. Do not use real funds for demo; use Base Sepolia test USDC.
