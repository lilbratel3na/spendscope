// Exact fixed-point arithmetic: 1 currency unit = 1,000,000 micros.
// Amounts are accepted as decimal strings to avoid floating-point rounding.
export function parseMicros(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const micros = Number(whole) * 1_000_000 + Number((frac + "000000").slice(0, 6));
  if (!Number.isSafeInteger(micros) || micros <= 0) return null;
  return micros;
}
export function formatUnits(micros) {
  const whole = Math.floor(micros / 1_000_000);
  const frac = String(micros % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
