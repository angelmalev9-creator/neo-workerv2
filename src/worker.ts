/**
 * NEO WORKER v3.0 - Interactive Browser Agent
 *
 * ARCHITECTURE:
 * - Receives: site_url, user_message, session_id, conversation_history
 * - Opens/reuses browser page
 * - Observes DOM (buttons, links, inputs, iframes, modals)
 * - Matches DOM text against conversation context
 * - Decides next action (click, fill, wait)
 * - Executes action
 * - Re-observes and returns result
 *
 * NO command-based logic, NO business heuristics
 * Conversation + DOM = actions
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import express, { Request, Response, NextFunction } from "express";

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

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
}

interface DOMObservation {
  url: string;
  title: string;
  buttons: Array<{ text: string; selector: string }>;
  inputs: Array<{ type: string; name: string; placeholder: string; selector: string; value?: string }>;
  links: Array<{ text: string; href: string }>;
  modals: Array<{ text: string; selector: string }>;
  prices: string[];
  visibleText: string;
  forms: number;
  iframes: number;
}

interface ActionDecision {
  action: "click" | "fill" | "wait" | "scroll" | "none";
  target?: string;
  value?: string;
  reason: string;
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

  // ─────────────────────────────────────────────────────────────
  // STARTUP
  // ─────────────────────────────────────────────────────────────

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
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "bg-BG",
      timezoneId: "Europe/Sofia",
    });

    this.isReady = true;
    console.log("[OPEN] Browser ready!");
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

    if (!this.isReady || !this.browser || !this.context) {
      return { success: false, message: "Worker not ready", logs };
    }

    const { site_url, user_message, session_id, conversation_history } = request;
    log("OPEN", `Session: ${session_id}, URL: ${site_url}`);

    try {
      // ═══════════════════════════════════════════════════════════
      // 1. OPEN or REUSE page
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

      // Normalize URL
      let targetUrl = site_url;
      if (targetUrl && !targetUrl.startsWith("http")) {
        targetUrl = "https://" + targetUrl;
      }

      // Navigate if needed or URL changed
      if (needsNavigation || (targetUrl && session.url !== targetUrl)) {
        log("OPEN", `Navigating to ${targetUrl}`);
        await session.page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
        await session.page.waitForTimeout(1500);
        session.url = session.page.url();
      }

      session.lastActivity = Date.now();

      // ═══════════════════════════════════════════════════════════
      // 2. OBSERVE DOM
      // ═══════════════════════════════════════════════════════════
      log("OBSERVE", "Scanning page...");
      const observation = await this.observeDOM(session.page);
      log("OBSERVE", `Found: ${observation.buttons.length} buttons, ${observation.inputs.length} inputs`);

      // ═══════════════════════════════════════════════════════════
      // 3. MATCH - Decide action based on user message + DOM
      // ═══════════════════════════════════════════════════════════
      log("MATCH", `User: "${user_message.slice(0, 100)}"`);
      const decision = this.decideAction(user_message, observation, conversation_history);
      log("MATCH", `Decision: ${decision.action} - ${decision.reason}`);

      // ═══════════════════════════════════════════════════════════
      // 4. ACT - Execute the decision
      // ═══════════════════════════════════════════════════════════
      let actionTaken = "";

      if (decision.action === "click" && decision.target) {
        log("ACT", `Clicking: ${decision.target}`);
        const clicked = await this.tryClick(session.page, decision.target);
        if (clicked) {
          actionTaken = `Кликнах на "${decision.target}"`;
          log("ACT", "Click successful");
          await session.page.waitForTimeout(1500);
        } else {
          log("ACT", "Click failed - target not found");
        }
      } else if (decision.action === "fill" && decision.target && decision.value) {
        log("ACT", `Filling: ${decision.target} = ${decision.value}`);
        const filled = await this.tryFill(session.page, decision.target, decision.value);
        if (filled) {
          actionTaken = `Попълних "${decision.target}" с "${decision.value}"`;
          log("ACT", "Fill successful");
        } else {
          log("ACT", "Fill failed - input not found");
        }
      } else if (decision.action === "scroll") {
        log("ACT", "Scrolling down");
        await session.page.evaluate(() => window.scrollBy(0, 400));
        actionTaken = "Скролнах надолу";
      } else if (decision.action === "wait") {
        log("WAIT", "Waiting for page...");
        await session.page.waitForTimeout(1000);
      }

      // ═══════════════════════════════════════════════════════════
      // 5. RE-OBSERVE after action
      // ═══════════════════════════════════════════════════════════
      const finalObservation = await this.observeDOM(session.page);
      session.url = session.page.url();

      // ═══════════════════════════════════════════════════════════
      // 6. RESULT
      // ═══════════════════════════════════════════════════════════
      const message = this.buildResultMessage(actionTaken, finalObservation, decision);
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
      if (session_id) {
        const session = this.sessions.get(session_id);
        if (session) {
          await session.page.close().catch(() => {});
          this.sessions.delete(session_id);
        }
      }

      return {
        success: false,
        message: `Грешка: ${errorMsg}`,
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
          style.opacity !== "0" &&
          rect.top < window.innerHeight &&
          rect.bottom > 0
        );
      };

      const getSelector = (el: Element, index: number): string => {
        if (el.id) return `#${el.id}`;
        if (el.className && typeof el.className === "string") {
          const cls = el.className.trim().split(/\s+/)[0];
          if (cls && !cls.includes(":")) return `${el.tagName.toLowerCase()}.${cls}`;
        }
        return `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
      };

      // Find clickable elements
      const buttons = Array.from(
        document.querySelectorAll(
          "button, a[href], [role='button'], input[type='submit'], input[type='button'], .btn, [class*='button'], [class*='btn'], [onclick]"
        )
      )
        .filter(isVisible)
        .slice(0, 25)
        .map((el, i) => ({
          text: (el.textContent?.trim() || (el as HTMLInputElement).value || "").slice(0, 80),
          selector: getSelector(el, i),
        }))
        .filter((b) => b.text.length > 0);

      // Find inputs
      const inputs = Array.from(
        document.querySelectorAll(
          "input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select"
        )
      )
        .filter(isVisible)
        .slice(0, 20)
        .map((el, i) => {
          const input = el as HTMLInputElement;
          return {
            type: input.type || el.tagName.toLowerCase(),
            name: input.name || input.id || "",
            placeholder: input.placeholder || input.getAttribute("aria-label") || "",
            selector: getSelector(el, i),
            value: input.value || undefined,
          };
        });

      // Find links
      const links = Array.from(document.querySelectorAll("a[href]"))
        .filter(isVisible)
        .slice(0, 15)
        .map((el) => ({
          text: el.textContent?.trim().slice(0, 50) || "",
          href: (el as HTMLAnchorElement).href,
        }))
        .filter((l) => l.text.length > 0);

      // Find modals/dialogs
      const modals = Array.from(
        document.querySelectorAll("[role='dialog'], .modal, .popup, [class*='modal'], [class*='dialog']")
      )
        .filter(isVisible)
        .slice(0, 3)
        .map((el, i) => ({
          text: el.textContent?.trim().slice(0, 200) || "",
          selector: getSelector(el, i),
        }));

      // Find prices
      const priceRegex = /(\d+[\s,.]?\d*)\s*(лв|BGN|EUR|€|\$|USD)/gi;
      const bodyText = document.body.innerText;
      const prices = [...bodyText.matchAll(priceRegex)].map((m) => m[0]).slice(0, 10);

      // Visible text
      const visibleText = bodyText.slice(0, 1000).replace(/\s+/g, " ").trim();

      return {
        url: window.location.href,
        title: document.title,
        buttons,
        inputs,
        links,
        modals,
        prices,
        visibleText,
        forms: document.querySelectorAll("form").length,
        iframes: document.querySelectorAll("iframe").length,
      };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // ACTION DECISION - Based on user message + DOM
  // ─────────────────────────────────────────────────────────────

  private decideAction(
    userMessage: string,
    observation: DOMObservation,
    history: Array<{ role: string; content: string }>
  ): ActionDecision {
    const msg = userMessage.toLowerCase();

    // Extract potential values from user message
    const emailMatch = userMessage.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    const phoneMatch = userMessage.match(/(?:\+359|0)[\s-]?(?:8[7-9]\d|[2-9]\d{2})[\s-]?\d{3}[\s-]?\d{3}/);
    const dateMatch = userMessage.match(/(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/);
    const nameMatch = userMessage.match(
      /(?:казвам се|аз съм|името ми е)\s+([А-Яа-яA-Za-z]+(?:\s+[А-Яа-яA-Za-z]+)?)/i
    );

    // ─────────────────────────────────────────────────────────────
    // Priority 1: Handle modals first
    // ─────────────────────────────────────────────────────────────
    if (observation.modals.length > 0) {
      // Look for close button
      const closeBtn = observation.buttons.find((b) =>
        /затвори|close|x|cancel|отказ/i.test(b.text)
      );
      if (closeBtn && /затвори|close|cancel/i.test(msg)) {
        return { action: "click", target: closeBtn.selector, reason: "Затваряне на диалог" };
      }

      // Look for confirm button
      const confirmBtn = observation.buttons.find((b) =>
        /потвърди|confirm|ok|да|yes|приемам|accept/i.test(b.text)
      );
      if (confirmBtn && /да|yes|потвърди|confirm|приемам/i.test(msg)) {
        return { action: "click", target: confirmBtn.selector, reason: "Потвърждение в диалог" };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Priority 2: Fill inputs if user provided data
    // ─────────────────────────────────────────────────────────────
    if (emailMatch) {
      const emailInput = observation.inputs.find(
        (i) =>
          i.type === "email" ||
          /email|имейл|e-mail|поща/i.test(i.name) ||
          /email|имейл|e-mail|поща/i.test(i.placeholder)
      );
      if (emailInput) {
        return { action: "fill", target: emailInput.selector, value: emailMatch[0], reason: "Попълване на имейл" };
      }
    }

    if (phoneMatch) {
      const phoneInput = observation.inputs.find(
        (i) =>
          i.type === "tel" ||
          /phone|телефон|тел|mobile|gsm/i.test(i.name) ||
          /phone|телефон|тел|mobile|gsm/i.test(i.placeholder)
      );
      if (phoneInput) {
        return { action: "fill", target: phoneInput.selector, value: phoneMatch[0], reason: "Попълване на телефон" };
      }
    }

    if (nameMatch) {
      const nameInput = observation.inputs.find(
        (i) =>
          /name|име|фамилия|first|last/i.test(i.name) ||
          /name|име|фамилия|first|last/i.test(i.placeholder)
      );
      if (nameInput) {
        return { action: "fill", target: nameInput.selector, value: nameMatch[1], reason: "Попълване на име" };
      }
    }

    if (dateMatch) {
      const dateInput = observation.inputs.find(
        (i) =>
          i.type === "date" ||
          /date|дата|check|настаняване/i.test(i.name) ||
          /date|дата|check|настаняване/i.test(i.placeholder)
      );
      if (dateInput) {
        return { action: "fill", target: dateInput.selector, value: dateMatch[0], reason: "Попълване на дата" };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Priority 3: Click buttons matching user intent
    // ─────────────────────────────────────────────────────────────
    const intentKeywords = this.extractIntentKeywords(msg);

    for (const keyword of intentKeywords) {
      const matchingBtn = observation.buttons.find((b) => b.text.toLowerCase().includes(keyword));
      if (matchingBtn) {
        return { action: "click", target: matchingBtn.selector, reason: `Кликване: "${matchingBtn.text}"` };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Priority 4: Common action patterns
    // ─────────────────────────────────────────────────────────────

    // Submit/Send
    if (/изпрати|submit|потвърди|запази|book|reserve|резервирай/i.test(msg)) {
      const submitBtn = observation.buttons.find((b) =>
        /изпрати|submit|потвърди|запази|book|reserve|резервирай|send/i.test(b.text)
      );
      if (submitBtn) {
        return { action: "click", target: submitBtn.selector, reason: "Изпращане/потвърждение" };
      }
    }

    // Search
    if (/търси|search|намери|find/i.test(msg)) {
      const searchBtn = observation.buttons.find((b) => /търси|search|намери|find/i.test(b.text));
      if (searchBtn) {
        return { action: "click", target: searchBtn.selector, reason: "Търсене" };
      }
    }

    // Contact/Book
    if (/контакт|contact|свържи|обади|резервация|booking/i.test(msg)) {
      const contactBtn = observation.buttons.find((b) =>
        /контакт|contact|свържи|обади|резервация|booking|запитване|inquiry/i.test(b.text)
      );
      if (contactBtn) {
        return { action: "click", target: contactBtn.selector, reason: "Контакт/резервация" };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Priority 5: Scroll if user wants to see more
    // ─────────────────────────────────────────────────────────────
    if (/надолу|повече|още|scroll|more|down/i.test(msg)) {
      return { action: "scroll", reason: "Скролване надолу" };
    }

    // ─────────────────────────────────────────────────────────────
    // Default: Just observe, no action needed
    // ─────────────────────────────────────────────────────────────
    return { action: "none", reason: "Наблюдение - няма конкретно действие" };
  }

  private extractIntentKeywords(message: string): string[] {
    const keywords: string[] = [];
    const lower = message.toLowerCase();

    // Extract quoted text
    const quoted = message.match(/"([^"]+)"/);
    if (quoted) keywords.push(quoted[1].toLowerCase());

    // Common action words
    const actionWords = [
      "резервирай",
      "запази",
      "кликни",
      "натисни",
      "отвори",
      "виж",
      "покажи",
      "избери",
      "book",
      "reserve",
      "click",
      "open",
      "select",
      "view",
      "show",
    ];

    for (const word of actionWords) {
      if (lower.includes(word)) {
        // Extract the word after the action word
        const regex = new RegExp(`${word}\\s+(?:на\\s+)?[""]?([\\wа-яА-Я]+)[""]?`, "i");
        const match = message.match(regex);
        if (match) keywords.push(match[1].toLowerCase());
      }
    }

    // Direct button name mentions
    const buttonMentions = message.match(/бутон[аът]?\s+[""]?([^""]+)[""]?/i);
    if (buttonMentions) keywords.push(buttonMentions[1].toLowerCase());

    return keywords;
  }

  // ─────────────────────────────────────────────────────────────
  // ACTION EXECUTION
  // ─────────────────────────────────────────────────────────────

  private async tryClick(page: Page, target: string): Promise<boolean> {
    const strategies = [
      target,
      `text="${target}"`,
      `text=/${target}/i`,
      `button:has-text("${target}")`,
      `a:has-text("${target}")`,
      `[aria-label*="${target}" i]`,
    ];

    for (const selector of strategies) {
      try {
        await page.click(selector, { timeout: 3000 });
        return true;
      } catch {}
    }

    return false;
  }

  private async tryFill(page: Page, target: string, value: string): Promise<boolean> {
    const strategies = [
      target,
      `#${target}`,
      `[name="${target}"]`,
      `[placeholder*="${target}" i]`,
      `[aria-label*="${target}" i]`,
    ];

    for (const selector of strategies) {
      try {
        await page.fill(selector, value, { timeout: 2000 });
        return true;
      } catch {}
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // RESULT MESSAGE
  // ─────────────────────────────────────────────────────────────

  private buildResultMessage(
    actionTaken: string,
    observation: DOMObservation,
    decision: ActionDecision
  ): string {
    const parts: string[] = [];

    if (actionTaken) {
      parts.push(actionTaken + ".");
    }

    parts.push(`Страница: "${observation.title}".`);

    if (observation.buttons.length > 0) {
      const btnList = observation.buttons
        .slice(0, 6)
        .map((b) => `"${b.text}"`)
        .join(", ");
      parts.push(`Бутони: ${btnList}.`);
    }

    if (observation.inputs.length > 0) {
      const emptyInputs = observation.inputs.filter((i) => !i.value);
      if (emptyInputs.length > 0) {
        const inputList = emptyInputs
          .slice(0, 4)
          .map((i) => i.placeholder || i.name || i.type)
          .join(", ");
        parts.push(`Полета за попълване: ${inputList}.`);
      }
    }

    if (observation.prices.length > 0) {
      parts.push(`Цени: ${observation.prices.slice(0, 4).join(", ")}.`);
    }

    if (observation.modals.length > 0) {
      parts.push("Има отворен диалог/прозорец.");
    }

    return parts.join(" ");
  }

  // ─────────────────────────────────────────────────────────────
  // STATUS & CLEANUP
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
      console.log(`[OPEN] Closed session: ${sessionId}`);
    }
  }

  async shutdown(): Promise<void> {
    console.log("[OPEN] Shutting down...");
    for (const [id, session] of this.sessions) {
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

  // Auth middleware
  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/" || req.path === "/health") {
      return next();
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (token !== WORKER_SECRET) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
    }

    next();
  };

  app.use(authMiddleware);

  // ─────────────────────────────────────────────────────────────
  // ENDPOINTS
  // ─────────────────────────────────────────────────────────────

  // Health check (public)
  app.get("/", (req, res) => {
    res.json({
      status: "ok",
      service: "neo-worker",
      version: "3.0.0",
      mode: "interactive",
    });
  });

  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      ...worker.getStatus(),
    });
  });

  // Main interaction endpoint (protected)
  app.post("/interact", async (req, res) => {
    const request = req.body as InteractRequest;

    if (!request.site_url || !request.user_message || !request.session_id) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: site_url, user_message, session_id",
      });
    }

    console.log(`[OPEN] Interact: session=${request.session_id}`);
    const result = await worker.interact(request);
    res.json(result);
  });

  // Close session endpoint
  app.post("/close", async (req, res) => {
    const { session_id } = req.body;
    if (session_id) {
      await worker.closeSession(session_id);
    }
    res.json({ success: true, message: "Session closed" });
  });

  // Status endpoint
  app.get("/status", (req, res) => {
    res.json(worker.getStatus());
  });

  // ─────────────────────────────────────────────────────────────
  // START SERVER
  // ─────────────────────────────────────────────────────────────

  app.listen(PORT, () => {
    console.log(`\n════════════════════════════════════════════`);
    console.log(`🟢 NEO Interactive Worker v3.0 on port ${PORT}`);
    console.log(`════════════════════════════════════════════`);
    console.log(`Health:   GET  /health`);
    console.log(`Interact: POST /interact`);
    console.log(`════════════════════════════════════════════\n`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[OPEN] Shutting down...");
    await worker.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(console.error);
