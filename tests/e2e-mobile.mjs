// Browser test for phones: the layout fits the screen, nothing pops up the
// keyboard on its own, text boxes are big enough that iPhones don't zoom, and
// the installable-app parts work (Settings → Get the app, home screen
// shortcuts, the offline line, the manifest).
//
// Run against the local server with the dev sign-in turned on (see
// tests/e2e-sync.mjs for the setup), then: npm run test:mobile
// HUMANUAL_URL picks another address (default http://127.0.0.1:8787).
//
// Uses your installed Chrome with phone-sized windows and a phone's user agent.
// It can't run real Safari or an installed app; check those on a phone before
// shipping (README, "Phones").
import { chromium } from "playwright-core";

const U = process.env.HUMANUAL_URL ?? "http://127.0.0.1:8787";
const run = Date.now().toString(36);
const results = [];
const ok = (name, cond, extra = "") => { results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`); };

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const PHONES = {
  iphone: { viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA, isMobile: true, hasTouch: true },
  "small-android": { viewport: { width: 360, height: 640 }, userAgent: ANDROID_UA, isMobile: true, hasTouch: true },
  laptop: { viewport: { width: 1280, height: 800 } },
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
const device = async (label, opts = PHONES[label]) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
  page.on("console", (m) => {
    // The offline step makes requests fail on purpose.
    if (m.type() === "error" && !/ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(m.text())) errors.push(`${label} console: ${m.text()}`);
  });
  return { ctx, page };
};

/** Signs in with the dev sign-in and gets past the welcome screen. */
async function signIn(page, name, path = "/") {
  await page.goto(U + path);
  await page.waitForSelector("#signin:not([hidden])");
  await page.fill("#dev-user", name);
  await page.click("#dev-signin button[type=submit]");
  await page.waitForSelector("#onboarding:not([hidden]), #app:not([hidden])");
  if (await page.isVisible("#onboarding")) {
    await page.check("#ob-age");
    await page.click("#onboard-form button[type=submit]");
  }
  await page.waitForSelector("#app:not([hidden])");
  await page.waitForTimeout(300); // let a late focus or scroll happen, if anything does it
}

/** How the page sits on the screen right now. */
const layout = (page) => page.evaluate(() => ({
  pageScroll: document.documentElement.scrollHeight - innerHeight,
  sideScroll: document.documentElement.scrollWidth - innerWidth,
  scrollY: Math.round(scrollY),
  headerTop: Math.round(document.querySelector(".top").getBoundingClientRect().top),
  focused: document.activeElement?.id || document.activeElement?.tagName,
}));

/** Text boxes and menus under 16px, which make an iPhone zoom in when tapped. */
const smallFields = (page) => page.evaluate(() =>
  [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]), textarea, select")]
    .filter((e) => e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16)
    .map((e) => `${e.id || e.name || e.tagName} ${getComputedStyle(e).fontSize}`));

try {
  // 1. Each phone: the app fits the screen on every tab, and nothing scrolls the page.
  for (const label of ["iphone", "small-android"]) {
    const { ctx, page } = await device(label);
    await signIn(page, `mobile${label}${run}`);
    const home = await layout(page);
    ok(`${label}: the start screen fits; the page itself doesn't scroll`, home.pageScroll <= 0, `${home.pageScroll}px too tall`);
    ok(`${label}: the header is on screen`, home.headerTop >= 0 && home.scrollY === 0, `top ${home.headerTop}, scrolled ${home.scrollY}`);
    ok(`${label}: the keyboard doesn't pop up on its own`, home.focused !== "input", `focused: ${home.focused}`);
    for (const view of ["scripts", "journal", "chat"]) {
      await page.click(`.view-btn[data-view=${view}]`);
      const l = await layout(page);
      ok(`${label}: ${view} fits the width and scrolls inside its panel`, l.sideScroll <= 0 && l.pageScroll <= 0, `side ${l.sideScroll}, page ${l.pageScroll}`);
      const small = await smallFields(page);
      ok(`${label}: ${view} has no text boxes small enough to zoom an iPhone`, small.length === 0, small.join(", "));
    }
    // A topic's tap is a tap to type: then the box gets focus.
    await page.click(".mode-card[data-mode=everyday]");
    ok(`${label}: picking a topic puts you in the chat box`, await page.evaluate(() => document.activeElement?.id === "input"));
    await ctx.close();
  }

  // 2. On a laptop the chat box is still ready to type in.
  {
    const { ctx, page } = await device("laptop");
    await signIn(page, `mobilelaptop${run}`);
    ok("laptop: the chat box has focus on load", (await layout(page)).focused === "input");
    await page.click("#open-settings");
    ok("laptop: no install section when the browser hasn't offered one", await page.isHidden("#install-field"));
    // Chrome's install offer, as the page sees it.
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      window.__prompted = false;
      const e = new Event("beforeinstallprompt");
      e.prompt = async () => { window.__prompted = true; return { outcome: "accepted" }; };
      window.dispatchEvent(e);
    });
    await page.click("#open-settings");
    ok("laptop: once Chrome offers an install, Settings has the button", await page.isVisible("[data-testid=install-app]"));
    await page.click("[data-testid=install-app]");
    ok("laptop: the button opens Chrome's install prompt", await page.evaluate(() => window.__prompted));
    ok("laptop: and goes away after (a prompt can only be used once)", await page.isHidden("#install-field"));
    await ctx.close();
  }

  // 3. iPhone: Settings → Get the app shows Safari's steps.
  {
    const { ctx, page } = await device("iphone");
    await signIn(page, `mobileios${run}`);
    await page.click("#open-settings");
    ok("iphone: Settings shows how to add Humanual to the home screen", await page.isVisible("[data-testid=install-ios]"));
    ok("iphone: no install button (Safari has no prompt to open)", await page.isHidden("#install-prompt"));
    ok("iphone: an account isn't warned about guest data", await page.isHidden("#install-guest-note"));
    await ctx.close();
  }
  {
    const { ctx, page } = await device("iphone");
    await page.goto(U);
    await page.click("[data-testid=continue-guest]");
    await page.waitForSelector("#onboarding:not([hidden]), #app:not([hidden])");
    if (await page.isVisible("#onboarding")) {
      await page.check("#ob-age");
      await page.click("#onboard-form button[type=submit]");
    }
    await page.waitForSelector("#app:not([hidden])");
    await page.click("#open-settings");
    ok("iphone guest: told guest notes and replies stay in this browser, before installing", await page.isVisible("#install-guest-note"));
    await ctx.close();
  }

  // 4. Home screen shortcuts open the tool they name.
  for (const view of ["scripts", "journal"]) {
    const { ctx, page } = await device("small-android");
    await signIn(page, `mobileshortcut${view}${run}`, `/?view=${view}`);
    ok(`shortcut ?view=${view} opens ${view}`, await page.isVisible(`#${view}-view`));
    ok(`shortcut ?view=${view}: the address is cleaned up`, !page.url().includes("view="));
    await ctx.close();
  }

  // 5. Offline: one quiet line while it lasts.
  {
    const { ctx, page } = await device("iphone");
    await signIn(page, `mobileoffline${run}`);
    ok("online: no offline line", await page.isHidden("[data-testid=offline-bar]"));
    await ctx.setOffline(true);
    await page.waitForSelector("[data-testid=offline-bar]:not([hidden])", { timeout: 5000 }).catch(() => {});
    ok("offline: the line says the coach needs a connection", /coach needs a connection/.test(await page.textContent("[data-testid=offline-bar]")) && await page.isVisible("[data-testid=offline-bar]"));
    ok("offline: the app still fits the screen", (await layout(page)).pageScroll <= 0);
    await ctx.setOffline(false);
    await page.waitForSelector("[data-testid=offline-bar]", { state: "hidden", timeout: 5000 }).catch(() => {});
    ok("back online: the line goes away", await page.isHidden("[data-testid=offline-bar]"));
    await ctx.close();
  }

  // 6. The manifest: what a phone reads to install the app.
  {
    const m = await (await fetch(`${U}/manifest.webmanifest`)).json();
    ok("manifest: standalone, with an id and start address", m.display === "standalone" && m.id === "/" && m.start_url === "/");
    ok("manifest: a 192 and a 512 icon, and a maskable one", ["192x192", "512x512"].every((s) => m.icons.some((i) => i.sizes === s)) && m.icons.some((i) => i.purpose === "maskable"));
    const files = [...m.icons, ...m.shortcuts.flatMap((s) => s.icons)].map((i) => i.src);
    const missing = [];
    for (const src of new Set(files)) if (!(await fetch(U + src)).ok) missing.push(src);
    ok("manifest: every icon it names is there", missing.length === 0, missing.join(", "));
    ok("manifest: shortcuts to Scripts and Journal", ["/?view=scripts", "/?view=journal"].every((u) => m.shortcuts.some((s) => s.url === u)));
  }
} catch (e) {
  results.push("ERROR  " + e.message.split("\n")[0]);
} finally {
  await browser.close();
}
console.log(results.join("\n"));
console.log(errors.length ? "Page errors:\n" + errors.join("\n") : "No page errors.");
process.exitCode = results.every((r) => r.startsWith("PASS")) ? 0 : 1;
