// Contract checks: are the calls src/billing.ts makes ones the real Stripe API
// accepts? fake-stripe.ts can only check what we taught it. stripe-mock is
// Stripe's own stand-in, built from Stripe's published API description, so it
// refuses a parameter Stripe doesn't have or a value of the wrong type, the
// way api.stripe.com would. Its answers are canned, so this checks shapes, not
// behaviour; the payments tests check behaviour.
//
// Skipped unless stripe-mock is running (README, "Testing"):
//   stripe-mock -http-port 12111
// Run: npm run test:integration   (STRIPE_MOCK_URL to use another address)
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTestDb } from "../unit/d1-shim.ts";

const out = fileURLToPath(new URL("../../node_modules/.cache/humanual-test/billing-contract.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../../src/billing.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile: out,
  logLevel: "error",
});
const billing = await import(pathToFileURL(out).href);

const MOCK = process.env.STRIPE_MOCK_URL ?? "http://127.0.0.1:12111";
const running = await fetch(MOCK).then(
  () => true,
  () => false,
);
const skip = running ? false : `stripe-mock isn't running at ${MOCK}`;

// stripe-mock accepts any test key.
const env = { STRIPE_API_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: "whsec_x", STRIPE_API_BASE: MOCK } as any;
const stripe = () => billing.stripeClient(env);
const origin = "http://localhost:8787";

test("stripe-mock refuses what Stripe would refuse (so the checks below mean something)", { skip }, async () => {
  await assert.rejects(
    stripe().checkout.sessions.create({ mode: "payment", not_a_real_param: "x" } as any),
    (err: any) => err.statusCode === 400,
  );
});

test("a guest's pack checkout is a request Stripe accepts", { skip }, async () => {
  const url = await billing.createPackCheckout(stripe(), createTestDb(), env, { owner: "guest:abc", userId: null, email: null, replies: 10, origin });
  assert.equal(typeof url, "string");
});

test("an account's pack checkout, with its new Stripe customer, is accepted", { skip }, async () => {
  const db = createTestDb();
  const url = await billing.createPackCheckout(stripe(), db, env, { owner: "u1", userId: "u1", email: "a@example.com", replies: 5, origin });
  assert.equal(typeof url, "string");
  assert.match((await billing.getPlanRow(db, "u1")).customer_id, /^cus_/);
});

test("the plan checkout, the price lookup, and the portal are accepted", { skip }, async () => {
  const db = createTestDb();
  assert.equal(typeof (await billing.planPriceCents(stripe())), "number");
  assert.equal(typeof (await billing.createPlanCheckout(stripe(), db, { userId: "u2", email: null, origin })), "string");
  assert.equal(typeof (await billing.createPortal(stripe(), db, "u2", origin)), "string");
});

test("the plan sync's subscription list is accepted, and its answer has the fields the sync reads", { skip }, async () => {
  const db = createTestDb();
  await db.exec("INSERT INTO plans (user_id, customer_id, updated_at) VALUES ('u3', 'cus_123', 0)");
  const row = await billing.syncCustomer(stripe(), db, "cus_123");
  assert.equal(row.user_id, "u3");
  assert.equal(typeof row.status, "string", "status came from the subscription");
  assert.equal(typeof row.current_period_end, "number", "the period end is on the subscription item, where the sync reads it");
});
