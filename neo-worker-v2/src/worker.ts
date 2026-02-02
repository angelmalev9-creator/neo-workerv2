/**
 * NEO WORKER v2 - Persistent Site Connection
 * 
 * Този worker:
 * 1. Държи браузър ВИНАГИ отворен
 * 2. Е свързан към сайта на бизнеса постоянно
 * 3. Отговаря мигновено на заявки
 * 4. Може да попълва форми и прави резервации
 * 
 * ENV VARIABLES (Render):
 * - PORT=3000
 * - NEO_WORKER_SECRET=твоя-тайна-парола
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

interface Command {
  action: "open" | "look" | "click" | "fill" | "submit" | "screenshot" | "close" | "status" | "refresh";
  url?: string;
  target?: string;
  value?: string;
  sessionId?: string;
}

interface WorkerResponse {
  success: boolean;
  message: string;
  data?: {
    url?: string;
    title?: string;
    buttons?: Array<{ text: string; selector: string; type: string }>;
    inputs?: Array<{ type: string; name: string; placeholder: string; selector: string }>;
    links?: Array<{ text: string; href: string }>;
    prices?: string[];
    rooms?: string[];
    slots?: string[];
    forms?: number;
    iframes?: string[];
    visibleText?: string;
    screenshot?: string;
    [key: string]: any;
  };
  error?: string;
  timing?: number;
}

// ═══════════════════════════════════════════════════════════════
// SITE SESSION MANAGER
// ═══════════════════════════════════════════════════════════════

class SiteSession {
  public page: Page;
  public url: string;
  public lastActivity: number;
  public isReady: boolean = false;

  constructor(page: Page, url: string) {
    this.page = page;
    this.url = url;
    this.lastActivity = Date.now();
  }
}

// ═══════════════════════════════════════════════════════════════
// NEO WORKER CLASS
// ═══════════════════════════════════════════════════════════════

class NeoWorker {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private sessions: Map<string, SiteSession> = new Map();
  private defaultSession: SiteSession | null = null;
  private isReady = false;

  // 🚀 Start the browser (once when server starts)
  async start(): Promise<void> {
    console.log("🚀 [Worker] Starting browser...");
    
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process"
      ]
    });
    
    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "bg-BG",
      timezoneId: "Europe/Sofia"
    });
    
    this.isReady = true;
    console.log("✅ [Worker] Browser ready and waiting for commands!");
  }

  // 🎯 Execute a command
  async execute(command: Command): Promise<WorkerResponse> {
    const startTime = Date.now();
    
    if (!this.isReady || !this.browser || !this.context) {
      return { 
        success: false, 
        message: "Worker не е готов", 
        error: "Browser not initialized" 
      };
    }

    try {
      let result: WorkerResponse;
      
      switch (command.action) {
        case "status":
          result = this.getStatus();
          break;
        case "open":
          result = await this.openSite(command.url!, command.sessionId);
          break;
        case "look":
          result = await this.lookAtPage(command.sessionId);
          break;
        case "click":
          result = await this.clickElement(command.target!, command.sessionId);
          break;
        case "fill":
          result = await this.fillInput(command.target!, command.value!, command.sessionId);
          break;
        case "submit":
          result = await this.submitForm(command.sessionId);
          break;
        case "screenshot":
          result = await this.takeScreenshot(command.sessionId);
          break;
        case "refresh":
          result = await this.refreshPage(command.sessionId);
          break;
        case "close":
          result = await this.closeSession(command.sessionId);
          break;
        default:
          result = { success: false, message: "Непозната команда" };
      }
      
      result.timing = Date.now() - startTime;
      return result;
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("❌ [Worker] Command failed:", errorMsg);
      return { 
        success: false, 
        message: "Грешка при изпълнение", 
        error: errorMsg,
        timing: Date.now() - startTime
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // COMMANDS
  // ═══════════════════════════════════════════════════════════════

  private getStatus(): WorkerResponse {
    const sessions = Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      url: s.url,
      lastActivity: new Date(s.lastActivity).toISOString()
    }));

    return {
      success: true,
      message: "Worker работи",
      data: {
        ready: this.isReady,
        activeSessions: this.sessions.size,
        sessions,
        uptime: Math.floor(process.uptime()),
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + " MB"
      }
    };
  }

  private async openSite(url: string, sessionId?: string): Promise<WorkerResponse> {
    // Normalize URL
    if (!url.startsWith("http")) {
      url = "https://" + url;
    }
    
    console.log(`🌐 [Worker] Opening: ${url}`);
    
    // Create new page
    const page = await this.context!.newPage();
    
    try {
      await page.goto(url, { 
        waitUntil: "domcontentloaded", 
        timeout: 25000 
      });
      
      // Wait for JS to load
      await page.waitForTimeout(2000);
      
      const title = await page.title();
      const currentUrl = page.url();
      
      // Create session
      const sid = sessionId || this.generateSessionId();
      const session = new SiteSession(page, currentUrl);
      session.isReady = true;
      
      // Close old session with same ID if exists
      if (this.sessions.has(sid)) {
        const oldSession = this.sessions.get(sid)!;
        await oldSession.page.close().catch(() => {});
      }
      
      this.sessions.set(sid, session);
      this.defaultSession = session;
      
      console.log(`✅ [Worker] Site opened. Session: ${sid}`);
      
      return {
        success: true,
        message: `Отворих ${currentUrl}`,
        data: { 
          url: currentUrl, 
          title,
          sessionId: sid
        }
      };
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  }

  private async lookAtPage(sessionId?: string): Promise<WorkerResponse> {
    const session = this.getSession(sessionId);
    if (!session) {
      return { success: false, message: "Няма отворен сайт", error: "No active session" };
    }
    
    console.log("👀 [Worker] Scanning page...");
    session.lastActivity = Date.now();
    
    const result = await session.page.evaluate(() => {
      // Helper: is element visible?
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && 
               rect.height > 0 && 
               style.display !== "none" && 
               style.visibility !== "hidden" &&
               style.opacity !== "0";
      };

      // Helper: get unique selector
      const getSelector = (el: Element, index: number): string => {
        if (el.id) return `#${el.id}`;
        if (el.className && typeof el.className === "string" && el.className.trim()) {
          const cls = el.className.trim().split(/\s+/)[0];
          if (cls && !cls.includes(":")) return `${el.tagName.toLowerCase()}.${cls}`;
        }
        return `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
      };

      // Find buttons
      const buttons = Array.from(document.querySelectorAll(
        "button, a[href], [role='button'], input[type='submit'], input[type='button'], .btn, [class*='button'], [class*='btn']"
      ))
        .filter(el => isVisible(el))
        .slice(0, 20)
        .map((el, i) => {
          const text = (el.textContent?.trim() || (el as HTMLInputElement).value || "").slice(0, 60);
          return { 
            text, 
            selector: getSelector(el, i),
            type: el.tagName.toLowerCase()
          };
        })
        .filter(b => b.text.length > 0);

      // Find inputs
      const inputs = Array.from(document.querySelectorAll(
        "input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select"
      ))
        .filter(el => isVisible(el))
        .slice(0, 15)
        .map((el, i) => {
          const input = el as HTMLInputElement;
          return {
            type: input.type || el.tagName.toLowerCase(),
            name: input.name || input.id || "",
            placeholder: input.placeholder || input.getAttribute("aria-label") || "",
            selector: getSelector(el, i)
          };
        });

      // Find prices
      const priceRegex = /(\d+[\s,.]?\d*)\s*(лв|BGN|EUR|€|\$|USD)/gi;
      const bodyText = document.body.innerText;
      const prices = [...bodyText.matchAll(priceRegex)]
        .map(m => m[0])
        .slice(0, 10);

      // Find room/slot mentions
      const roomKeywords = /стая|room|апартамент|apartment|студио|studio|люкс|suite|двойна|единична|double|single/gi;
      const rooms = [...bodyText.matchAll(roomKeywords)]
        .map(m => m[0])
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 10);

      // Find time slots
      const slotKeywords = /\d{1,2}:\d{2}|\d{1,2}\s*(ч|h|часа)/gi;
      const slots = [...bodyText.matchAll(slotKeywords)]
        .map(m => m[0])
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 10);

      // Find links
      const links = Array.from(document.querySelectorAll("a[href]"))
        .filter(el => isVisible(el))
        .slice(0, 10)
        .map(el => ({
          text: el.textContent?.trim().slice(0, 40) || "",
          href: (el as HTMLAnchorElement).href
        }))
        .filter(l => l.text.length > 0);

      // Count forms and iframes
      const forms = document.querySelectorAll("form").length;
      const iframes = Array.from(document.querySelectorAll("iframe"))
        .map(f => f.src)
        .filter(src => src.length > 0);

      // Get visible text (first 800 chars)
      const visibleText = bodyText.slice(0, 800).replace(/\s+/g, " ").trim();

      return {
        url: window.location.href,
        title: document.title,
        buttons,
        inputs,
        links,
        prices,
        rooms,
        slots,
        forms,
        iframes,
        visibleText
      };
    });

    // Build human-readable message
    let message = `📍 Страница: ${result.title}\n`;
    
    if (result.buttons.length > 0) {
      const btnTexts = result.buttons.slice(0, 8).map(b => `"${b.text}"`).join(", ");
      message += `\n🔘 Бутони (${result.buttons.length}): ${btnTexts}`;
    }
    
    if (result.inputs.length > 0) {
      const inputNames = result.inputs.map(i => i.placeholder || i.name || i.type).join(", ");
      message += `\n📝 Полета (${result.inputs.length}): ${inputNames}`;
    }
    
    if (result.prices.length > 0) {
      message += `\n💰 Цени: ${result.prices.join(", ")}`;
    }
    
    if (result.rooms.length > 0) {
      message += `\n🏨 Стаи/Настаняване: ${result.rooms.join(", ")}`;
    }
    
    if (result.slots.length > 0) {
      message += `\n🕐 Часове: ${result.slots.join(", ")}`;
    }
    
    if (result.forms > 0) {
      message += `\n📋 Формуляри: ${result.forms}`;
    }
    
    if (result.iframes.length > 0) {
      message += `\n⚠️ Външни системи (iframe): ${result.iframes.length}`;
    }

    return {
      success: true,
      message,
      data: result
    };
  }

  private async clickElement(target: string, sessionId?: string): Promise<WorkerResponse> {
    const session = this.getSession(sessionId);
    if (!session) {
      return { success: false, message: "Няма отворен сайт", error: "No active session" };
    }
    
    console.log(`🖱️ [Worker] Clicking: ${target}`);
    session.lastActivity = Date.now();
    
    const page = session.page;
    let clicked = false;
    let clickedOn = "";

    // Strategy 1: Direct selector
    try {
      const el = await page.$(target);
      if (el) {
        await el.click({ timeout: 3000 });
        clicked = true;
        clickedOn = target;
      }
    } catch {}

    // Strategy 2: Text match (exact)
    if (!clicked) {
      try {
        await page.click(`text="${target}"`, { timeout: 3000 });
        clicked = true;
        clickedOn = `text="${target}"`;
      } catch {}
    }

    // Strategy 3: Text match (contains, case insensitive)
    if (!clicked) {
      try {
        await page.click(`text=/${target}/i`, { timeout: 3000 });
        clicked = true;
        clickedOn = `text=/${target}/i`;
      } catch {}
    }

    // Strategy 4: Button/link containing text
    if (!clicked) {
      try {
        await page.click(`button:has-text("${target}"), a:has-text("${target}")`, { timeout: 3000 });
        clicked = true;
        clickedOn = `button/a containing "${target}"`;
      } catch {}
    }

    if (!clicked) {
      return { 
        success: false, 
        message: `Не намерих елемент "${target}"`,
        error: "Element not found"
      };
    }

    // Wait for page reaction
    await page.waitForTimeout(1500);
    
    // Check if URL changed
    const newUrl = page.url();
    const urlChanged = newUrl !== session.url;
    if (urlChanged) {
      session.url = newUrl;
    }

    return {
      success: true,
      message: `Кликнах на "${target}"${urlChanged ? ` (нова страница: ${newUrl})` : ""}`,
      data: { 
        clicked: clickedOn,
        url: newUrl,
        urlChanged 
      }
    };
  }

  private async fillInput(target: string, value: string, sessionId?: string): Promise<WorkerResponse> {
    const session = this.getSession(sessionId);
    if (!session) {
      return { success: false, message: "Няма отворен сайт", error: "No active session" };
    }
    
    console.log(`✏️ [Worker] Filling: ${target} = "${value}"`);
    session.lastActivity = Date.now();
    
    const page = session.page;
    let filled = false;
    let filledIn = "";

    // Try different selector strategies
    const selectors = [
      target,
      `#${target}`,
      `[name="${target}"]`,
      `[id="${target}"]`,
      `[placeholder*="${target}" i]`,
      `[aria-label*="${target}" i]`,
      `input[type="${target}"]`,
      `textarea[name="${target}"]`
    ];

    for (const selector of selectors) {
      try {
        await page.fill(selector, value, { timeout: 2000 });
        filled = true;
        filledIn = selector;
        break;
      } catch {}
    }

    // Try label-based selection
    if (!filled) {
      try {
        const label = await page.$(`label:has-text("${target}")`);
        if (label) {
          const forId = await label.getAttribute("for");
          if (forId) {
            await page.fill(`#${forId}`, value, { timeout: 2000 });
            filled = true;
            filledIn = `#${forId} (via label)`;
          }
        }
      } catch {}
    }

    if (!filled) {
      return {
        success: false,
        message: `Не намерих поле "${target}"`,
        error: "Input not found"
      };
    }

    return {
      success: true,
      message: `Попълних "${target}" с "${value}"`,
      data: { field: filledIn, value }
    };
  }

  private async submitForm(sessionId?: string): Promise<WorkerResponse> {
    const session = this.getSession(sessionId);
    if (!session) {
      return { success: false, message: "Няма отворен сайт", error: "No active session" };
    }
    
    console.log("📤 [Worker] Submitting form...");
    session.lastActivity = Date.now();
    
    const page = session.page;
    
    // Try different submit strategies
    const submitSelectors = [
      "button[type='submit']",
      "input[type='submit']",
      "form button:last-of-type",
      "button:has-text('Изпрати')",
      "button:has-text('Запази')",
      "button:has-text('Резервирай')",
      "button:has-text('Потвърди')",
      "button:has-text('Submit')",
      "button:has-text('Book')",
      "button:has-text('Reserve')",
      "button:has-text('Send')",
      "[type='submit']",
      ".submit-btn",
      ".btn-submit"
    ];

    for (const selector of submitSelectors) {
      try {
        await page.click(selector, { timeout: 2000 });
        
        // Wait for response
        await page.waitForTimeout(2500);
        
        const newUrl = page.url();
        const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500));
        
        // Check for success indicators
        const successIndicators = [
          /успешн/i, /success/i, /благодар/i, /thank/i,
          /потвърд/i, /confirm/i, /завърш/i, /complete/i,
          /получ/i, /receiv/i, /изпрат/i, /sent/i
        ];
        
        const hasSuccess = successIndicators.some(r => r.test(pageText));

        return {
          success: true,
          message: hasSuccess 
            ? "Формата е изпратена успешно!" 
            : "Натиснах бутона за изпращане",
          data: { 
            url: newUrl,
            possibleSuccess: hasSuccess,
            pagePreview: pageText.slice(0, 200)
          }
        };
      } catch {}
    }

    return {
      success: false,
      message: "Не намерих бутон за изпращане",
      error: "Submit button not found"
    };
  }

  private async takeScreenshot(sessionId?: string): Promise<WorkerResponse> {
    const session = this.getSession(sessionId);
    if (!session) {
      return { success: false, message: "Няма отворен сайт", error: "No active session" };
    }
    
    console.log("📸 [Worker] Taking screenshot...");
    
    const buffer = await session.page.screenshot({ 
      type: "jpeg", 
      quality: 60,
      fullPage: false 
    });
    
    return {
      success: true,
      message: "Направих снимка",
      data: { 
        screenshot: buffer.toString("base64"),
        url: session.page.url()
      }
    };
  }

  private async refreshPage(sessionId?: string): Promise<WorkerResponse> {
    const session = this.getSession(sessionId);
    if (!session) {
      return { success: false, message: "Няма отворен сайт", error: "No active session" };
    }
    
    console.log("🔄 [Worker] Refreshing page...");
    
    await session.page.reload({ waitUntil: "domcontentloaded" });
    await session.page.waitForTimeout(1500);
    session.lastActivity = Date.now();
    
    return {
      success: true,
      message: "Презаредих страницата",
      data: { url: session.page.url() }
    };
  }

  private async closeSession(sessionId?: string): Promise<WorkerResponse> {
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      await session.page.close().catch(() => {});
      this.sessions.delete(sessionId);
      
      if (this.defaultSession === session) {
        this.defaultSession = null;
      }
      
      return { success: true, message: `Затворих сесия ${sessionId}` };
    }
    
    // Close default session
    if (this.defaultSession) {
      await this.defaultSession.page.close().catch(() => {});
      this.defaultSession = null;
      return { success: true, message: "Затворих страницата" };
    }
    
    return { success: true, message: "Няма какво да затворя" };
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  private getSession(sessionId?: string): SiteSession | null {
    if (sessionId && this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }
    return this.defaultSession;
  }

  private generateSessionId(): string {
    return "s_" + Math.random().toString(36).substring(2, 10);
  }

  async shutdown(): Promise<void> {
    console.log("👋 [Worker] Shutting down...");
    
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
  const worker = new NeoWorker();
  await worker.start();

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Auth middleware
  const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");
    
    // Allow health checks without auth
    if (req.path === "/" || req.path === "/health") {
      return next();
    }
    
    if (token !== WORKER_SECRET) {
      return res.status(401).json({ 
        success: false, 
        error: "Unauthorized",
        message: "Невалиден или липсващ токен"
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
      version: "2.0.0",
      mode: "persistent-browser"
    });
  });

  app.get("/health", (req, res) => {
    res.json({ 
      status: "ok", 
      uptime: Math.floor(process.uptime()),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + " MB"
    });
  });

  // Main command endpoint (protected)
  app.post("/command", async (req, res) => {
    const command = req.body as Command;
    
    if (!command.action) {
      return res.status(400).json({
        success: false,
        error: "Missing action",
        message: "Липсва action в заявката"
      });
    }
    
    console.log(`📨 [API] Command: ${command.action}`);
    
    const result = await worker.execute(command);
    res.json(result);
  });

  // Convenience endpoints
  app.post("/open", async (req, res) => {
    const { url, sessionId } = req.body;
    const result = await worker.execute({ action: "open", url, sessionId });
    res.json(result);
  });

  app.post("/look", async (req, res) => {
    const { sessionId } = req.body;
    const result = await worker.execute({ action: "look", sessionId });
    res.json(result);
  });

  app.post("/click", async (req, res) => {
    const { target, sessionId } = req.body;
    const result = await worker.execute({ action: "click", target, sessionId });
    res.json(result);
  });

  app.post("/fill", async (req, res) => {
    const { target, value, sessionId } = req.body;
    const result = await worker.execute({ action: "fill", target, value, sessionId });
    res.json(result);
  });

  app.post("/submit", async (req, res) => {
    const { sessionId } = req.body;
    const result = await worker.execute({ action: "submit", sessionId });
    res.json(result);
  });

  app.get("/status", async (req, res) => {
    const result = await worker.execute({ action: "status" });
    res.json(result);
  });

  // ─────────────────────────────────────────────────────────────
  // START SERVER
  // ─────────────────────────────────────────────────────────────

  app.listen(PORT, () => {
    console.log(`\n════════════════════════════════════════════`);
    console.log(`🟢 NEO Worker running on port ${PORT}`);
    console.log(`════════════════════════════════════════════`);
    console.log(`Health:  GET  /health`);
    console.log(`Command: POST /command`);
    console.log(`════════════════════════════════════════════\n`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n🛑 Shutting down...");
    await worker.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(console.error);
