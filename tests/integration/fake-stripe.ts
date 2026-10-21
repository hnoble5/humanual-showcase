// A stand-in for the Stripe API that runs as a real HTTP server (service
// virtualization). The Worker's own Stripe client, the real SDK with its
// retries, headers and form encoding, talks to it over the wire, pointed here
// by STRIPE_API_BASE.
//
// It keeps state between calls the way Stripe does (customers, Checkout
// sessions, subscriptions) and replays a POST that repeats an Idempotency-Key.
// Tests play the parts a person or Stripe would: pay(), cancel(), and
// webhook() builds the signed request Stripe would deliver. faults lets a test
// make Stripe fail on purpose.
//
// It covers only the calls src/billing.ts makes. A call it doesn't know gets
// Stripe's own 404, so a new call shows up as a failing test, not a silent pass.
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, any>;
  body: Record<string, any>;
  headers: IncomingHttpHeaders;
}

export interface Fault {
  method?: string;
  path: string | RegExp;
  status: number;
  /** How many matching calls fail before it clears. */
  times?: number;
  /** Stripe's own hint to the SDK: "false" means don't retry. */
  shouldRetry?: "true" | "false";
}

export const PLAN_LOOKUP_KEY = "humanual_plan_monthly";
const DAY = 86_400;

/**
 * Stripe sends nested parameters form-encoded with brackets:
 * line_items[0][price_data][unit_amount]=100. This turns them back into objects.
 */
export function parseForm(text: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const parts = key.replace(/\]/g, "").split("[");
    let node: any = out;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = value;
      else node = node[part] ??= /^\d+$/.test(parts[i + 1]) ? [] : {};
    });
  }
  return out;
}

const stripeError = (status: number, type: string, message: string, code?: string) => ({
  status,
  body: { error: { type, message, ...(code ? { code } : {}) } },
});

export async function startFakeStripe(opts: { webhookSecret: string; planPriceCents?: number | null }) {
  const now = () => Math.floor(Date.now() / 1000);
  let seq = 0;
  const newId = (prefix: string) => `${prefix}_test_${String(++seq).padStart(6, "0")}`;

  const customers = new Map<string, any>();
  const sessions = new Map<string, any>();
  const subscriptions = new Map<string, any>();
  const replays = new Map<string, { status: number; body: unknown }>();
  const requests: Recorded[] = [];
  const faults: Fault[] = [];
  let planPriceCents = opts.planPriceCents === undefined ? 1000 : opts.planPriceCents;
  let base = "";

  const planPrice = () => ({
    id: "price_test_plan",
    object: "price",
    active: true,
    currency: "usd",
    lookup_key: PLAN_LOOKUP_KEY,
    unit_amount: planPriceCents,
    recurring: { interval: "month", interval_count: 1 },
  });
  const list = (url: string, data: unknown[]) => ({ object: "list", url, has_more: false, data });

  function handle(r: Recorded): { status: number; body: unknown } {
    const { method, path, body, query } = r;
    let m: RegExpMatchArray | null;

    if (method === "POST" && path === "/v1/customers") {
      const customer = { id: newId("cus"), object: "customer", email: body.email ?? null, metadata: body.metadata ?? {}, created: now() };
      customers.set(customer.id, customer);
      return { status: 200, body: customer };
    }
    if (method === "DELETE" && (m = path.match(/^\/v1\/customers\/([\w]+)$/))) {
      if (!customers.delete(m[1])) return stripeError(404, "invalid_request_error", `No such customer: '${m[1]}'`, "resource_missing");
      for (const sub of subscriptions.values()) if (sub.customer === m[1]) sub.status = "canceled";
      return { status: 200, body: { id: m[1], object: "customer", deleted: true } };
    }

    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (!body.mode) return stripeError(400, "invalid_request_error", "Missing required param: mode.", "parameter_missing");
      if (!body.success_url) return stripeError(400, "invalid_request_error", "Missing required param: success_url.", "parameter_missing");
      if (body.customer && !customers.has(body.customer)) {
        return stripeError(400, "invalid_request_error", `No such customer: '${body.customer}'`, "resource_missing");
      }
      const items: any[] = body.line_items ?? [];
      if (!items.length) return stripeError(400, "invalid_request_error", "Missing required param: line_items.", "parameter_missing");
      let amount = 0;
      for (const item of items) {
        const unit = item.price === planPrice().id ? planPriceCents : Number(item.price_data?.unit_amount);
        if (!Number.isInteger(unit)) return stripeError(400, "invalid_request_error", "Invalid line item.", "parameter_invalid_integer");
        amount += unit! * Number(item.quantity ?? 1);
      }
      const id = newId("cs");
      const session = {
        id,
        object: "checkout.session",
        mode: body.mode,
        status: "open",
        payment_status: "unpaid",
        customer: body.customer ?? null,
        client_reference_id: body.client_reference_id ?? null,
        metadata: body.metadata ?? {},
        amount_total: amount,
        currency: "usd",
        subscription: null as string | null,
        success_url: body.success_url,
        cancel_url: body.cancel_url ?? null,
        url: `${base}/c/pay/${id}`,
        livemode: false,
        // Kept so pay() can tag the subscription the way Stripe would.
        _subscription_metadata: body.subscription_data?.metadata ?? {},
      };
      sessions.set(id, session);
      return { status: 200, body: publicSession(session) };
    }
    if (method === "GET" && (m = path.match(/^\/v1\/checkout\/sessions\/([\w]+)$/))) {
      const session = sessions.get(m[1]);
      if (!session) return stripeError(404, "invalid_request_error", `No such checkout.session: '${m[1]}'`, "resource_missing");
      return { status: 200, body: publicSession(session) };
    }

    if (method === "GET" && path === "/v1/prices") {
      const keys: string[] = Object.values(query.lookup_keys ?? {});
      const found = planPriceCents !== null && keys.includes(PLAN_LOOKUP_KEY) ? [planPrice()] : [];
      return { status: 200, body: list("/v1/prices", found) };
    }

    if (method === "GET" && path === "/v1/subscriptions") {
      const subs = [...subscriptions.values()].filter((s) => s.customer === query.customer);
      return { status: 200, body: list("/v1/subscriptions", subs) };
    }

    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      if (!customers.has(body.customer)) {
        return stripeError(400, "invalid_request_error", `No such customer: '${body.customer}'`, "resource_missing");
      }
      const id = newId("bps");
      return { status: 200, body: { id, object: "billing_portal.session", customer: body.customer, return_url: body.return_url, url: `${base}/p/session/${id}` } };
    }

    return stripeError(404, "invalid_request_error", `Unrecognized request URL (${method}: ${path}).`);
  }

  // The fields Stripe returns; the underscore ones are this fake's own notes.
  const publicSession = (s: any) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith("_")));

  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const url = new URL(req.url ?? "/", "http://fake");
    const r: Recorded = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: parseForm(url.search.slice(1)),
      body: parseForm(text),
      headers: req.headers,
    };
    requests.push(r);

    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "request-id": newId("req"), ...extra });
      res.end(JSON.stringify(body));
    };

    if (!String(req.headers.authorization ?? "").match(/^Bearer (sk|rk)_test_/)) {
      return send(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided." } });
    }

    const fault = faults.find((f) => (!f.method || f.method === r.method) && (typeof f.path === "string" ? f.path === r.path : f.path.test(r.path)));
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.times <= 0) faults.splice(faults.indexOf(fault), 1);
      const hint: Record<string, string> = fault.shouldRetry ? { "stripe-should-retry": fault.shouldRetry } : {};
      return send(fault.status, { error: { type: "api_error", message: "Something went wrong on Stripe's end (fake)." } }, hint);
    }

    // Stripe answers a repeated Idempotency-Key with the first answer, so a
    // retried POST never makes a second customer or session.
    const key = r.method === "POST" ? String(req.headers["idempotency-key"] ?? "") : "";
    if (key && replays.has(key)) {
      const first = replays.get(key)!;
      return send(first.status, first.body, { "idempotent-replayed": "true" });
    }
    const answer = handle(r);
    if (key && answer.status < 500) replays.set(key, answer);
    send(answer.status, answer.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** The event Stripe would send about an object. */
  const event = (type: string, object: unknown) => ({
    id: newId("evt"),
    object: "event",
    type,
    created: now(),
    livemode: false,
    api_version: "2026-09-30.clover",
    data: { object },
  });

  return {
    url: base,
    requests,
    faults,
    /** Calls to one path, oldest first. */
    calls: (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path),
    setPlanPrice: (cents: number | null) => void (planPriceCents = cents),
    event,

    /**
     * The person pays on the Checkout page. A plan checkout starts the
     * subscription, tagged as the session asked. Returns the
     * checkout.session.completed event Stripe would send; delivering it is up
     * to the test, so a test can deliver it late, twice, or never.
     */
    pay(sessionId: string) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`fake Stripe has no session ${sessionId}`);
      s.status = "complete";
      s.payment_status = "paid";
      if (s.mode === "subscription") {
        const start = now();
        const sub = {
          id: newId("sub"),
          object: "subscription",
          customer: s.customer,
          status: "active",
          created: start,
          cancel_at_period_end: false,
          cancel_at: null,
          metadata: s._subscription_metadata,
          items: { object: "list", data: [{ id: newId("si"), price: planPrice(), current_period_start: start, current_period_end: start + 30 * DAY }] },
        };
        subscriptions.set(sub.id, sub);
        s.subscription = sub.id;
      }
      return event("checkout.session.completed", publicSession(s));
    },

    /** Changes a subscription the way the portal or a failed card would. Returns the event Stripe would send. */
    updateSubscription(subId: string, changes: Record<string, unknown>, type = "customer.subscription.updated") {
      const sub = subscriptions.get(subId);
      if (!sub) throw new Error(`fake Stripe has no subscription ${subId}`);
      Object.assign(sub, changes);
      return event(type, structuredClone(sub));
    },

    session: (id: string) => sessions.get(id),

    /** The POST Stripe would make to the webhook, signed the way Stripe signs it. */
    webhook(evt: object, { secret = opts.webhookSecret, timestamp = now(), url = "http://localhost/api/stripe/webhook" } = {}) {
      const body = JSON.stringify(evt);
      const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      return new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": `t=${timestamp},v1=${v1}` },
        body,
      });
    },

    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeStripe = Awaited<ReturnType<typeof startFakeStripe>>;
