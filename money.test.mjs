import test from "node:test";
import assert from "node:assert/strict";
import { parseMicros, formatUnits } from "../ ./money.js.";

test("parses decimal strings exactly", () => {
  assert.equal(parseMicros("2"), 2_000_000);
  assert.equal(parseMicros("0.75"), 750_000);
  assert.equal(parseMicros("0.000001"), 1);
});
test("rejects malformed, zero, negative and excessive precision", () => {
  for (const x of ["0", "-1", "1.0000001", "1e3", "NaN", "01", ""]) assert.equal(parseMicros(x), null);
});
test("formats micros without floating point", () => {
  assert.equal(formatUnits(2_000_000), "2");
  assert.equal(formatUnits(500_000), "0.5");
  assert.equal(formatUnits(1), "0.000001");
});
