// Integration tests for buying replies and the monthly plan. The Worker runs
// as it does in production, all the way through: routing, sign-in, the
// replies ledger in a real SQLite database with every migration applied, and
// the real Stripe SDK. Only Stripe itself is stood in for, by a fake Stripe
// server on a local port (fake-stripe.ts). Nothing is charged and no network
// leaves this machine.
// Run: npm run test:integration
//
// --test-force-exit (in the npm script): when the SDK retries after a 500 it
// drops the failed response without clearing that request's 80-second timeout
// (stripe 23.0.0), which would hold the process open after the tests finish.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTestDb } from "../unit/d1-shim.ts";
import { startFakeStripe, type FakeStripe } from "./fake-stripe.ts";

// The Worker imports the prompt Markdown files as text (a wrangler rule), so
// bundle it first, as the unit tests do. Its own file, so the two suites can
// run at the same time.
const out = fileURLToPath(new URL("../../node_modules/.cache/humanual-test/worker-integration.mjs", import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL("../../src/worker.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  loader: { ".md": "text" },
  outfile: out,
  logLevel: "error",
});
const worker = (await import(pathToFileURL(out).href)).default;

const SECRET = "whsec_integration";
let stripe: FakeStripe;
before(async () => {
  stripe = await startFakeStripe({ webhookSecret: SECRET });
});
after(() => stripe.close());

// Local development settings: dev sign-in on localhost, and a sandbox key
// that STRIPE_ALLOW_TEST_MODE lets turn payments on.
const env = (db: D1Database) =>
  ({
    ANTHROPIC_API_KEY: "sk-ant-test",
    DEV_AUTH: "true",
    DB: db,
    ASSETS: { fetch: async () => new Response("asset") },
    STRIPE_API_KEY: "sk_test_integration",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_ALLOW_TEST_MODE: "true",
    STRIPE_API_BASE: stripe.url,
  }) as any;

const GUEST = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_GUEST = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/** Who's asking: a guest browser (its cookie) or a signed-in account (dev sign-in). */
type Who = { guest: string } | { user: string; guest?: string };
function headers(who: Who): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if ("user" in who) h["x-dev-user"] = who.user;
  if (who.guest) h.cookie = `hm_guest=${who.guest}`;
  return h;
}

/** A small client for the Worker, the way the page calls it. */
function app(db: D1Database) {
  const e = env(db);
  const call = async (path: string, who: Who, init: RequestInit = {}) => {
    const res = await worker.fetch(new Request(`http://localhost${path}`, { ...init, headers: headers(who) }), e);
    return { status: res.status, body: await res.json() };
  };
  return {
    checkout: (who: Who, body: object) => call("/api/replies/checkout", who, { method: "POST", body: JSON.stringify(body) }),
    replies: (who: Who, query = "") => call(`/api/replies${query}`, who),
    portal: (who: Who) => call("/api/replies/portal", who, { method: "POST", body: "{}" }),
    /** Stripe delivering an event to the webhook. */
    deliver: async (req: Request) => (await worker.fetch(req, e)).status,
  };
}

const sessionIdFrom = (url: string) => url.split("/").at(-1)!;

/**
 * Runs a step that's meant to make the Worker log an error, without the log,
 * so the test output only shows errors nobody expected. Returns what was logged.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = original;
  }
}

// ---------- packs ----------

test("a guest buys a pack: Checkout is asked for the right thing, and the webhook credits it once", async () => {
  const a = app(createTestDb());
  const guest = { guest: GUEST };

  const res = await a.checkout(guest, { replies: 10 });
  assert.equal(res.status, 200);
  assert.ok(res.body.url.startsWith(stripe.url), "the page is sent to (fake) Stripe's Checkout page");

  // What the Worker sent Stripe, as Stripe received it over the wire.
  const sent = stripe.calls("POST", "/v1/checkout/sessions").at(-1)!.body;
  assert.equal(sent.mode, "payment");
  assert.equal(sent.line_items[0].quantity, "10");
  assert.equal(sent.line_items[0].price_data.unit_amount, "100");
  assert.equal(sent.line_items[0].price_data.currency, "usd");
  assert.equal(sent.metadata.owner, `guest:${GUEST}`);
  assert.equal(sent.metadata.replies, "10");
  assert.equal(sent.customer_creation, "if_required", "guests pay without a Stripe customer");
  assert.equal(sent.success_url, "http://localhost/?bought={CHECKOUT_SESSION_ID}");

  // Nothing is credited until Stripe says it's paid.
  assert.equal((await a.replies(guest)).body.replies.bought, 0);

  const paid = stripe.pay(sessionIdFrom(res.body.url));
  assert.equal(await a.deliver(stripe.webhook(paid)), 200);
  assert.equal((await a.replies(guest)).body.replies.bought, 10);

  // Stripe delivers at least once, so the same event may come again.
  assert.equal(await a.deliver(stripe.webhook(paid)), 200);
  assert.equal((await a.replies(guest)).body.replies.bought, 10, "credited once");
});

test("coming back from Checkout before the webhook still credits the pack, and the late webhook doesn't double it", async () => {
  const a = app(createTestDb());
  const guest = { guest: GUEST };
  const { body } = await a.checkout(guest, { replies: 5 });
  const id = sessionIdFrom(body.url);
  const paid = stripe.pay(id);

  // The page lands on /?bought=<id> and asks about it straight away.
  const back = await a.replies(guest, `?session=${id}`);
  assert.deepEqual(back.body.bought, { replies: 5, credited: true });
  assert.equal(back.body.replies.bought, 5);

  assert.equal(await a.deliver(stripe.webhook(paid)), 200);
  assert.equal((await a.replies(guest)).body.replies.bought, 5);
});

test("a session id on its own proves nothing: only the buyer hears about the pack", async () => {
  const a = app(createTestDb());
  const { body } = await a.checkout({ guest: GUEST }, { replies: 5 });
  const id = sessionIdFrom(body.url);
  stripe.pay(id);

  // Someone else opens the return link (a shared screenshot, say).
  const stranger = await a.replies({ guest: OTHER_GUEST }, `?session=${id}`);
  assert.equal(stranger.body.bought, null);
  assert.equal(stranger.body.replies.bought, 0);
  // The pack still went to the person who paid.
  assert.equal((await a.replies({ guest: GUEST })).body.replies.bought, 5);
});

test("an abandoned checkout credits nothing", async () => {
  const a = app(createTestDb());
  const { body } = await a.checkout({ guest: GUEST }, { replies: 10 });
  const back = await a.replies({ guest: GUEST }, `?session=${sessionIdFrom(body.url)}`);
  assert.equal(back.body.bought, null);
  assert.equal(back.body.replies.bought, 0);
});

test("a guest who buys and then signs in keeps the pack, even when the webhook lands after the sign-in", async () => {
  const a = app(createTestDb());
  const { body } = await a.checkout({ guest: GUEST }, { replies: 10 });
  const paid = stripe.pay(sessionIdFrom(body.url));

  // They make an account before Stripe's webhook arrives. The browser still has the guest cookie.
  const bob = { user: "bob", guest: GUEST };
  assert.equal((await a.replies(bob)).body.replies.bought, 0);

  assert.equal(await a.deliver(stripe.webhook(paid)), 200);
  assert.equal((await a.replies(bob)).body.replies.bought, 10, "the late credit followed them into the account");
});

test("pack sizes outside 1 to 500 never reach Stripe", async () => {
  const a = app(createTestDb());
  const before = stripe.calls("POST", "/v1/checkout/sessions").length;
  for (const replies of [0, 501, 2.5, "ten"]) {
    assert.equal((await a.checkout({ guest: GUEST }, { replies })).status, 400, String(replies));
  }
  assert.equal(stripe.calls("POST", "/v1/checkout/sessions").length, before);
});

// ---------- the monthly plan ----------

test("the plan: one Stripe customer, a subscription checkout, and the webhook puts the account on 30 replies", async () => {
  const db = createTestDb();
  const a = app(db);
  const alice = { user: "alice" };

  const res = await a.checkout(alice, { plan: true });
  assert.equal(res.status, 200);

  const customer = stripe.calls("POST", "/v1/customers").at(-1)!;
  assert.equal(customer.body.metadata.humanual_user_id, "dev_alice");
  assert.equal(customer.headers["idempotency-key"], "humanual-customer-dev_alice", "a double click can't make two customers");
  const sent = stripe.calls("POST", "/v1/checkout/sessions").at(-1)!.body;
  assert.equal(sent.mode, "subscription");
  assert.equal(sent.line_items[0].price, "price_test_plan", "the price found by its lookup key");
  assert.equal(sent.subscription_data.metadata.humanual_user_id, "dev_alice");

  // Before paying: no plan.
  assert.equal((await a.replies(alice)).body.plan.active, false);

  const paid = stripe.pay(sessionIdFrom(res.body.url));
  assert.equal(await a.deliver(stripe.webhook(paid)), 200);

  const after = (await a.replies(alice)).body;
  assert.equal(after.plan.active, true);
  assert.equal(after.replies.plan.left, 30);
  assert.equal(after.offer.planPriceCents, 1000, "the price shown comes from Stripe");

  // Already on the plan: a second checkout is refused before Stripe is asked.
  const again = await a.checkout(alice, { plan: true });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already on the plan/);

  // Subscribers can open the billing portal.
  const portal = await a.portal(alice);
  assert.equal(portal.status, 200);
  assert.ok(portal.body.url.startsWith(stripe.url));
});

test("events that arrive late or out of order can't leave the wrong plan status", async () => {
  const db = createTestDb();
  const a = app(db);
  const carol = { user: "carol" };
  const { body } = await a.checkout(carol, { plan: true });
  const paid = stripe.pay(sessionIdFrom(body.url));
  const subId = stripe.session(sessionIdFrom(body.url)).subscription;

  // Stripe's events can arrive in any order. Here the cancellation's event
  // comes first, and the older "created" event straggles in after it.
  const created = stripe.event("customer.subscription.created", { object: "subscription", id: subId, customer: paid.data.object.customer, status: "active" });
  const canceled = stripe.updateSubscription(subId, { status: "canceled" }, "customer.subscription.deleted");
  assert.equal(await a.deliver(stripe.webhook(canceled)), 200);
  assert.equal(await a.deliver(stripe.webhook(created)), 200);

  // The Worker re-reads the subscription from Stripe on every event, so the
  // stale "active" in the late event's payload doesn't matter.
  const row = await db.prepare("SELECT status FROM plans WHERE user_id = 'dev_carol'").first<{ status: string }>();
  assert.equal(row?.status, "canceled");
  assert.equal((await a.replies(carol)).body.plan.active, false);
});

test("a failed card keeps the plan while Stripe retries it (past_due)", async () => {
  const a = app(createTestDb());
  const dana = { user: "dana" };
  const { body } = await a.checkout(dana, { plan: true });
  await a.deliver(stripe.webhook(stripe.pay(sessionIdFrom(body.url))));
  const subId = stripe.session(sessionIdFrom(body.url)).subscription;

  await a.deliver(stripe.webhook(stripe.updateSubscription(subId, { status: "past_due" })));
  const r = (await a.replies(dana)).body;
  assert.equal(r.plan.active, true);
  assert.equal(r.plan.pastDue, true, "the page can say the card needs updating");
});

test("someone who has never paid has no portal to open", async () => {
  const res = await app(createTestDb()).portal({ user: "erin" });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /Nothing to manage yet/);
});

test("guests can't start the plan", async () => {
  const res = await app(createTestDb()).checkout({ guest: GUEST }, { plan: true });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "signin");
});

// ---------- when Stripe misbehaves ----------

test("a Stripe 500 is retried with the same idempotency key, and the person never sees it", async () => {
  const a = app(createTestDb());
  const before = stripe.calls("POST", "/v1/checkout/sessions").length;
  stripe.faults.push({ method: "POST", path: "/v1/checkout/sessions", status: 500, times: 1 });

  const res = await a.checkout({ guest: GUEST }, { replies: 1 });
  assert.equal(res.status, 200);

  const tries = stripe.calls("POST", "/v1/checkout/sessions").slice(before);
  assert.equal(tries.length, 2, "one failure, one retry");
  assert.ok(tries[0].headers["idempotency-key"], "the SDK adds a key to every POST");
  assert.equal(tries[1].headers["idempotency-key"], tries[0].headers["idempotency-key"], "so the retry can't make a second session");
});

test("when Stripe is down, the person gets a plain message, not a crash", async () => {
  const a = app(createTestDb());
  // stripe-should-retry: false is Stripe telling the SDK not to bother retrying (it keeps this test fast).
  stripe.faults.push({ method: "POST", path: "/v1/checkout/sessions", status: 503, shouldRetry: "false" });
  const { result: res, logged } = await quietly(() => a.checkout({ guest: GUEST }, { replies: 5 }));
  assert.equal(res.status, 502);
  assert.match(res.body.error, /Couldn't reach the payment service/);
  assert.match(String(logged[0]?.[0]), /checkout failed/, "the details go to the server log, not the person");
});

test("a webhook that fails to process answers 500, so Stripe tries it again later", async () => {
  const a = app(createTestDb());
  const { body } = await a.checkout({ user: "frank" }, { plan: true });
  const paid = stripe.pay(sessionIdFrom(body.url));

  // The plan sync can't read the subscription from Stripe this time.
  stripe.faults.push({ method: "GET", path: "/v1/subscriptions", status: 500, shouldRetry: "false" });
  assert.equal((await quietly(() => a.deliver(stripe.webhook(paid)))).result, 500);
  assert.equal((await a.replies({ user: "frank" })).body.plan.active, false);

  // Stripe's retry gets through.
  assert.equal(await a.deliver(stripe.webhook(paid)), 200);
  assert.equal((await a.replies({ user: "frank" })).body.plan.active, true);
});

// ---------- webhook security ----------

test("only events signed with our secret, and recent, change anything", async () => {
  const a = app(createTestDb());
  const { body } = await a.checkout({ guest: GUEST }, { replies: 10 });
  const paid = stripe.pay(sessionIdFrom(body.url));

  assert.equal(await a.deliver(stripe.webhook(paid, { secret: "whsec_someone_else" })), 400, "wrong secret");
  const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
  assert.equal(await a.deliver(stripe.webhook(paid, { timestamp: tenMinutesAgo })), 400, "a replayed old delivery");
  const unsigned = new Request("http://localhost/api/stripe/webhook", { method: "POST", body: JSON.stringify(paid) });
  assert.equal(await a.deliver(unsigned), 400, "no signature");
  assert.equal((await a.replies({ guest: GUEST })).body.replies.bought, 0);
});
