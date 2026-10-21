// Browser test for the public demo (/demo).
//
//   1. npm run dev            (in one terminal)
//   2. npm run test:demo      (in another)
//
// Fails if the demo calls /api (which would spend API credit), stores anything
// in the browser, or stops matching the recordings in public/demo/samples.json.
// Uses your installed Chrome (playwright-core doesn't download a browser).
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const U = process.env.HUMANUAL_URL ?? "http://127.0.0.1:8787";
const data = JSON.parse(readFileSync(new URL("../public/demo/samples.json", import.meta.url), "utf8"));
const sample = (id) => data.conversations.find((c) => c.id === id);
const results = [];
const ok = (name, cond, extra = "") => { results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };
// Compares rendered text with recorded Markdown, ignoring formatting characters.
const plain = (s) => s.replace(/[*_>`#]/g, "").replace(/\s+/g, " ").trim();

const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
const apiCalls = [];

async function open(viewport, path = "/demo") {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/")) apiCalls.push(r.url()); });
  await page.goto(`${U}${path}`);
  await page.waitForSelector("#app:not([hidden])");
  return { ctx, page };
}

const lastCoachText = (page) => page.$$eval("#messages .msg.coach .md", (n) => n.at(-1)?.innerText ?? "");
const waitForReplies = (page, n) =>
  page.waitForFunction((n) => document.querySelectorAll("#messages .msg.coach").length === n && !document.querySelector("#send.stop"), n, { timeout: 15000 });

try {
  // Arrives the way the portfolio links here, so the back link shows.
  const { ctx, page } = await open({ width: 1280, height: 800 }, "/demo?ref=eta");

  // Banner and start screen.
  ok("demo banner shows", await page.isVisible("[data-testid=demo-banner]"));
  ok("back link goes to the portfolio", (await page.getAttribute("[data-testid=demo-back-link]", "href")) === "https://elitetestautomation.com/#portfolio");
  ok("back link shows for portfolio visitors", await page.isVisible("[data-testid=demo-back-link]"));
  const direct = await open({ width: 1280, height: 800 });
  ok("back link hidden for everyone else", !(await direct.page.isVisible("[data-testid=demo-back-link]")));
  await direct.ctx.close();
  ok("no sign-in or welcome screen", !(await page.isVisible("#signin")) && !(await page.isVisible("#onboarding")));
  const sampleCount = await page.$$eval("#sample-list .sample", (n) => n.length);
  ok("start screen lists every sample", sampleCount === data.conversations.length, `${sampleCount}`);
  ok("sidebar has the recorded rehearsal", (await page.$$eval("#convo-list .convo-item", (n) => n.length)) === 1);
  ok("start screen opens at the top", (await page.$eval("#scroller", (s) => s.scrollTop)) === 0);
  ok("no Just talk it through card", !(await page.isVisible(".mode-card:has-text('Just talk it through')")));
  ok("three tabs", (await page.$$eval(".view-btn", (n) => n.map((b) => b.textContent.trim()).join(","))) === "Coach chat,Scripts,Journal");

  // Play a sample through both turns.
  const dentist = sample("dentist");
  await page.click("[data-testid=demo-sample-dentist]");
  await waitForReplies(page, 1);
  ok("first reply matches the recording", plain(await lastCoachText(page)) === plain(dentist.messages[1].content));
  ok("coach switched to the sample's coach", (await page.textContent("#topbar-coach")).includes("Junie"));
  ok("next message is offered", await page.isVisible("[data-testid=demo-next-chip]"));
  await page.click("[data-testid=demo-next-chip]");
  await waitForReplies(page, 2);
  ok("second reply matches the recording", plain(await lastCoachText(page)) === plain(dentist.messages[3].content));
  ok("no next chip at the end", !(await page.isVisible("[data-testid=demo-next-chip]")));

  // Off-script typing gets an honest note, not a fake answer.
  await page.fill("#input", "What about my landlord?");
  await page.click("#send");
  await waitForReplies(page, 3);
  ok("off-script message explains the demo", (await lastCoachText(page)).includes("This is the demo"));

  // Picking a topic narrows the samples.
  await page.click("#new-chat");
  await page.click(".mode-card:has-text('Get me ready')");
  const practice = await page.$$eval("#sample-list .sample", (n) => n.map((b) => b.dataset.testid));
  ok("Get me ready shows the rehearsal sample", practice.length === 1 && practice[0] === "demo-sample-gym", practice.join(","));
  ok("practice setup is hidden in the demo", !(await page.isVisible("#practice-setup")));

  // Scripts: example chips give recorded cards; anything else explains.
  await page.click(".view-btn[data-view=scripts]");
  ok("two saved scripts preloaded", (await page.$$eval("#saved-list .saved-item", (n) => n.length)) === 2);
  const shoes = data.scripts.find((s) => s.task === "Return shoes without a receipt");
  await page.click("#script-examples .chip:has-text('Return shoes without a receipt')");
  await page.click("#script-go");
  await page.waitForFunction((t) => document.querySelector("#script-out h3")?.textContent === t, shoes.script.title, { timeout: 5000 });
  ok("example chip shows the recorded script", true);
  ok("script card is marked recorded", (await page.textContent("#script-out .by")).includes("recorded"));
  ok("demo hides buttons that need live AI", !(await page.isVisible("#script-out button:has-text('Talk it over')")));
  await page.fill("#script-task", "Ask my boss for Friday off");
  await page.click("#script-go");
  ok("custom script task explains the demo", (await page.textContent("#script-status")).includes("example buttons"));

  // Journal: a past entry is shown; idea buttons give recorded replies; anything else explains.
  await page.click(".view-btn[data-view=journal]");
  ok("journal shows one past entry", (await page.$$eval("#entry-list .saved-item", (n) => n.length)) === 1);
  const pharmacy = data.journal.find((j) => j.label === "Called the pharmacy");
  await page.click(`#journal-prompts .chip:has-text("${pharmacy.label}")`);
  await page.click("#journal-go");
  await page.waitForFunction((t) => document.querySelector("#journal-out h3")?.textContent === t, pharmacy.card.title, { timeout: 5000 });
  ok("journal idea gives the recorded reply", (await page.textContent("#journal-out .norm")).includes(pharmacy.card.encouragement));
  ok("journal reply is marked recorded", (await page.textContent("#journal-out .by")).includes("recorded"));
  ok("two entries after saving one", (await page.$$eval("#entry-list .saved-item", (n) => n.length)) === 2);
  ok("demo hides Talk it over on journal", !(await page.isVisible("#journal-out button:has-text('Talk it over')")));
  await page.fill("#journal-text", "Today was fine.");
  await page.click("#journal-go");
  ok("custom journal entry explains the demo", (await page.textContent("#journal-status")).includes("idea buttons"));

  // Memory: the recorded list shows in settings and items can be removed.
  await page.click("#open-settings");
  const remembered = await page.$$eval("#memory-list li", (n) => n.length);
  ok("settings lists what the coach remembers", remembered === data.memory.length && remembered > 0, `${remembered}`);
  await page.click("#memory-list li:first-child button");
  ok("forgetting removes one item", (await page.$$eval("#memory-list li", (n) => n.length)) === remembered - 1);
  await page.click("#settings .sheet-head button");

  // Nothing persisted.
  const stored = await page.evaluate(() => ({ keys: Object.keys(localStorage), sw: navigator.serviceWorker?.controller ?? null }));
  ok("nothing saved in the browser", stored.keys.length === 0, stored.keys.join(","));
  ok("no service worker in the demo", stored.sw === null);
  await page.reload();
  await page.waitForSelector("#app:not([hidden])");
  ok("reload resets the demo", (await page.$$eval("#convo-list .convo-item", (n) => n.length)) === 1);
  await ctx.close();

  // Phone layout: banner wraps, no sideways scrolling.
  const phone = await open({ width: 390, height: 844 });
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok("phone: no horizontal scroll", overflow <= 0, `${overflow}px`);
  const composerBottom = await phone.page.evaluate(() => document.querySelector(".composer").getBoundingClientRect().bottom);
  ok("phone: composer fits on screen with the banner", composerBottom <= 844, `${composerBottom}`);
  await phone.ctx.close();

  ok("demo never called /api", apiCalls.length === 0, apiCalls.join(", "));
  ok("no page errors", errors.length === 0, errors.join(" | "));
} catch (err) {
  ok("test ran to the end", false, err.message.split("\n")[0]);
} finally {
  await browser.close();
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
