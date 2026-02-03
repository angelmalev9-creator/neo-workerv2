/**
 * NEO WORKER v3.2 - Interactive Browser Agent
 *
 * FIXES:
 * - Better navigation error handling with retry
 * - Never crashes - always returns valid response
 * - Improved DOM observation
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import express, { Request, Response, NextFunction } from "express";

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || "3000");
const WORKER_SECRET = process.env.NEO_WORKER_SECRET || "change-me-in-production";
const NAV_TIMEOUT = 20000;
const NAV_RETRIES = 2;

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface InteractRequest {
  site_url: string;
  user_message: string;
  session_id: string;
  conversation_history: Array<{ role: string; content: string }>;
}

interface DOMObservation {
  url: string;
  title: string;
  buttons: Array<{ text: string; selector: string }>;
  inputs: Array<{ type: string; name: string; placeholder: string; selector: string; value?: string }>;
  links: Array<{ text: string; href: string }>;
  prices: string[];
  visibleText: string;
  forms: number;
  availability_found?: boolean;
}

interface WorkerResponse {
  success: boolean;
  message: string;
  observation?: DOMObservation;
  action_taken?: string;
  logs: string[];
}

// ═══════════════════════════════════════════════════════════════
// SESSION MANAGER
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
// NEO INTERACTIVE WORKER
// ═══════════════════════════════════════════════════════════════

class NeoInteractiveWorker {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private sessions: Map<string, SiteSession> = new Map();
  private isReady = false;

  async start(): Promise<void> {
    console.log("[OPEN] Starting browser...");

    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      locale: "bg-BG",
      timezoneId: "Europe/Sofia",
      ignoreHTTPSErrors: true,
    });

    this.isReady = true;
    console.log("[OPEN] Browser ready!");
  }

  // ─────────────────────────────────────────────────────────────
  // NAVIGATE WITH RETRY
  // ─────────────────────────────────────────────────────────────

  private async navigateWithRetry(page: Page, url: string, logs: string[]): Promise<boolean> {
    for (let attempt = 1; attempt <= NAV_RETRIES; attempt++) {
      try {
        logs.push(`[OPEN] Navigation attempt ${attempt} to ${url}`);
        
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: NAV_TIMEOUT,
        });
        
        await page.waitForTimeout(1500);
        logs.push(`[OPEN] Navigation successful`);
        return true;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logs.push(`[RESULT] Navigation error (attempt ${attempt}): ${errorMsg}`);
        
        // Check if page loaded anyway
        try {
          const currentUrl = page.url();
          if (currentUrl && currentUrl !== "about:blank") {
            logs.push(`[OPEN] Page partially loaded: ${currentUrl}`);
            return true;
          }
        } catch {}
        
        if (attempt < NAV_RETRIES) {
          await page.waitForTimeout(1000);
        }
      }
    }
    
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN INTERACT ENDPOINT
  // ─────────────────────────────────────────────────────────────

  async interact(request: InteractRequest): Promise<WorkerResponse> {
    const logs: string[] = [];
    const log = (tag: string, msg: string) => {
      const entry = `[${tag}] ${msg}`;
      logs.push(entry);
      console.log(entry);
    };

    // Always return valid response, even if not ready
    if (!this.isReady || !this.browser || !this.context) {
      return {
        success: false,
        message: "Браузърът се стартира. Моля, опитайте отново.",
        logs: ["Worker not ready"],
      };
    }

    const { site_url, user_message, session_id } = request;
    log("OPEN", `Session: ${session_id}, URL: ${site_url}`);

    try {
      // ═══════════════════════════════════════════════════════════
      // 1. GET OR CREATE SESSION
      // ═══════════════════════════════════════════════════════════
      let session = this.sessions.get(session_id);
      let needsNavigation = false;

      if (!session) {
        log("OPEN", "Creating new page...");
        const page = await this.context.newPage();
        session = new SiteSession(page, "");
        this.sessions.set(session_id, session);
        needsNavigation = true;
      }

      // Check if page is still valid
      try {
        await session.page.evaluate(() => true);
      } catch {
        log("OPEN", "Page was closed, creating new one...");
        const page = await this.context.newPage();
        session = new SiteSession(page, "");
        this.sessions.set(session_id, session);
        needsNavigation = true;
      }

      // Normalize URL
      let targetUrl = site_url;
      if (targetUrl && !targetUrl.startsWith("http")) {
        targetUrl = "https://" + targetUrl;
      }

      // Navigate if needed
      if (needsNavigation && targetUrl) {
        log("OPEN", `Navigating to ${targetUrl}`);
        const navSuccess = await this.navigateWithRetry(session.page, targetUrl, logs);
        
        if (!navSuccess) {
          log("OPEN", "Navigation failed, continuing with current state");
        }
        
        session.url = session.page.url();
      }

      session.lastActivity = Date.now();

      // ═══════════════════════════════════════════════════════════
      // 2. OBSERVE DOM
      // ═══════════════════════════════════════════════════════════
      log("OBSERVE", "Scanning page...");
      
      let observation: DOMObservation;
      try {
        observation = await this.observeDOM(session.page);
        log("OBSERVE", `Found: ${observation.buttons.length} buttons, ${observation.inputs.length} inputs`);
      } catch (obsError) {
        log("OBSERVE", `Error: ${obsError}`);
        observation = {
          url: session.url || targetUrl || "",
          title: "Страница",
          buttons: [],
          inputs: [],
          links: [],
          prices: [],
          visibleText: "",
          forms: 0,
          availability_found: false,
        };
      }

      // ═══════════════════════════════════════════════════════════
      // 3. MATCH AND DECIDE ACTION
      // ═══════════════════════════════════════════════════════════
      log("MATCH", `User: "${user_message.slice(0, 80)}"`);
      const decision = this.decideAction(user_message, observation);
      log("MATCH", `Decision: ${decision.action} - ${decision.reason}`);

      // ═══════════════════════════════════════════════════════════
      // 4. EXECUTE ACTION
      // ═══════════════════════════════════════════════════════════
      let actionTaken = "";

      if (decision.action === "click" && decision.target) {
        log("ACT", `Clicking: ${decision.target}`);
        const clicked = await this.tryClick(session.page, decision.target);
        if (clicked) {
          actionTaken = `Кликнах на "${decision.target}"`;
          log("ACT", "Click successful");
          await session.page.waitForTimeout(1500);
        }
      } else if (decision.action === "fill" && decision.target && decision.value) {
        log("ACT", `Filling: ${decision.target}`);
        const filled = await this.tryFill(session.page, decision.target, decision.value);
        if (filled) {
          actionTaken = `Попълних поле`;
          log("ACT", "Fill successful");
        }
      } else if (decision.action === "scroll") {
        log("ACT", "Scrolling");
        await session.page.evaluate(() => window.scrollBy(0, 400));
        actionTaken = "Скролнах надолу";
      }

      // ═══════════════════════════════════════════════════════════
      // 5. RE-OBSERVE
      // ═══════════════════════════════════════════════════════════
      let finalObservation = observation;
      if (actionTaken) {
        try {
          finalObservation = await this.observeDOM(session.page);
        } catch {}
      }
      session.url = session.page.url();

      // ═══════════════════════════════════════════════════════════
      // 6. BUILD RESULT
      // ═══════════════════════════════════════════════════════════
      const message = this.buildMessage(actionTaken, finalObservation, user_message);
      log("RESULT", message.slice(0, 100));

      return {
        success: true,
        message,
        observation: finalObservation,
        action_taken: actionTaken || undefined,
        logs,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log("RESULT", `Error: ${errorMsg}`);

      // Clean up broken session
      try {
        const session = this.sessions.get(session_id);
        if (session) {
          await session.page.close().catch(() => {});
          this.sessions.delete(session_id);
        }
      } catch {}

      // ALWAYS return valid response
      return {
        success: false,
        message: `Възникна грешка. Моля, опитайте отново.`,
        logs,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // DOM OBSERVATION
  // ─────────────────────────────────────────────────────────────

  private async observeDOM(page: Page): Promise<DOMObservation> {
    return await page.evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.top < window.innerHeight + 100
        );
      };

      const getSelector = (el: Element, index: number): string => {
        if (el.id) return `#${el.id}`;
        if (el.className && typeof el.className === "string") {
          const cls = el.className.trim().split(/\s+/)[0];
          if (cls && !cls.includes(":")) return `.${cls}`;
        }
        return `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
      };

      // Buttons
      const buttons = Array.from(
        document.querySelectorAll("button, a[href], [role='button'], input[type='submit'], .btn")
      )
        .filter(isVisible)
        .slice(0, 25)
        .map((el, i) => ({
          text: (el.textContent?.trim() || (el as HTMLInputElement).value || "").slice(0, 80),
          selector: getSelector(el, i),
        }))
        .filter((b) => b.text.length > 0);

      // Inputs
      const inputs = Array.from(
        document.querySelectorAll("input:not([type='hidden']):not([type='submit']), textarea, select")
      )
        .filter(isVisible)
        .slice(0, 15)
        .map((el, i) => {
          const input = el as HTMLInputElement;
          return {
            type: input.type || "text",
            name: input.name || input.id || "",
            placeholder: input.placeholder || "",
            selector: getSelector(el, i),
            value: input.value || undefined,
          };
        });

      // Links
      const links = Array.from(document.querySelectorAll("a[href]"))
        .filter(isVisible)
        .slice(0, 15)
        .map((el) => ({
          text: el.textContent?.trim().slice(0, 50) || "",
          href: (el as HTMLAnchorElement).href,
        }))
        .filter((l) => l.text.length > 0);

      // Prices
      const priceRegex = /(\d+[\s,.]?\d*)\s*(лв\.?|BGN|EUR|€|\$)/gi;
      const bodyText = document.body.innerText;
      const prices = [...bodyText.matchAll(priceRegex)].map((m) => m[0]).slice(0, 8);

      // Visible text
      const visibleText = bodyText.slice(0, 1000).replace(/\s+/g, " ").trim();

      // Availability check
      const availability_found = /налични|свободни|available|free rooms/i.test(visibleText);

      return {
        url: window.location.href,
        title: document.title,
        buttons,
        inputs,
        links,
        prices,
        visibleText,
        forms: document.querySelectorAll("form").length,
        availability_found,
      };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // ACTION DECISION
  // ─────────────────────────────────────────────────────────────

  private decideAction(
    userMessage: string,
    observation: DOMObservation
  ): { action: string; target?: string; value?: string; reason: string } {
    const msg = userMessage.toLowerCase();

    // Extract data from message
    const emailMatch = userMessage.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    const dateMatch = userMessage.match(/(\d{1,2})[./-](\d{1,2})/);

    // Fill email
    if (emailMatch) {
      const emailInput = observation.inputs.find(
        (i) => i.type === "email" || /email|имейл/i.test(i.name) || /email|имейл/i.test(i.placeholder)
      );
      if (emailInput) {
        return { action: "fill", target: emailInput.selector, value: emailMatch[0], reason: "Попълване на имейл" };
      }
    }

    // Fill date
    if (dateMatch) {
      const dateInput = observation.inputs.find(
        (i) => i.type === "date" || /date|дата|check/i.test(i.name)
      );
      if (dateInput) {
        return { action: "fill", target: dateInput.selector, value: dateMatch[0], reason: "Попълване на дата" };
      }
    }

    // Click booking/reserve button
    if (/резерв|book|reserve|запази/i.test(msg)) {
      const btn = observation.buttons.find((b) => /резерв|book|reserve|запази/i.test(b.text));
      if (btn) {
        return { action: "click", target: btn.selector, reason: `Кликване: ${btn.text}` };
      }
    }

    // Click availability/check button
    if (/наличност|налични|свободни|availability|check|провери/i.test(msg)) {
      const btn = observation.buttons.find((b) => 
        /наличност|налични|свободни|availability|check|провери|търси|search/i.test(b.text)
      );
      if (btn) {
        return { action: "click", target: btn.selector, reason: `Кликване: ${btn.text}` };
      }
    }

    // Click rooms button
    if (/стаи|rooms|настаняване|accommodation/i.test(msg)) {
      const btn = observation.buttons.find((b) => /стаи|rooms|настаняване|accommodation/i.test(b.text));
      if (btn) {
        return { action: "click", target: btn.selector, reason: `Кликване: ${btn.text}` };
      }
    }

    // Submit
    if (/изпрати|submit|потвърди|send/i.test(msg)) {
      const btn = observation.buttons.find((b) => /изпрати|submit|потвърди|send/i.test(b.text));
      if (btn) {
        return { action: "click", target: btn.selector, reason: `Кликване: ${btn.text}` };
      }
    }

    // Scroll
    if (/надолу|повече|scroll|more/i.test(msg)) {
      return { action: "scroll", reason: "Скролване" };
    }

    return { action: "none", reason: "Наблюдение - няма конкретно действие" };
  }

  // ─────────────────────────────────────────────────────────────
  // ACTION EXECUTION
  // ─────────────────────────────────────────────────────────────

  private async tryClick(page: Page, target: string): Promise<boolean> {
    const strategies = [target, `text="${target}"`, `button:has-text("${target}")`, `a:has-text("${target}")`];

    for (const selector of strategies) {
      try {
        await page.click(selector, { timeout: 3000 });
        return true;
      } catch {}
    }
    return false;
  }

  private async tryFill(page: Page, target: string, value: string): Promise<boolean> {
    const strategies = [target, `#${target}`, `[name="${target}"]`, `[placeholder*="${target}" i]`];

    for (const selector of strategies) {
      try {
        await page.fill(selector, value, { timeout: 2000 });
        return true;
      } catch {}
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // BUILD MESSAGE
  // ─────────────────────────────────────────────────────────────

  private buildMessage(actionTaken: string, observation: DOMObservation, userMessage: string): string {
    const parts: string[] = [];

    if (actionTaken) {
      parts.push(actionTaken + ".");
    }

    parts.push(`Страница: "${observation.title}".`);

    if (observation.buttons.length > 0) {
      const btnList = observation.buttons.slice(0, 5).map((b) => `"${b.text}"`).join(", ");
      parts.push(`Бутони: ${btnList}.`);
    }

    if (observation.inputs.length > 0) {
      const emptyInputs = observation.inputs.filter((i) => !i.value);
      if (emptyInputs.length > 0) {
        parts.push(`Полета: ${emptyInputs.length}.`);
      }
    }

    if (observation.prices.length > 0) {
      parts.push(`Цени: ${observation.prices.slice(0, 3).join(", ")}.`);
    }

    return parts.join(" ");
  }

  // ─────────────────────────────────────────────────────────────
  // STATUS
  // ─────────────────────────────────────────────────────────────

  getStatus(): object {
    return {
      ready: this.isReady,
      activeSessions: this.sessions.size,
      uptime: Math.floor(process.uptime()),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + " MB",
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.page.close().catch(() => {});
      this.sessions.delete(sessionId);
    }
  }

  async shutdown(): Promise<void> {
    for (const [, session] of this.sessions) {
      await session.page.close().catch(() => {});
    }
    this.sessions.clear();
    if (this.browser) {
      await this.browser.close();
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════

async function main() {
  const worker = new NeoInteractiveWorker();
  await worker.start();

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Auth
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/" || req.path === "/health") return next();
    
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token !== WORKER_SECRET) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
  });

  // Health
  app.get("/", (_, res) => res.json({ status: "ok", service: "neo-worker", version: "3.2.0" }));
  app.get("/health", (_, res) => res.json({ status: "ok", ...worker.getStatus() }));

  // Main endpoint
  app.post("/interact", async (req, res) => {
    const request = req.body as InteractRequest;

    if (!request.site_url || !request.user_message || !request.session_id) {
      return res.json({
        success: false,
        message: "Липсват задължителни полета",
        logs: ["Missing fields"],
      });
    }

    const result = await worker.interact(request);
    res.json(result);
  });

  // Close session
  app.post("/close", async (req, res) => {
    if (req.body.session_id) {
      await worker.closeSession(req.body.session_id);
    }
    res.json({ success: true });
  });

  app.get("/status", (_, res) => res.json(worker.getStatus()));

  app.listen(PORT, () => {
    console.log(`\n🟢 NEO Worker v3.2 running on port ${PORT}\n`);
  });

  const shutdown = async () => {
    await worker.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(console.error);
