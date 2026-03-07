/**
 * NEO WORKER v7.0.0-vision-first
 *
 * Архитектура: Vision-first, LLM-driven, universal.
 *
 * Принцип:
 *   1. Скриншот на страницата
 *   2. Gemini Vision вижда страницата и казва какви действия да се извършат
 *   3. Worker изпълнява действията (клик, въвеждане)
 *   4. Нов скриншот → Gemini описва какво вижда (резултати, цени, грешки)
 *   5. Връща observation с всичко видяно
 *
 * Никакви DOM селектори. Никакви специфични плъгини. Работи с всяко нещо.
 */

import express, { Request, Response } from "express";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const WORKER_SECRET = (process.env.NEO_WORKER_SECRET || "change-me-in-production").trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY = (process.env.NEO_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_PROXY_URL = (process.env.GEMINI_PROXY_URL || "").trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.0-flash").trim();

type JsonObj = Record<string, unknown>;

// ═══════════════════════════════════════════════
// Gemini Vision Client
// ═══════════════════════════════════════════════

async function callGemini(
  messages: Array<{ role: "user" | "model"; parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }>,
  systemInstruction?: string,
  timeoutMs = 30000,
  jsonMode = true
): Promise<string> {
  const body: any = {
    contents: messages,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      ...(jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }

  // Via proxy (preferred — keeps API key on server)
  if (GEMINI_PROXY_URL) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${GEMINI_PROXY_URL.replace(/\/$/, "")}/gemini-vision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${WORKER_SECRET}`,
        },
        body: JSON.stringify({
          model: GEMINI_MODEL,
          messages,
          system_prompt: systemInstruction || "",
          json_mode: jsonMode,
        }),
        signal: ctrl.signal,
      });
      const data = await resp.json();
      return data?.text || data?.content || "";
    } finally {
      clearTimeout(t);
    }
  }

  // Direct API
  if (GEMINI_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await resp.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } finally {
      clearTimeout(t);
    }
  }

  throw new Error("Gemini not configured: set GEMINI_API_KEY or GEMINI_PROXY_URL");
}

function parseJson(raw: string): any {
  if (!raw) return null;
  const s = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch {
    try { return JSON.parse(s.slice(start, end + 1).replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
  }
}

async function screenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "jpeg", quality: 85, fullPage: false });
  return buf.toString("base64");
}

function imgPart(b64: string) {
  return { inline_data: { mime_type: "image/jpeg", data: b64 } };
}

// ═══════════════════════════════════════════════
// Vision Actions — изпълнява действия от LLM
// ═══════════════════════════════════════════════

interface Action {
  type: "click" | "type" | "scroll" | "press" | "wait" | "navigate";
  x?: number;
  y?: number;
  value?: string;
  description?: string;
}

async function executeActions(page: Page, actions: Action[], log: string[]): Promise<void> {
  for (const a of actions) {
    try {
      switch (a.type) {
        case "navigate":
          if (a.value) {
            await page.goto(a.value, { waitUntil: "domcontentloaded", timeout: 20000 });
            await page.waitForTimeout(1500);
            log.push(`[NAV] ${a.value}`);
          }
          break;
        case "click":
          if (a.x !== undefined && a.y !== undefined) {
            await page.mouse.click(a.x, a.y);
            await page.waitForTimeout(300);
            log.push(`[CLICK] (${a.x},${a.y}) ${a.description || ""}`);
          }
          break;
        case "type":
          if (a.value !== undefined) {
            // Triple-click to select all, then type
            if (a.x !== undefined && a.y !== undefined) {
              await page.mouse.click(a.x, a.y, { clickCount: 3 });
              await page.waitForTimeout(100);
            }
            await page.keyboard.type(a.value, { delay: 40 });
            log.push(`[TYPE] "${a.value}" ${a.description || ""}`);
          }
          break;
        case "press":
          if (a.value) {
            await page.keyboard.press(a.value);
            log.push(`[PRESS] ${a.value}`);
          }
          break;
        case "scroll":
          await page.mouse.wheel(0, a.value ? parseInt(a.value) : 300);
          log.push(`[SCROLL] ${a.value || 300}px`);
          break;
        case "wait":
          await page.waitForTimeout(a.value ? parseInt(a.value) : 800);
          log.push(`[WAIT] ${a.value || 800}ms`);
          break;
      }
    } catch (e) {
      log.push(`[FAIL] ${a.type} ${a.description || ""}: ${e}`);
    }
  }
}

// ═══════════════════════════════════════════════
// Session Manager
// ═══════════════════════════════════════════════

interface HotSession {
  page: Page;
  context: BrowserContext;
  sessionId: string;
  lastActivity: number;
  currentUrl: string;
  siteUrl: string;
}

class SessionManager {
  private browser: Browser | null = null;
  private sessions = new Map<string, HotSession>();
  private supabase: SupabaseClient | null = null;
  private isReady = false;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000;
  private readonly MAX_SESSIONS = 30;

  async start() {
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      try { this.supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY); } catch {}
    }
    this.isReady = true;
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
    console.log(`[WORKER] v7.0.0-vision-first ready`);
    console.log(`[WORKER] Gemini: ${GEMINI_PROXY_URL ? "proxy" : GEMINI_API_KEY ? "direct" : "NOT CONFIGURED"}`);
  }

  status() {
    return {
      ready: this.isReady,
      sessions: this.sessions.size,
      gemini: !!(GEMINI_PROXY_URL || GEMINI_API_KEY),
      uptime_sec: Math.floor(process.uptime()),
    };
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > this.SESSION_TIMEOUT) this.closeSession(id);
    }
  }

  async closeSession(siteId: string) {
    const s = this.sessions.get(siteId);
    if (!s) return;
    try { await s.page.close(); } catch {}
    try { await s.context.close(); } catch {}
    this.sessions.delete(siteId);
    console.log(`[SESSION] Closed ${siteId}`);
  }

  async prepare(siteId: string, url: string, sessionId: string): Promise<boolean> {
    if (!this.isReady || !this.browser) return false;
    await this.closeSession(siteId);
    if (this.sessions.size >= this.MAX_SESSIONS) {
      // Evict oldest
      let oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0];
      if (oldest) await this.closeSession(oldest[0]);
    }
    try {
      const context = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        locale: "bg-BG",
        timezoneId: "Europe/Sofia",
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      const fullUrl = url.startsWith("http") ? url : `https://${url}`;
      await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(600);
      this.sessions.set(siteId, { page, context, sessionId, lastActivity: Date.now(), currentUrl: page.url(), siteUrl: fullUrl });
      console.log(`[PREPARE] ✓ ${siteId} → ${page.url()}`);
      return true;
    } catch (e) {
      console.error("[PREPARE] Failed:", e);
      return false;
    }
  }

  async fillForm(siteId: string, sessionId: string, formId: string, fingerprint: string, kind: string, fields: Record<string, unknown>): Promise<JsonObj> {
    const session = this.sessions.get(siteId);
    if (!session) return { success: false, message: "Няма активна сесия" };
    session.lastActivity = Date.now();

    const page = session.page;
    const log: string[] = [];
    const allFieldsText = Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");

    console.log(`[FILL] kind=${kind} fields="${allFieldsText}"`);

    // ── Step 1: Screenshot + ask Gemini what to do ──────────
    const shot1 = await screenshot(page).catch(() => null);
    if (!shot1) return { success: false, message: "Не успях да направя скриншот" };

    const taskPrompt = buildTaskPrompt(kind, fields);

    let planRaw: string;
    try {
      planRaw = await callGemini([
        {
          role: "user",
          parts: [
            imgPart(shot1),
            { text: taskPrompt },
          ],
        },
      ], VISION_SYSTEM, 25000, true);
    } catch (e) {
      return { success: false, message: `Gemini грешка: ${e}` };
    }

    const plan = parseJson(planRaw);
    console.log(`[VISION] plan: found=${plan?.found} actions=${plan?.actions?.length} needs_input=${plan?.needs_input}`);

    if (!plan) {
      return { success: false, message: "Gemini не върна валиден план" };
    }

    // ── needs_input: връщаме required fields ────────────────
    if (plan.needs_input || (Array.isArray(plan.missing_fields) && plan.missing_fields.length > 0)) {
      return {
        success: false,
        needs_input: true,
        missing_required: plan.missing_fields || [],
        message: plan.message || "Нужни са допълнителни данни",
        observation: { url: page.url(), description: plan.page_description || "" },
      };
    }

    if (!plan.found) {
      return {
        success: false,
        message: plan.reason || "Не намерих подходяща форма на страницата",
        observation: { url: page.url(), description: plan.page_description || "" },
      };
    }

    // ── Step 2: Execute actions ─────────────────────────────
    const actions: Action[] = Array.isArray(plan.actions) ? plan.actions : [];
    await executeActions(page, actions, log);

    // Wait for page to settle
    await page.waitForTimeout(1500);
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
    } catch {}
    await page.waitForTimeout(500);

    // ── Step 3: Screenshot result + ask Gemini what it sees ─
    const shot2 = await screenshot(page).catch(() => null);
    let observation: JsonObj = { url: page.url(), actions_log: log };

    if (shot2) {
      try {
        const resultRaw = await callGemini([
          {
            role: "user",
            parts: [
              imgPart(shot2),
              { text: RESULT_PROMPT },
            ],
          },
        ], VISION_SYSTEM, 20000, true);
        const result = parseJson(resultRaw);
        if (result) {
          observation = {
            ...observation,
            ...result,
            url: page.url(),
          };
        }
      } catch (e) {
        log.push(`[RESULT-VISION] error: ${e}`);
      }
    }

    const submitted = Boolean(
      observation.submitted ||
      observation.success ||
      (observation.status && String(observation.status).toLowerCase().includes("success")) ||
      (observation.url && String(observation.url) !== session.siteUrl)
    );

    return {
      success: submitted || actions.length > 0,
      submitted,
      message: String(observation.summary || observation.description || (submitted ? "Готово" : "Изпълнено")),
      observation,
      actions_log: log,
    };
  }

  async loadSiteUrl(sessionId: string, formId?: string, fingerprint?: string): Promise<string | null> {
    if (!this.supabase) return null;
    // Try demo_sessions first
    const { data: ds } = await this.supabase.from("demo_sessions").select("url").eq("id", sessionId).single();
    if (ds?.url) return String(ds.url);
    // Try form_schemas
    let q = this.supabase.from("form_schemas").select("url").eq("session_id", sessionId).limit(1);
    if (formId) q = q.eq("id", formId);
    else if (fingerprint) q = q.eq("fingerprint", fingerprint);
    const { data: fs } = await q.maybeSingle();
    if (fs?.url) return String(fs.url);
    return null;
  }

  getSession(siteId: string) { return this.sessions.get(siteId) || null; }
}

// ═══════════════════════════════════════════════
// Prompts
// ═══════════════════════════════════════════════

const VISION_SYSTEM = `Ти си агент за автоматизация на уеб форми.
Виждаш скриншот на уеб страница (viewport 1366x768px).
Координатите X,Y са в пиксели от горния ляв ъгъл.
ВИНАГИ връщай само валиден JSON без markdown.`;

function buildTaskPrompt(kind: string, fields: Record<string, unknown>): string {
  const fieldsList = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(([k, v]) => `  "${k}": "${v}"`)
    .join("\n");

  const hasFields = fieldsList.length > 0;

  if (kind === "availability" || kind === "booking_widget") {
    return `На тази страница има форма за проверка на наличност/резервация.

${hasFields ? `Данни за попълване:\n${fieldsList}` : "Няма данни — само виж какво има на страницата."}

${hasFields ? `Анализирай страницата и върни JSON план за попълване на формата:` : `Анализирай страницата и върни JSON описание:`}

Ако ВСИЧКИ нужни полета са дадени:
{
  "found": true,
  "page_description": "кратко описание на формата",
  "actions": [
    {"type": "click", "x": 400, "y": 300, "description": "Кликни check-in поле"},
    {"type": "type", "value": "08/03/2026", "description": "Въведи check-in дата"},
    {"type": "click", "x": 600, "y": 300, "description": "Кликни check-out поле"},
    {"type": "type", "value": "10/03/2026", "description": "Въведи check-out дата"},
    {"type": "click", "x": 800, "y": 400, "description": "Кликни Търси/Search"}
  ]
}

Ако липсват задължителни данни (check_in, check_out, adults):
{
  "found": true,
  "needs_input": true,
  "missing_fields": ["check_in", "check_out"],
  "message": "Нужни са дати за настаняване и отпътуване",
  "page_description": "MPHB booking форма"
}

Ако НЕ намериш форма:
{
  "found": false,
  "reason": "защо",
  "page_description": "какво виждаш"
}

ПРАВИЛА:
- check_in и check_out са ЗАДЪЛЖИТЕЛНИ за availability. Ако липсват → needs_input.
- За date picker: кликни полето, после въведи датата в правилния формат (MM/DD/YYYY или каквото виждаш).
- За dropdown/select: кликни за отваряне, после кликни опцията.
- Не добавяй action за полета които не виждаш на страницата.
- Координатите трябва да са ТОЧНО върху елемента.`;
  }

  // Generic form
  return `На тази страница има форма за попълване.

${hasFields ? `Данни за попълване:\n${fieldsList}` : "Виж какво има на страницата."}

Анализирай и върни JSON план:

Ако формата е намерена и данните са достатъчни:
{
  "found": true,
  "page_description": "описание",
  "actions": [
    {"type": "click", "x": 400, "y": 200, "description": "Кликни поле Име"},
    {"type": "type", "value": "Иван Иванов", "description": "Въведи Иван Иванов"},
    {"type": "click", "x": 400, "y": 300, "description": "Кликни поле Имейл"},
    {"type": "type", "value": "ivan@example.com", "description": "Въведи имейл"},
    {"type": "click", "x": 700, "y": 500, "description": "Кликни Submit"}
  ]
}

Ако липсват задължителни полета:
{
  "found": true,
  "needs_input": true,
  "missing_fields": ["Имейл", "Телефон"],
  "message": "Нужни са имейл и телефон",
  "page_description": "контактна форма"
}

Ако не намериш форма:
{
  "found": false,
  "reason": "защо",
  "page_description": "какво виждаш"
}

ПРАВИЛА:
- Попълни САМО полета за които имаш данни.
- Не измисляй стойности.
- Задължителните полета (маркирани с *) трябва да имат стойности преди Submit.`;
}

const RESULT_PROMPT = `Анализирай тази страница след изпълнение на действия.

Върни JSON:
{
  "submitted": true/false,
  "summary": "Кратко описание на резултата (1-2 изречения)",
  "description": "Детайлно описание — какво виждаш",
  "rooms": [
    {"name": "Стандартна стая", "price": "120 лв/нощ", "available": true}
  ],
  "total_price": "240 лв за 2 нощи",
  "needs_payment": true/false,
  "error": null,
  "status": "success/error/results_shown/form_visible"
}

Правила:
- "submitted": true само ако има потвърждение, благодарствена страница, или резултати са показани.
- "rooms": само ако виждаш конкретни стаи/апартаменти с цени.
- "total_price": само ако виждаш обща сума.
- "needs_payment": true ако виждаш форма за плащане или бутон "Плати".
- "error": текстът на грешката ако има такава.
- Ако виждаш форма за плащане → описваш я в "description".`;

// ═══════════════════════════════════════════════
// HTTP Server
// ═══════════════════════════════════════════════

async function main() {
  const manager = new SessionManager();
  const app = express();
  app.use(express.json({ limit: "15mb" }));

  // Auth middleware
  app.use((req, res, next) => {
    if (req.path === "/" || req.path === "/health") return next();
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (token !== WORKER_SECRET) return res.status(401).json({ success: false, error: "Unauthorized" });
    next();
  });

  app.get("/", (_, res) => res.json({ name: "NEO Worker", version: "7.0.0-vision-first" }));
  app.get("/health", (_, res) => res.json({ status: "ok", ...manager.status() }));

  // Prepare session
  app.post("/prepare-session", async (req: Request, res: Response) => {
    const { site_id, site_map, session_id, url } = req.body || {};
    if (!site_id) return res.json({ success: false, error: "Missing site_id" });
    const targetUrl = url || site_map?.url;
    if (!targetUrl) return res.json({ success: false, error: "Missing url" });
    const ok = await manager.prepare(String(site_id), String(targetUrl), String(session_id || site_id));
    res.json({ success: ok, session_ready: ok });
  });

  // Fill form — main endpoint
  app.post("/fill-form", async (req: Request, res: Response) => {
    const { site_id, session_id, form_id, fingerprint, kind, data, confirmed } = req.body || {};
    if (!site_id || !data) return res.json({ success: false, message: "Missing site_id/data" });

    // Merge confirmed into data
    const fields: Record<string, unknown> = { ...(data || {}) };
    if (confirmed && typeof confirmed === "object") {
      for (const [k, v] of Object.entries(confirmed)) fields[k] = v;
    }

    const siteIdStr = String(site_id);
    let session = manager.getSession(siteIdStr);

    // Auto-prepare if no session
    if (!session) {
      console.log(`[FILL] No session for ${siteIdStr}, auto-preparing...`);
      const url = await manager.loadSiteUrl(
        String(session_id || site_id),
        form_id ? String(form_id) : undefined,
        fingerprint ? String(fingerprint) : undefined
      );
      if (!url) return res.json({ success: false, message: "Няма активна сесия и не намерих URL" });
      const ok = await manager.prepare(siteIdStr, url, String(session_id || site_id));
      if (!ok) return res.json({ success: false, message: "Не успях да отворя страницата" });
    }

    const result = await manager.fillForm(
      siteIdStr,
      String(session_id || site_id),
      String(form_id || ""),
      String(fingerprint || ""),
      String(kind || "form"),
      fields
    );

    res.json(result);
  });

  // Close session
  app.post("/close-session", async (req: Request, res: Response) => {
    const { site_id } = req.body || {};
    if (site_id) await manager.closeSession(String(site_id));
    res.json({ success: true });
  });

  app.listen(PORT, () => console.log(`🚀 NEO Worker v7.0.0-vision-first on :${PORT}`));
  await manager.start();

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
