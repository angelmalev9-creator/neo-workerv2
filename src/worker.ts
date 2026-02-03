/**
 * NEO WORKER v3.3 - Intelligent Booking Agent
 *
 * FEATURES:
 * - Smart booking form detection and filling
 * - Date input handling (check-in, check-out)
 * - Guest count handling
 * - Automatic availability check
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import express, { Request, Response, NextFunction } from "express";

const PORT = parseInt(process.env.PORT || "3000");
const WORKER_SECRET = process.env.NEO_WORKER_SECRET || "change-me-in-production";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface InteractRequest {
  site_url: string;
  user_message: string;
  session_id: string;
  conversation_history: Array<{ role: string; content: string }>;
  booking_data?: {
    check_in?: string;
    check_out?: string;
    guests?: number;
  };
}

interface DOMObservation {
  url: string;
  title: string;
  buttons: Array<{ text: string; selector: string }>;
  inputs: Array<{ type: string; name: string; placeholder: string; selector: string; label?: string }>;
  prices: string[];
  visibleText: string;
  forms: number;
  availability_found: boolean;
}

interface WorkerResponse {
  success: boolean;
  message: string;
  observation?: DOMObservation;
  action_taken?: string;
  logs: string[];
}

// ═══════════════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════════════

class SiteSession {
  public page: Page;
  public url: string;
  public lastActivity: number;
  constructor(page: Page, url: string) {
    this.page = page;
    this.url = url;
    this.lastActivity = Date.now();
  }
}

// ═══════════════════════════════════════════════════════════════
// WORKER
// ═══════════════════════════════════════════════════════════════

class NeoWorker {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private sessions: Map<string, SiteSession> = new Map();
  private isReady = false;

  async start(): Promise<void> {
    console.log("[OPEN] Starting browser...");
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
      locale: "bg-BG",
      timezoneId: "Europe/Sofia",
      ignoreHTTPSErrors: true,
    });
    this.isReady = true;
    console.log("[OPEN] Browser ready!");
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN INTERACT
  // ─────────────────────────────────────────────────────────────

  async interact(request: InteractRequest): Promise<WorkerResponse> {
    const logs: string[] = [];
    const log = (tag: string, msg: string) => {
      logs.push(`[${tag}] ${msg}`);
      console.log(`[${tag}] ${msg}`);
    };

    if (!this.isReady || !this.context) {
      return { success: false, message: "Worker не е готов", logs };
    }

    const { site_url, user_message, session_id, booking_data } = request;
    log("OPEN", `Session: ${session_id}`);

    try {
      // Get or create session
      let session = this.sessions.get(session_id);
      let needsNav = false;

      if (!session) {
        log("OPEN", "Creating new page...");
        const page = await this.context.newPage();
        session = new SiteSession(page, "");
        this.sessions.set(session_id, session);
        needsNav = true;
      }

      // Check page validity
      try {
        await session.page.evaluate(() => true);
      } catch {
        log("OPEN", "Page closed, recreating...");
        const page = await this.context.newPage();
        session = new SiteSession(page, "");
        this.sessions.set(session_id, session);
        needsNav = true;
      }

      // Navigate
      let targetUrl = site_url;
      if (targetUrl && !targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl;

      if (needsNav && targetUrl) {
        log("OPEN", `Navigating to ${targetUrl}`);
        try {
          await session.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          await session.page.waitForTimeout(2000);
        } catch (e) {
          log("OPEN", `Nav error: ${e}, continuing...`);
        }
        session.url = session.page.url();
      }

      session.lastActivity = Date.now();

      // Observe DOM
      log("OBSERVE", "Scanning page...");
      let observation = await this.observeDOM(session.page);
      log("OBSERVE", `Found: ${observation.buttons.length} buttons, ${observation.inputs.length} inputs`);

      // ═══════════════════════════════════════════════════════════
      // SMART ACTION EXECUTION
      // ═══════════════════════════════════════════════════════════
      const actions: string[] = [];
      const lowerMsg = user_message.toLowerCase();

      // Check if this is a booking request
      const isBookingRequest = /резерв|book|запази|наличност|свободн|availability/i.test(lowerMsg) ||
                               (booking_data?.check_in && booking_data?.check_out);

      log("MATCH", `User: "${user_message.slice(0, 60)}", isBooking: ${isBookingRequest}`);

      if (isBookingRequest && booking_data) {
        log("ACT", `Booking data: ${JSON.stringify(booking_data)}`);

        // 1. Fill check-in date
        if (booking_data.check_in) {
          const filled = await this.fillDateInput(session.page, "check_in", booking_data.check_in, observation);
          if (filled) {
            actions.push(`Попълних дата за настаняване: ${booking_data.check_in}`);
            log("ACT", "Check-in filled");
          }
        }

        // 2. Fill check-out date
        if (booking_data.check_out) {
          const filled = await this.fillDateInput(session.page, "check_out", booking_data.check_out, observation);
          if (filled) {
            actions.push(`Попълних дата за напускане: ${booking_data.check_out}`);
            log("ACT", "Check-out filled");
          }
        }

        // 3. Fill guests
        if (booking_data.guests) {
          const filled = await this.fillGuestsInput(session.page, booking_data.guests, observation);
          if (filled) {
            actions.push(`Избрах ${booking_data.guests} гости`);
            log("ACT", "Guests filled");
          }
        }

        // 4. Click search/check availability button
        if (actions.length > 0 || isBookingRequest) {
          const clicked = await this.clickSearchButton(session.page, observation);
          if (clicked) {
            actions.push("Натиснах бутона за търсене");
            log("ACT", "Search clicked");
            await session.page.waitForTimeout(2000);
          }
        }
      } else {
        // Non-booking actions
        const decision = this.decideAction(user_message, observation);
        log("MATCH", `Decision: ${decision.action} - ${decision.reason}`);

        if (decision.action === "click" && decision.target) {
          const clicked = await this.tryClick(session.page, decision.target);
          if (clicked) {
            actions.push(`Кликнах на "${decision.target}"`);
            await session.page.waitForTimeout(1500);
          }
        }
      }

      // Re-observe after actions
      if (actions.length > 0) {
        observation = await this.observeDOM(session.page);
      }
      session.url = session.page.url();

      // Build message
      const actionTaken = actions.length > 0 ? actions.join(". ") : null;
      const message = this.buildMessage(actionTaken, observation);
      log("RESULT", message.slice(0, 100));

      return {
        success: true,
        message,
        observation,
        action_taken: actionTaken || undefined,
        logs,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log("RESULT", `Error: ${errMsg}`);

      try {
        const s = this.sessions.get(session_id);
        if (s) { await s.page.close().catch(() => {}); this.sessions.delete(session_id); }
      } catch {}

      return { success: false, message: "Грешка. Опитайте отново.", logs };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // FILL DATE INPUT
  // ─────────────────────────────────────────────────────────────

  private async fillDateInput(page: Page, type: "check_in" | "check_out", value: string, obs: DOMObservation): Promise<boolean> {
    // Keywords for each type
    const keywords = type === "check_in"
      ? ["check-in", "checkin", "check_in", "arrival", "from", "start", "настаняване", "от", "пристигане"]
      : ["check-out", "checkout", "check_out", "departure", "to", "end", "напускане", "до", "заминаване"];

    // Find matching input
    const matchingInput = obs.inputs.find(input => {
      const searchText = `${input.name} ${input.placeholder} ${input.label || ""}`.toLowerCase();
      return (input.type === "date" || input.type === "text") && 
             keywords.some(kw => searchText.includes(kw));
    });

    if (matchingInput) {
      try {
        await page.fill(matchingInput.selector, value, { timeout: 2000 });
        return true;
      } catch {}
    }

    // Fallback: try by index (first date = check-in, second = check-out)
    const dateInputs = obs.inputs.filter(i => i.type === "date");
    const idx = type === "check_in" ? 0 : 1;
    if (dateInputs[idx]) {
      try {
        await page.fill(dateInputs[idx].selector, value, { timeout: 2000 });
        return true;
      } catch {}
    }

    // Try clicking and typing for date pickers
    const selectors = type === "check_in"
      ? ['[name*="checkin" i]', '[id*="checkin" i]', '[placeholder*="check-in" i]', 'input[type="date"]:first-of-type']
      : ['[name*="checkout" i]', '[id*="checkout" i]', '[placeholder*="check-out" i]', 'input[type="date"]:last-of-type'];

    for (const sel of selectors) {
      try {
        await page.fill(sel, value, { timeout: 1500 });
        return true;
      } catch {}
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // FILL GUESTS INPUT
  // ─────────────────────────────────────────────────────────────

  private async fillGuestsInput(page: Page, guests: number, obs: DOMObservation): Promise<boolean> {
    const keywords = ["guests", "adults", "гости", "възрастни", "човека", "persons", "pax"];

    // Find matching input or select
    const matchingInput = obs.inputs.find(input => {
      const searchText = `${input.name} ${input.placeholder} ${input.label || ""}`.toLowerCase();
      return keywords.some(kw => searchText.includes(kw));
    });

    if (matchingInput) {
      try {
        if (matchingInput.type === "select") {
          await page.selectOption(matchingInput.selector, String(guests), { timeout: 2000 });
        } else {
          await page.fill(matchingInput.selector, String(guests), { timeout: 2000 });
        }
        return true;
      } catch {}
    }

    // Try common selectors
    const selectors = [
      '[name*="guest" i]', '[name*="adult" i]', '[id*="guest" i]', '[id*="adult" i]',
      'select[name*="guest" i]', 'select[name*="adult" i]',
    ];

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const tagName = await el.evaluate(e => e.tagName.toLowerCase());
          if (tagName === "select") {
            await page.selectOption(sel, String(guests), { timeout: 1500 });
          } else {
            await page.fill(sel, String(guests), { timeout: 1500 });
          }
          return true;
        }
      } catch {}
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // CLICK SEARCH BUTTON
  // ─────────────────────────────────────────────────────────────

  private async clickSearchButton(page: Page, obs: DOMObservation): Promise<boolean> {
    const keywords = [
      "search", "check", "find", "book", "reserve", "submit",
      "търси", "провери", "наличност", "резервирай", "запази", "покажи"
    ];

    // Find matching button
    const matchingBtn = obs.buttons.find(btn => {
      const text = btn.text.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    });

    if (matchingBtn) {
      try {
        await page.click(matchingBtn.selector, { timeout: 3000 });
        return true;
      } catch {}
    }

    // Try by text
    for (const kw of keywords) {
      try {
        await page.click(`button:has-text("${kw}")`, { timeout: 1500 });
        return true;
      } catch {}
      try {
        await page.click(`a:has-text("${kw}")`, { timeout: 1500 });
        return true;
      } catch {}
    }

    // Try submit button in form
    try {
      await page.click('form button[type="submit"], form input[type="submit"]', { timeout: 1500 });
      return true;
    } catch {}

    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // DOM OBSERVATION
  // ─────────────────────────────────────────────────────────────

  private async observeDOM(page: Page): Promise<DOMObservation> {
    return await page.evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };

      const getSelector = (el: Element, idx: number): string => {
        if (el.id) return `#${el.id}`;
        if (el.className && typeof el.className === "string") {
          const cls = el.className.trim().split(/\s+/)[0];
          if (cls && !cls.includes(":")) return `.${cls}`;
        }
        return `${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
      };

      const getLabel = (el: Element): string | undefined => {
        const id = el.id;
        if (id) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label) return label.textContent?.trim();
        }
        const parent = el.closest("label");
        if (parent) return parent.textContent?.trim();
        return undefined;
      };

      // Buttons
      const buttons = Array.from(document.querySelectorAll("button, a[href], [role='button'], input[type='submit'], .btn"))
        .filter(isVisible)
        .slice(0, 25)
        .map((el, i) => ({
          text: (el.textContent?.trim() || (el as HTMLInputElement).value || "").slice(0, 80),
          selector: getSelector(el, i),
        }))
        .filter(b => b.text.length > 0);

      // Inputs with labels
      const inputs = Array.from(document.querySelectorAll("input:not([type='hidden']):not([type='submit']), textarea, select"))
        .filter(isVisible)
        .slice(0, 20)
        .map((el, i) => {
          const input = el as HTMLInputElement;
          return {
            type: input.type || el.tagName.toLowerCase(),
            name: input.name || input.id || "",
            placeholder: input.placeholder || "",
            selector: getSelector(el, i),
            label: getLabel(el),
          };
        });

      // Prices
      const priceRegex = /(\d+[\s,.]?\d*)\s*(лв\.?|BGN|EUR|€|\$)/gi;
      const bodyText = document.body.innerText;
      const prices = [...bodyText.matchAll(priceRegex)].map(m => m[0]).slice(0, 10);

      // Visible text
      const visibleText = bodyText.slice(0, 1200).replace(/\s+/g, " ").trim();

      // Availability
      const availability_found = /налични|свободни|available|free/i.test(visibleText);

      return {
        url: window.location.href,
        title: document.title,
        buttons,
        inputs,
        prices,
        visibleText,
        forms: document.querySelectorAll("form").length,
        availability_found,
      };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // SIMPLE ACTION DECISION (for non-booking)
  // ─────────────────────────────────────────────────────────────

  private decideAction(msg: string, obs: DOMObservation): { action: string; target?: string; reason: string } {
    const lower = msg.toLowerCase();

    // Rooms/accommodation
    if (/стаи|rooms|настаняване/i.test(lower)) {
      const btn = obs.buttons.find(b => /стаи|rooms|настаняване|accommodation/i.test(b.text));
      if (btn) return { action: "click", target: btn.selector, reason: btn.text };
    }

    // Contact
    if (/контакт|contact|свържи/i.test(lower)) {
      const btn = obs.buttons.find(b => /контакт|contact|свържи/i.test(b.text));
      if (btn) return { action: "click", target: btn.selector, reason: btn.text };
    }

    return { action: "none", reason: "Наблюдение" };
  }

  private async tryClick(page: Page, target: string): Promise<boolean> {
    for (const sel of [target, `text="${target}"`, `button:has-text("${target}")`, `a:has-text("${target}")`]) {
      try {
        await page.click(sel, { timeout: 2000 });
        return true;
      } catch {}
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // BUILD MESSAGE
  // ─────────────────────────────────────────────────────────────

  private buildMessage(action: string | null, obs: DOMObservation): string {
    const parts: string[] = [];
    
    if (action) parts.push(action + ".");
    
    parts.push(`Страница: "${obs.title}".`);
    
    if (obs.buttons.length > 0) {
      parts.push(`Бутони: ${obs.buttons.slice(0, 5).map(b => `"${b.text}"`).join(", ")}.`);
    }
    
    if (obs.prices.length > 0) {
      parts.push(`Цени: ${obs.prices.slice(0, 3).join(", ")}.`);
    }

    if (obs.availability_found) {
      parts.push("Намерих информация за наличност.");
    }

    return parts.join(" ");
  }

  // ─────────────────────────────────────────────────────────────
  // UTILITY
  // ─────────────────────────────────────────────────────────────

  getStatus() {
    return { ready: this.isReady, sessions: this.sessions.size, uptime: Math.floor(process.uptime()) };
  }

  async closeSession(id: string) {
    const s = this.sessions.get(id);
    if (s) { await s.page.close().catch(() => {}); this.sessions.delete(id); }
  }

  async shutdown() {
    for (const [, s] of this.sessions) await s.page.close().catch(() => {});
    this.sessions.clear();
    if (this.browser) await this.browser.close();
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════

async function main() {
  const worker = new NeoWorker();
  await worker.start();

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/" || req.path === "/health") return next();
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token !== WORKER_SECRET) return res.status(401).json({ success: false, error: "Unauthorized" });
    next();
  });

  app.get("/", (_, res) => res.json({ status: "ok", version: "3.3.0" }));
  app.get("/health", (_, res) => res.json({ status: "ok", ...worker.getStatus() }));

  app.post("/interact", async (req, res) => {
    const request = req.body as InteractRequest;
    if (!request.site_url || !request.user_message || !request.session_id) {
      return res.json({ success: false, message: "Missing fields", logs: [] });
    }
    const result = await worker.interact(request);
    res.json(result);
  });

  app.post("/close", async (req, res) => {
    if (req.body.session_id) await worker.closeSession(req.body.session_id);
    res.json({ success: true });
  });

  app.listen(PORT, () => console.log(`\n🟢 NEO Worker v3.3 on port ${PORT}\n`));

  process.on("SIGTERM", async () => { await worker.shutdown(); process.exit(0); });
  process.on("SIGINT", async () => { await worker.shutdown(); process.exit(0); });
}

main().catch(console.error);
