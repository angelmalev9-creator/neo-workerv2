/**
 * NEO WORKER - Единственият файл, който ти трябва
 * 
 * Работи като истински служител:
 * - Браузърът е ВИНАГИ отворен (не губим време да палим/гасим)
 * - WebSocket връзка с NEO (real-time комуникация)
 * - Прости команди: open, click, fill, submit, look
 */

import { chromium, Browser, Page } from "playwright";
import { WebSocketServer, WebSocket } from "ws";
import express from "express";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

type Command = 
  | { action: "open"; url: string }
  | { action: "look" }  // Сканирай какво виждаш
  | { action: "click"; target: string }  // CSS селектор или текст
  | { action: "fill"; target: string; value: string }
  | { action: "submit" }
  | { action: "screenshot" }
  | { action: "close" };

type WorkerResponse = {
  success: boolean;
  message: string;
  data?: {
    url?: string;
    title?: string;
    buttons?: Array<{ text: string; selector: string }>;
    inputs?: Array<{ type: string; name: string; placeholder: string }>;
    screenshot?: string;  // base64
    visibleText?: string;
    [key: string]: any;
  };
  error?: string;
};

// ═══════════════════════════════════════════════════════════════
// WORKER CLASS - Мозъкът
// ═══════════════════════════════════════════════════════════════

class NeoWorker {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isReady = false;

  // 🚀 Стартирай браузъра (веднъж при стартиране на сървъра)
  async start(): Promise<void> {
    console.log("🚀 Starting browser...");
    
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    });
    
    this.page = await context.newPage();
    this.isReady = true;
    
    console.log("✅ Browser ready!");
  }

  // 🎯 Изпълни команда
  async execute(command: Command): Promise<WorkerResponse> {
    if (!this.isReady || !this.page) {
      return { success: false, message: "Worker not ready", error: "Browser not initialized" };
    }

    try {
      switch (command.action) {
        case "open":
          return await this.open(command.url);
        
        case "look":
          return await this.look();
        
        case "click":
          return await this.click(command.target);
        
        case "fill":
          return await this.fill(command.target, command.value);
        
        case "submit":
          return await this.submit();
        
        case "screenshot":
          return await this.screenshot();
        
        case "close":
          return await this.closePage();
        
        default:
          return { success: false, message: "Unknown command", error: `Unknown action` };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("❌ Command failed:", errorMsg);
      return { success: false, message: "Command failed", error: errorMsg };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // КОМАНДИ
  // ═══════════════════════════════════════════════════════════════

  // 🌐 Отвори URL
  private async open(url: string): Promise<WorkerResponse> {
    console.log(`🌐 Opening: ${url}`);
    
    await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await this.page!.waitForTimeout(1000); // Изчакай JS да зареди
    
    const title = await this.page!.title();
    
    return {
      success: true,
      message: `Отворих ${url}`,
      data: { url, title }
    };
  }

  // 👀 Виж какво има на страницата
  private async look(): Promise<WorkerResponse> {
    console.log("👀 Scanning page...");
    
    const result = await this.page!.evaluate(() => {
      // Помощна функция - видим ли е елементът?
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && 
               style.display !== "none" && 
               style.visibility !== "hidden";
      };

      // Намери бутони
      const buttons = Array.from(document.querySelectorAll(
        "button, a, [role='button'], input[type='submit'], input[type='button']"
      ))
        .filter(el => isVisible(el))
        .slice(0, 15)  // Макс 15 бутона
        .map((el, i) => {
          const text = (el.textContent?.trim() || (el as HTMLInputElement).value || "").slice(0, 50);
          // Създай уникален селектор
          let selector = "";
          if (el.id) selector = `#${el.id}`;
          else if (el.className && typeof el.className === "string") {
            selector = `${el.tagName.toLowerCase()}.${el.className.split(" ")[0]}`;
          } else {
            selector = `${el.tagName.toLowerCase()}:nth-of-type(${i + 1})`;
          }
          return { text, selector };
        })
        .filter(b => b.text.length > 0);

      // Намери input полета
      const inputs = Array.from(document.querySelectorAll(
        "input:not([type='hidden']), textarea, select"
      ))
        .filter(el => isVisible(el))
        .slice(0, 10)
        .map(el => {
          const input = el as HTMLInputElement;
          return {
            type: input.type || el.tagName.toLowerCase(),
            name: input.name || input.id || "",
            placeholder: input.placeholder || ""
          };
        });

      // Вземи видимия текст (първите 500 символа)
      const visibleText = document.body.innerText.slice(0, 500);

      // Провери за форми
      const forms = document.querySelectorAll("form").length;

      // Провери за iframe (резервационни системи)
      const iframes = Array.from(document.querySelectorAll("iframe"))
        .map(f => f.src)
        .filter(src => src.length > 0);

      return { buttons, inputs, visibleText, forms, iframes, url: window.location.href };
    });

    // Създай кратко описание за NEO
    let description = `Виждам страница: ${result.url}\n`;
    
    if (result.buttons.length > 0) {
      description += `\n🔘 Бутони: ${result.buttons.map(b => `"${b.text}"`).join(", ")}`;
    }
    
    if (result.inputs.length > 0) {
      description += `\n📝 Полета: ${result.inputs.map(i => i.placeholder || i.name || i.type).join(", ")}`;
    }
    
    if (result.forms > 0) {
      description += `\n📋 Формуляри: ${result.forms}`;
    }
    
    if (result.iframes.length > 0) {
      description += `\n⚠️ Външни системи: ${result.iframes.length}`;
    }

    return {
      success: true,
      message: description,
      data: result
    };
  }

  // 🖱️ Кликни върху елемент
  private async click(target: string): Promise<WorkerResponse> {
    console.log(`🖱️ Clicking: ${target}`);
    
    // Опитай първо като селектор, после като текст
    let clicked = false;
    
    // 1. Опитай CSS селектор
    try {
      const element = await this.page!.$(target);
      if (element) {
        await element.click();
        clicked = true;
      }
    } catch {}
    
    // 2. Опитай да намериш по текст
    if (!clicked) {
      try {
        await this.page!.click(`text="${target}"`, { timeout: 3000 });
        clicked = true;
      } catch {}
    }
    
    // 3. Опитай partial text match
    if (!clicked) {
      try {
        await this.page!.click(`text=/${target}/i`, { timeout: 3000 });
        clicked = true;
      } catch {}
    }

    if (!clicked) {
      return { 
        success: false, 
        message: `Не намерих елемент "${target}"`,
        error: "Element not found"
      };
    }

    // Изчакай страницата да реагира
    await this.page!.waitForTimeout(1000);
    
    // Провери дали URL се е променил
    const newUrl = this.page!.url();
    
    return {
      success: true,
      message: `Кликнах върху "${target}"`,
      data: { url: newUrl }
    };
  }

  // ✏️ Попълни поле
  private async fill(target: string, value: string): Promise<WorkerResponse> {
    console.log(`✏️ Filling: ${target} = ${value}`);
    
    let filled = false;
    
    // Опитай различни селектори
    const selectors = [
      target,
      `input[name="${target}"]`,
      `input[placeholder*="${target}" i]`,
      `input[id="${target}"]`,
      `textarea[name="${target}"]`,
      `[name="${target}"]`
    ];
    
    for (const selector of selectors) {
      try {
        await this.page!.fill(selector, value, { timeout: 2000 });
        filled = true;
        break;
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
      message: `Попълних "${target}" с "${value}"`
    };
  }

  // 📤 Изпрати формата
  private async submit(): Promise<WorkerResponse> {
    console.log("📤 Submitting form...");
    
    // Търси submit бутон
    const submitSelectors = [
      "button[type='submit']",
      "input[type='submit']",
      "button:has-text('Submit')",
      "button:has-text('Изпрати')",
      "button:has-text('Резервирай')",
      "button:has-text('Book')",
      "button:has-text('Reserve')",
      "button:has-text('Запази')",
      "button:has-text('Потвърди')"
    ];
    
    for (const selector of submitSelectors) {
      try {
        await this.page!.click(selector, { timeout: 2000 });
        await this.page!.waitForTimeout(2000);
        
        return {
          success: true,
          message: "Изпратих формата",
          data: { url: this.page!.url() }
        };
      } catch {}
    }

    return {
      success: false,
      message: "Не намерих бутон за изпращане",
      error: "Submit button not found"
    };
  }

  // 📸 Направи screenshot
  private async screenshot(): Promise<WorkerResponse> {
    console.log("📸 Taking screenshot...");
    
    const buffer = await this.page!.screenshot({ type: "jpeg", quality: 50 });
    const base64 = buffer.toString("base64");
    
    return {
      success: true,
      message: "Направих снимка на екрана",
      data: { screenshot: base64 }
    };
  }

  // 🚪 Затвори страницата (но не браузъра)
  private async closePage(): Promise<WorkerResponse> {
    if (this.page) {
      await this.page.goto("about:blank");
    }
    return {
      success: true,
      message: "Затворих страницата"
    };
  }

  // 💀 Спри всичко
  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.isReady = false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// SERVER - WebSocket + HTTP
// ═══════════════════════════════════════════════════════════════

async function main() {
  const PORT = parseInt(process.env.PORT || "3000");
  const worker = new NeoWorker();
  
  // Стартирай браузъра
  await worker.start();
  
  // Express за health checks
  const app = express();
  app.use(express.json());
  
  app.get("/", (req, res) => {
    res.json({ status: "ok", service: "neo-worker", mode: "persistent" });
  });
  
  app.get("/health", (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });
  
  // HTTP endpoint за прости заявки (ако не искаш WebSocket)
  app.post("/command", async (req, res) => {
    const command = req.body as Command;
    const result = await worker.execute(command);
    res.json(result);
  });
  
  const server = app.listen(PORT, () => {
    console.log(`🟢 HTTP server on port ${PORT}`);
  });
  
  // WebSocket за real-time
  const wss = new WebSocketServer({ server });
  
  wss.on("connection", (ws: WebSocket) => {
    console.log("🔌 Client connected");
    
    ws.send(JSON.stringify({ type: "ready", message: "Worker is ready" }));
    
    ws.on("message", async (data: Buffer) => {
      try {
        const command = JSON.parse(data.toString()) as Command;
        console.log("📨 Received:", command.action);
        
        const result = await worker.execute(command);
        
        ws.send(JSON.stringify(result));
      } catch (error) {
        ws.send(JSON.stringify({
          success: false,
          message: "Invalid command",
          error: String(error)
        }));
      }
    });
    
    ws.on("close", () => {
      console.log("🔌 Client disconnected");
    });
  });
  
  console.log(`🟢 WebSocket server on port ${PORT}`);
  
  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("Shutting down...");
    await worker.shutdown();
    process.exit(0);
  });
}

main().catch(console.error);
