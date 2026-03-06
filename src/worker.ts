/**
 * NEO WORKER v6.3.0-vision-availability
 *
 * Patch v6.3.0 over v6.2.0-availability:
 * - NEW: VisionFormFiller — screenshot → Gemini Vision → координати → клик
 * - NEW: GeminiVisionClient — директен Gemini API или чрез NEO proxy
 * - NEW: VisionActionCache — кешира успешни action sequences (in-memory, 4ч TTL)
 * - NEW: fillAvailabilityVision() — universal Vision fallback за всяка booking система
 * - IMPROVED: fillAvailability() — 3 стратегии: native → calendar widget → Vision LLM
 * - NEW: /vision-cache-stats endpoint
 *
 * ENV VARS (нови):
 *   GEMINI_PROXY_URL  — URL на Deno proxy (препоръчано, по-сигурно)
 *   GEMINI_API_KEY    — директен Gemini API key (алтернатива)
 *   GEMINI_MODEL      — модел (default: gemini-1.5-flash)
 *
 * v6.2.0 + v6.1.0 features запазени непроменени.
 */

import express, { Request, Response } from "express";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const WORKER_SECRET = (process.env.NEO_WORKER_SECRET || "change-me-in-production").trim();

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY =
  (process.env.NEO_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "").trim();

type JsonObj = Record<string, unknown>;

interface SiteMap {
  site_id: string;
  url: string;
  buttons: any[];
  forms: any[];
  prices: any[];
}

interface FormSchemaField {
  tag: string;
  type: string;
  name: string;
  label: string;
  placeholder: string;
  required: boolean;
  autocomplete: string;
  aria_label?: string;
  aria_describedby?: string;
  selector_candidates: string[];
}

type WizardScannedField = {
  tag: "input" | "textarea" | "select";
  type: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  aria_label: string;
  required: boolean;
  selector: string;
  selector_candidates: string[];
  options?: { value: string; label: string }[];
};

type WizardChoiceButton = {
  text: string;
  selector: string;
};

type WizardChoiceGroup = {
  name: string;
  label: string;
  required: boolean;
  type: "button_group" | "radio" | "select";
  options: WizardChoiceButton[];
};

interface FormSchemaSubmit {
  text: string;
  selector_candidates: string[];
}

interface FormSchemaRow {
  id: string;
  session_id: string;
  url: string;
  domain: string;
  kind: "form" | "wizard" | "booking_widget" | "availability";
  fingerprint: string;
  schema: {
    fields?: FormSchemaField[];
    choices?: Array<{
      name: string;
      label: string;
      required: boolean;
      type: string;
      options: Array<{ value: string; label: string; selector_candidates?: string[] }>;
    }>;
    submit?: FormSchemaSubmit | null;
    action?: string;
    method?: string;
    step_indicators?: string[];
    src?: string;
    vendor?: string;
    calendar_containers?: Array<{
      text_hint?: string;
      selector_candidates?: string[];
    }>;
  };
  dom_snapshot: string | null;
}

interface HotSession {
  page: Page;
  context: BrowserContext;
  siteMap: SiteMap;
  sessionId: string | null;
  formSchemas: FormSchemaRow[];
  lastActivity: number;
  currentUrl: string;
}

interface FillFormRequest {
  site_id: string;
  session_id?: string;
  form_id?: string;
  fingerprint?: string;
  kind?: string;
  data: Record<string, unknown>;
  confirmed?: Record<string, unknown>;
  file?: {
    field_name: string;
    base64: string;
    filename: string;
    mime_type: string;
  };
  auto_submit?: boolean;
  strict_select?: boolean;
}

interface ExecuteRequest {
  site_id: string;
  session_id?: string;
  keywords: string[];
  data?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════
// VISION LLM — Types
// ═══════════════════════════════════════════════════════════

interface VisionAction {
  type: "click" | "type" | "press_key" | "scroll" | "wait" | "double_click";
  x?: number;
  y?: number;
  value?: string;
  description?: string;
  wait_after_ms?: number;
}

interface VisionResult {
  ok: boolean;
  actions_executed: number;
  actions_failed: number;
  log: string[];
  cached: boolean;
}

interface AvailabilityTask {
  check_in?: string;
  check_out?: string;
  adults?: string;
  rooms?: string;
}

// ═══════════════════════════════════════════════════════════
// VISION LLM — In-memory cache
// ═══════════════════════════════════════════════════════════

interface VisionCacheEntry {
  actions: VisionAction[];
  hits: number;
  last_used: number;
  created: number;
}

class VisionActionCache {
  private cache = new Map<string, VisionCacheEntry>();
  private readonly MAX_ENTRIES = 200;
  private readonly TTL_MS = 4 * 60 * 60 * 1000;

  private makeKey(pageUrl: string, taskType: string): string {
    try {
      const hostname = new URL(pageUrl).hostname;
      return `${hostname}::${taskType}`;
    } catch {
      return `unknown::${taskType}`;
    }
  }

  get(pageUrl: string, taskType: string): VisionAction[] | null {
    const key = this.makeKey(pageUrl, taskType);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.created > this.TTL_MS) { this.cache.delete(key); return null; }
    entry.hits++;
    entry.last_used = Date.now();
    return entry.actions;
  }

  set(pageUrl: string, taskType: string, actions: VisionAction[]): void {
    if (this.cache.size >= this.MAX_ENTRIES) {
      let oldestKey = "";
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.last_used < oldestTime) { oldestTime = v.last_used; oldestKey = k; }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    const key = this.makeKey(pageUrl, taskType);
    this.cache.set(key, { actions, hits: 0, last_used: Date.now(), created: Date.now() });
  }

  invalidate(pageUrl: string, taskType: string): void {
    this.cache.delete(this.makeKey(pageUrl, taskType));
  }

  stats() {
    return {
      size: this.cache.size,
      entries: [...this.cache.entries()].map(([k, v]) => ({
        key: k, hits: v.hits, age_min: Math.round((Date.now() - v.created) / 60000)
      }))
    };
  }
}

// ═══════════════════════════════════════════════════════════
// VISION LLM — Gemini client (direct API or via proxy)
// ═══════════════════════════════════════════════════════════

class GeminiVisionClient {
  private apiKey: string;
  private proxyUrl: string;
  private proxySecret: string;
  private model: string;

  constructor() {
    this.apiKey = (process.env.GEMINI_API_KEY || "").trim();
    this.proxyUrl = (process.env.GEMINI_PROXY_URL || "").trim();
    this.proxySecret = (process.env.NEO_WORKER_SECRET || "change-me-in-production").trim();
    this.model = (process.env.GEMINI_MODEL || "gemini-1.5-flash").trim();
  }

  isConfigured(): boolean {
    return !!(this.apiKey || this.proxyUrl);
  }

  async analyzeForm(
    screenshotBase64: string,
    systemPrompt: string,
    userPrompt: string,
    timeoutMs = 20000
  ): Promise<string> {
    if (this.proxyUrl) return this.callViaProxy(screenshotBase64, systemPrompt, userPrompt, timeoutMs);
    if (this.apiKey)   return this.callDirectApi(screenshotBase64, systemPrompt, userPrompt, timeoutMs);
    throw new Error("Gemini not configured: set GEMINI_API_KEY or GEMINI_PROXY_URL");
  }

  private async callDirectApi(b64: string, sys: string, user: string, ms: number): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const body = {
      system_instruction: { parts: [{ text: sys }] },
      contents: [{
        role: "user",
        parts: [
          { inline_data: { mime_type: "image/png", data: b64 } },
          { text: user }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: "application/json" }
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
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

  private async callViaProxy(b64: string, sys: string, user: string, ms: number): Promise<string> {
    const url = `${this.proxyUrl.replace(/\/$/, "")}/gemini-vision`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.proxySecret}`,
        },
        body: JSON.stringify({ model: this.model, screenshot_base64: b64, system_prompt: sys, user_prompt: user }),
        signal: ctrl.signal,
      });
      const data = await resp.json();
      return data?.text || data?.content || "";
    } finally {
      clearTimeout(t);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// VISION LLM — Prompts
// ═══════════════════════════════════════════════════════════

const VISION_SYSTEM_PROMPT = `Ти си робот за автоматизация на уеб форми.
Анализираш screenshots на уеб страница и определяш точни координати за кликове и действия.
ЗАДЪЛЖИТЕЛНО връщай само валиден JSON, без markdown блокове, без обяснения.
Viewport е 1366x768 пиксела. Координатите X и Y са в пиксели спрямо горния ляв ъгъл.`;

function buildAvailabilityPrompt(task: AvailabilityTask): string {
  const lines: string[] = [
    "На тази страница има форма за проверка на наличност (booking/reservation).",
    "Трябва да попълниш следните данни:",
  ];
  if (task.check_in)  lines.push(`- Дата на настаняване (check-in): ${task.check_in}`);
  if (task.check_out) lines.push(`- Дата на отпътуване (check-out): ${task.check_out}`);
  if (task.adults)    lines.push(`- Брой възрастни гости: ${task.adults}`);
  if (task.rooms)     lines.push(`- Брой стаи: ${task.rooms}`);
  lines.push(`
Анализирай screenshot-а и върни JSON в точно този формат:
{
  "found_form": true,
  "confidence": 0.9,
  "description": "Кратко описание на намерената форма",
  "actions": [
    {"type": "click", "x": 450, "y": 200, "description": "Отвори check-in поле"},
    {"type": "type", "x": 450, "y": 200, "value": "${task.check_in || ''}", "description": "Въведи check-in дата"},
    {"type": "click", "x": 600, "y": 200, "description": "Отвори check-out поле"},
    {"type": "type", "x": 600, "y": 200, "value": "${task.check_out || ''}", "description": "Въведи check-out дата"},
    {"type": "click", "x": 800, "y": 350, "description": "Кликни Search/Търсене"}
  ]
}

ПРАВИЛА:
1. Координатите са ТОЧНО върху видимия елемент
2. За calendar widgets: click за отваряне, после click на деня
3. За dropdown: click за отваряне, click на опцията
4. Ако не намериш формата — {"found_form": false, "actions": []}
5. САМО JSON — без markdown, без \`\`\``);
  return lines.join("\n");
}

function parseGeminiJson(raw: string): any {
  if (!raw) return null;
  let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  s = s.slice(start, end + 1);
  try { return JSON.parse(s); } catch {
    try { return JSON.parse(s.replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
  }
}

// ═══════════════════════════════════════════════════════════
// VISION LLM — VisionFormFiller
// ═══════════════════════════════════════════════════════════

class VisionFormFiller {
  private gemini = new GeminiVisionClient();
  private cache = new VisionActionCache();

  isEnabled(): boolean { return this.gemini.isConfigured(); }
  getCacheStats() { return this.cache.stats(); }

  async fillAvailabilityVision(
    page: Page,
    task: AvailabilityTask,
    options: { useCache?: boolean; forceRefresh?: boolean } = {}
  ): Promise<VisionResult> {
    const { useCache = true, forceRefresh = false } = options;
    const log: string[] = [];
    const pageUrl = page.url();
    log.push(`[VISION] start url=${pageUrl} task=${JSON.stringify(task)}`);

    if (!this.isEnabled()) {
      return { ok: false, actions_executed: 0, actions_failed: 0, log: [...log, "[VISION] Not configured"], cached: false };
    }

    if (useCache && !forceRefresh) {
      const cached = this.cache.get(pageUrl, "availability");
      if (cached && cached.length > 0) {
        log.push(`[VISION] Cache HIT (${cached.length} actions)`);
        const injected = this.injectTaskValues(cached, task);
        const result = await this.executeActions(page, injected, log);
        result.cached = true;
        return result;
      }
    }

    log.push("[VISION] Taking screenshot...");
    let b64: string;
    try {
      const buf = await page.screenshot({ type: "png", fullPage: false });
      b64 = buf.toString("base64");
      log.push(`[VISION] Screenshot OK ${Math.round(b64.length / 1024)}KB`);
    } catch (e) {
      log.push(`[VISION] Screenshot FAILED: ${e}`);
      return { ok: false, actions_executed: 0, actions_failed: 0, log, cached: false };
    }

    log.push("[VISION] Calling Gemini...");
    let raw: string;
    try {
      raw = await this.gemini.analyzeForm(b64, VISION_SYSTEM_PROMPT, buildAvailabilityPrompt(task), 20000);
      log.push(`[VISION] Gemini OK len=${raw.length}`);
    } catch (e) {
      log.push(`[VISION] Gemini FAILED: ${e}`);
      return { ok: false, actions_executed: 0, actions_failed: 0, log, cached: false };
    }

    const parsed = parseGeminiJson(raw);
    if (!parsed) {
      log.push(`[VISION] JSON parse FAILED. Raw: ${raw.slice(0, 300)}`);
      return { ok: false, actions_executed: 0, actions_failed: 0, log, cached: false };
    }
    log.push(`[VISION] found_form=${parsed.found_form} confidence=${parsed.confidence} desc="${parsed.description}"`);

    if (!parsed.found_form || !Array.isArray(parsed.actions) || !parsed.actions.length) {
      log.push("[VISION] No form found or no actions");
      return { ok: false, actions_executed: 0, actions_failed: 0, log, cached: false };
    }

    const result = await this.executeActions(page, parsed.actions, log);

    if (result.ok && useCache) {
      this.cache.set(pageUrl, "availability", this.makeTemplate(parsed.actions));
      log.push("[VISION] Cached for future use");
    }
    return result;
  }

  async executeActions(page: Page, actions: VisionAction[], log: string[]): Promise<VisionResult> {
    let executed = 0, failed = 0;
    for (const action of actions) {
      try {
        await this.execOne(page, action, log);
        executed++;
      } catch (e) {
        log.push(`[VISION][FAIL] type=${action.type} desc="${action.description}" err=${e}`);
        failed++;
      }
      await page.waitForTimeout(action.wait_after_ms || 200).catch(() => {});
    }
    const ok = executed > 0 && failed < executed;
    log.push(`[VISION] done executed=${executed} failed=${failed} ok=${ok}`);
    return { ok, actions_executed: executed, actions_failed: failed, log, cached: false };
  }

  private async execOne(page: Page, a: VisionAction, log: string[]): Promise<void> {
    switch (a.type) {
      case "click":
        if (a.x === undefined || a.y === undefined) throw new Error("Missing x/y");
        await page.mouse.click(a.x, a.y);
        log.push(`[VISION][click] (${a.x},${a.y}) ${a.description || ""}`);
        break;
      case "double_click":
        if (a.x === undefined || a.y === undefined) throw new Error("Missing x/y");
        await page.mouse.dblclick(a.x, a.y);
        log.push(`[VISION][dblclick] (${a.x},${a.y}) ${a.description || ""}`);
        break;
      case "type":
        if (!a.value) throw new Error("Missing value");
        if (a.x !== undefined && a.y !== undefined) {
          await page.mouse.click(a.x, a.y);
          await page.waitForTimeout(100).catch(() => {});
        }
        await page.keyboard.press("Control+a");
        await page.keyboard.type(a.value, { delay: 30 });
        log.push(`[VISION][type] "${a.value}" at (${a.x},${a.y}) ${a.description || ""}`);
        break;
      case "press_key":
        if (!a.value) throw new Error("Missing value");
        await page.keyboard.press(a.value);
        log.push(`[VISION][key] "${a.value}" ${a.description || ""}`);
        break;
      case "scroll":
        await page.mouse.move(a.x ?? 683, a.y ?? 384);
        await page.mouse.wheel(0, a.value ? parseInt(a.value, 10) : 300);
        log.push(`[VISION][scroll] ${a.description || ""}`);
        break;
      case "wait":
        await page.waitForTimeout(a.value ? parseInt(a.value, 10) : 500);
        log.push(`[VISION][wait] ${a.value || 500}ms`);
        break;
    }
  }

  async clickDateOnOpenCalendar(page: Page, dateStr: string, log: string[]): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const buf = await page.screenshot({ type: "png", fullPage: false }).catch(() => null);
    if (!buf) return false;
    const prompt = `Calendar widget е отворен. Намери и кликни деня "${dateStr}".
Върни САМО JSON: {"found": true, "x": 450, "y": 320, "description": "Ден ${dateStr}"}
Или: {"found": false}`;
    try {
      const raw = await this.gemini.analyzeForm(buf.toString("base64"), VISION_SYSTEM_PROMPT, prompt, 10000);
      const p = parseGeminiJson(raw);
      if (p?.found && p.x && p.y) {
        await page.mouse.click(p.x, p.y);
        log.push(`[VISION] Clicked date "${dateStr}" at (${p.x},${p.y})`);
        return true;
      }
    } catch (e) { log.push(`[VISION] clickDate error: ${e}`); }
    return false;
  }

  private makeTemplate(actions: VisionAction[]): VisionAction[] {
    return actions.map(a => {
      if (a.type !== "type" || !a.value) return { ...a };
      if (/^\d{4}-\d{2}-\d{2}$/.test(a.value) || /^\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}$/.test(a.value))
        return { ...a, value: "TEMPLATE:date:" + a.value };
      if (/^\d{1,2}$/.test(a.value))
        return { ...a, value: "TEMPLATE:number:" + a.value };
      return { ...a };
    });
  }

  private injectTaskValues(actions: VisionAction[], task: AvailabilityTask): VisionAction[] {
    const dates = [task.check_in, task.check_out].filter(Boolean) as string[];
    let dateIdx = 0;
    return actions.map(a => {
      if (a.type !== "type" || !a.value) return { ...a };
      if (a.value.startsWith("TEMPLATE:date:"))
        return { ...a, value: dates[dateIdx++] || a.value.replace("TEMPLATE:date:", "") };
      if (a.value.startsWith("TEMPLATE:number:"))
        return { ...a, value: task.adults || a.value.replace("TEMPLATE:number:", "") };
      return { ...a };
    });
  }
}

// ───────────────────────────────────────────────────────────────
// Logging helpers (PII-safe)
// ───────────────────────────────────────────────────────────────

function safeKeys(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj as Record<string, unknown>);
}
function maskEmail(e: string): string {
  const s = (e || "").trim(); const at = s.indexOf("@");
  if (at <= 1) return "***";
  return `${s.slice(0, 1)}***${at >= 0 ? s.slice(at) : ""}`;
}
function maskPhone(p: string): string {
  const s = (p || "").replace(/[^\d+]/g, "");
  if (s.length <= 4) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}
function summarizeValue(key: string, v: unknown): string {
  const s = String(v ?? ""); const k = key.toLowerCase();
  if (k.includes("email")) return maskEmail(s);
  if (k.includes("phone") || k.includes("tel")) return maskPhone(s);
  if (k.includes("message") || k.includes("note") || k.includes("comment")) return `len=${s.length}`;
  if (s.length > 24) return `len=${s.length}`;
  return s;
}

function createSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try { return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY); } catch { return null; }
}

// ───────────────────────────────────────────────────────────────
// Normalization + confirmed merge
// ───────────────────────────────────────────────────────────────

function normalizeEmail(input: unknown): string {
  const raw = (typeof input === "string" ? input : "").trim().toLowerCase();
  if (!raw) return "";
  let s = raw.replace(/\s+/g, "");
  s = s.replace(/\(at\)|\[at\]/g, "@").replace(/\(dot\)|\[dot\]/g, ".");
  s = s.replace(/( at | at)/g, "@").replace(/( dot | dot)/g, ".");
  s = s.replace(/,/g, ".").replace(/[;:]+$/g, "");
  const parts = s.split("@");
  if (parts.length > 2) s = parts[0] + "@" + parts.slice(1).join("");
  return s;
}
function normalizePhone(input: unknown): string {
  let s = (typeof input === "string" ? input : "").trim();
  if (!s) return "";
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  return s;
}
function mergeConfirmedData(data: Record<string, unknown>, confirmed?: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(data || {}) };
  if (confirmed && typeof confirmed === "object") {
    for (const [k, v] of Object.entries(confirmed)) merged[k] = v;
  }
  if ((merged as any).email) (merged as any).email = normalizeEmail((merged as any).email);
  if ((merged as any).phone) (merged as any).phone = normalizePhone((merged as any).phone);
  if (!(merged as any).email && (merged as any).e_mail) (merged as any).email = normalizeEmail((merged as any).e_mail);
  if (!(merged as any).phone && (merged as any).telephone) (merged as any).phone = normalizePhone((merged as any).telephone);
  return merged;
}

// ───────────────────────────────────────────────────────────────
// Generic field semantics
// ───────────────────────────────────────────────────────────────

function fieldText(f: FormSchemaField): string {
  return `${f.name || ""} ${f.label || ""} ${f.placeholder || ""} ${f.autocomplete || ""} ${f.aria_label || ""}`.toLowerCase();
}
function isEmailField(f: FormSchemaField): boolean {
  const t = fieldText(f);
  return f.type === "email" || /e-?mail|email|имейл|поща/.test(t);
}
function isPhoneField(f: FormSchemaField): boolean {
  const t = fieldText(f);
  return f.type === "tel" || /phone|tel|телефон|мобил|gsm/.test(t);
}
function isNameField(f: FormSchemaField): boolean {
  const t = fieldText(f);
  return /name|име|first|last|fullname|фамил/.test(t);
}
function isMessageField(f: FormSchemaField): boolean {
  const t = fieldText(f);
  return f.tag === "textarea" || /message|съобщ|забел|note|comment|описание/.test(t);
}

// ───────────────────────────────────────────────────────────────
// Wizard label normalization
// ───────────────────────────────────────────────────────────────

function normLabel(s: unknown): string {
  return String(s ?? "").toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/\*/g, " ").replace(/["""']/g, " ")
    .replace(/[(){}\[\]:;,.!?/\\|<>+=_-]/g, " ").replace(/\s+/g, " ").trim();
}
function labelSoftIncludes(a: string, b: string): boolean {
  const A = normLabel(a), B = normLabel(b);
  if (!A || !B) return false;
  return A.includes(B) || B.includes(A);
}

// ───────────────────────────────────────────────────────────────
// Select normalization + matching
// ───────────────────────────────────────────────────────────────

function normSelectText(s: unknown): string {
  return String(s ?? "").toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[₀-₉]/g, "")
    .replace(/[(){}\[\]:;,.!?/\\|<>+=_-]/g, " ").replace(/\s+/g, " ").trim();
}
function pickPlanIntent(desiredRaw: string): "essential" | "advanced" | "ultimate" | "" {
  const d = normSelectText(desiredRaw);
  if (/^\d+$/.test(d)) { if (d === "1") return "essential"; if (d === "2") return "advanced"; if (d === "3") return "ultimate"; }
  if (d.includes("advanced") || d.includes("standart") || d.includes("стандарт")) return "advanced";
  if (d.includes("ultimate") || d.includes("premium") || d.includes("премиум")) return "ultimate";
  if (d.includes("essential") || d.includes("basic") || d.includes("start") || d.includes("старт")) return "essential";
  if (d.includes("втори") || d.includes("2")) return "advanced";
  if (d.includes("първи") || d.includes("1")) return "essential";
  if (d.includes("трети") || d.includes("3")) return "ultimate";
  return "";
}
function planOptionScore(opt: { value: string; label: string }, intent: string): number {
  const v = normSelectText(opt.value), l = normSelectText(opt.label), hay = `${v} ${l}`;
  if (!intent) return 0;
  if (intent === "essential") { if (hay.includes("startov") || hay.includes("стартов")) return 100; if (hay.includes("standarten") || hay.includes("стандарт")) return 40; if (hay.includes("premium") || hay.includes("премиум")) return 20; }
  if (intent === "advanced")  { if (hay.includes("standarten") || hay.includes("стандарт")) return 100; if (hay.includes("startov") || hay.includes("стартов")) return 40; if (hay.includes("premium") || hay.includes("премиум")) return 60; }
  if (intent === "ultimate")  { if (hay.includes("premium") || hay.includes("премиум") || hay.includes("индивидуал")) return 100; if (hay.includes("standarten") || hay.includes("стандарт")) return 60; if (hay.includes("startov") || hay.includes("стартов")) return 40; }
  return 0;
}

// ───────────────────────────────────────────────────────────────
// HotSessionManager
// ───────────────────────────────────────────────────────────────

class HotSessionManager {
  private browser: Browser | null = null;
  private supabase: SupabaseClient | null = null;
  private sessions: Map<string, HotSession> = new Map();
  private isReady = false;
  private visionFiller = new VisionFormFiller();

  private readonly MAX_SESSIONS = 50;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000;
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000;

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    this.supabase = createSupabase();
    this.isReady = true;
    setInterval(() => this.cleanupSessions(), this.CLEANUP_INTERVAL);
    console.log("[WORKER] ✓ Ready");
    console.log(`[WORKER] DB: ${this.supabase ? "connected" : "not configured"}`);
    console.log(`[WORKER] Vision LLM: ${this.visionFiller.isEnabled() ? "enabled" : "disabled (set GEMINI_API_KEY or GEMINI_PROXY_URL)"}`);
  }

  getStatus() {
    const sessionDetails: Record<string, { url: string; schemas: number; age_sec: number }> = {};
    for (const [id, s] of this.sessions) {
      sessionDetails[id] = { url: s.currentUrl, schemas: s.formSchemas.length, age_sec: Math.round((Date.now() - s.lastActivity) / 1000) };
    }
    return {
      ready: this.isReady, db: !!this.supabase,
      sessions: this.sessions.size, maxSessions: this.MAX_SESSIONS,
      sessionDetails, uptime_sec: Math.floor(process.uptime()),
      vision_enabled: this.visionFiller.isEnabled(),
      vision_cache: this.visionFiller.getCacheStats(),
    };
  }

  private evictOldestSession(): void {
    let oldest: { id: string; t: number } | null = null;
    for (const [id, s] of this.sessions) {
      if (!oldest || s.lastActivity < oldest.t) oldest = { id, t: s.lastActivity };
    }
    if (oldest) void this.closeSession(oldest.id);
  }

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > this.SESSION_TIMEOUT) void this.closeSession(id);
    }
  }

  async closeSession(siteId: string): Promise<void> {
    const s = this.sessions.get(siteId);
    if (!s) return;
    try { await s.page.close(); } catch {}
    try { await s.context.close(); } catch {}
    this.sessions.delete(siteId);
    console.log(`[SESSION] Closed ${siteId}`);
  }

  private async loadFormSchemas(sessionId: string): Promise<FormSchemaRow[]> {
    if (!this.supabase || !sessionId) return [];
    try {
      const { data, error } = await this.supabase.from("form_schemas").select("*").eq("session_id", sessionId).limit(50);
      if (error) { console.error("[DB] form_schemas error:", error.message); return []; }
      const rows = (data || []) as FormSchemaRow[];
      console.log(`[DB] Loaded ${rows.length} form_schemas for session ${sessionId.slice(0, 8)}…`);
      return rows;
    } catch (e) { console.error("[DB] loadFormSchemas exception:", e); return []; }
  }

  async prepareSession(siteId: string, siteMap: SiteMap, sessionId?: string): Promise<boolean> {
    if (!this.isReady || !this.browser) return false;
    const start = Date.now();
    console.log(`[PREPARE] Site: ${siteId}`);
    console.log(`[PREPARE] URL: ${siteMap.url}`);
    console.log(`[PREPARE] Buttons: ${siteMap.buttons?.length || 0}, Forms: ${siteMap.forms?.length || 0}, Prices: ${siteMap.prices?.length || 0}`);
    try {
      await this.closeSession(siteId);
      if (this.sessions.size >= this.MAX_SESSIONS) this.evictOldestSession();
      const context = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        locale: "bg-BG", timezoneId: "Europe/Sofia", ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      let url = siteMap.url;
      if (url && !url.startsWith("http")) url = "https://" + url;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(400);
      if (url.includes("#") || url.includes("spa/") || url.includes("/app/")) {
        await page.waitForFunction(() => document.body && document.body.innerText.replace(/\s/g, "").length > 100, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(600);
      }
      const dbSessionId = sessionId || siteId;
      const schemas = await this.loadFormSchemas(dbSessionId);
      this.sessions.set(siteId, { page, context, siteMap, sessionId: dbSessionId, formSchemas: schemas, lastActivity: Date.now(), currentUrl: page.url() });
      console.log(`[PREPARE] ✓ Session ready in ${Date.now() - start}ms (${schemas.length} form schemas)`);
      return true;
    } catch (e) { console.error("[PREPARE] Failed:", e); return false; }
  }

  async refreshFormSchemas(siteId: string): Promise<FormSchemaRow[]> {
    const s = this.sessions.get(siteId);
    if (!s) return [];
    const schemas = await this.loadFormSchemas(s.sessionId || siteId);
    s.formSchemas = schemas;
    return schemas;
  }

  // ─────────────────────────────────────────────────────────
  // /fill-form
  // ─────────────────────────────────────────────────────────

  async executeFillForm(request: FillFormRequest): Promise<{ success: boolean; message: string; observation?: JsonObj }> {
    try {
      const { site_id, session_id, form_id, fingerprint, kind, data, confirmed, file } = request;
      const autoSubmit = request.auto_submit !== false;
      const strictSelect = request.strict_select === true;
      const session = this.sessions.get(site_id);
      if (!session) return { success: false, message: "Няма активна сесия" };
      session.lastActivity = Date.now();
      if (session.formSchemas.length === 0 && (session_id || session.sessionId)) {
        session.formSchemas = await this.loadFormSchemas(session_id || session.sessionId || site_id);
      }
      let schema: FormSchemaRow | undefined;
      if (form_id) schema = session.formSchemas.find(s => s.id === form_id);
      if (!schema && fingerprint) schema = session.formSchemas.find(s => s.fingerprint === fingerprint);
      if (!schema && kind) schema = session.formSchemas.find(s => s.kind === kind);
      if (!schema) schema = session.formSchemas.find(s => s.kind === "availability");
      if (!schema) schema = session.formSchemas.find(s => s.kind === "form" || s.kind === "wizard");
      if (!schema) {
        console.log(`[FILL-FORM][NO_SCHEMA] form_id=${form_id || ""} schemas=${session.formSchemas.length}`);
        return { success: false, message: `Не намерих форма (schemas=${session.formSchemas.length})` };
      }
      console.log(`[FILL-FORM] kind=${schema.kind} form_id=${schema.id} fingerprint=${schema.fingerprint.slice(0, 12)}… fields=${schema.schema.fields?.length || 0}`);
      const merged = mergeConfirmedData(data || {}, confirmed as any);
      const mergedKeys = Object.keys(merged);
      console.log(`[FILL-FORM][PAYLOAD] keys=${mergedKeys.join(",")} preview=${mergedKeys.slice(0, 12).map(k => `${k}=${summarizeValue(k, (merged as any)[k])}`).join(" | ")}`);
      await this.ensureOnSchemaUrl(session.page, schema.url);
      let result: { ok: boolean; message: string; observation?: JsonObj };
      if (schema.kind === "availability") {
        result = await this.fillAvailability(session.page, schema, merged, autoSubmit);
      } else if (schema.kind === "wizard") {
        result = await this.fillWizard(session.page, schema, merged, autoSubmit, strictSelect);
      } else {
        result = await this.fillFormSchema(session.page, schema, merged, file, autoSubmit, strictSelect);
      }
      return { success: !!result.ok, message: result.message, observation: result.observation };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[FILL-FORM][CRASH] ${msg}`, e);
      return { success: false, message: `Fill-form error: ${msg}` };
    }
  }

  async execute(req: ExecuteRequest): Promise<{ success: boolean; message: string; observation?: JsonObj; form_schemas?: FormSchemaRow[] }> {
    const { site_id, session_id, data } = req;
    const session = this.sessions.get(site_id);
    if (!session) return { success: false, message: "Няма активна сесия. Моля, изчакайте зареждане." };
    session.lastActivity = Date.now();
    if (session_id && session.sessionId !== session_id && session.formSchemas.length === 0) {
      session.sessionId = session_id;
      session.formSchemas = await this.loadFormSchemas(session_id);
    }
    if (data && Object.keys(data).length > 0 && session.formSchemas.length > 0) {
      const best = session.formSchemas.find(s => s.kind === "form" || s.kind === "wizard");
      if (best) {
        await this.ensureOnSchemaUrl(session.page, best.url);
        const r = await this.fillFormSchema(session.page, best, data, undefined, true, false);
        return { success: !!r.ok, message: r.message, observation: r.observation };
      }
    }
    if (session.formSchemas.length > 0) {
      return { success: true, message: `Налични форми: ${session.formSchemas.length}`, form_schemas: session.formSchemas };
    }
    const obs = await this.quickObserve(session.page);
    return { success: true, message: `Страница: "${String(obs.title || "")}"`, observation: obs };
  }

  private async ensureOnSchemaUrl(page: Page, schemaUrl?: string) {
    if (!schemaUrl) return;
    try {
      const cur = new URL(page.url()), target = new URL(schemaUrl);
      const isSpa = schemaUrl.includes("#") || schemaUrl.includes("spa/");
      if (isSpa) { if (cur.href === target.href) return; }
      else { if (cur.pathname === target.pathname) return; }
    } catch {}
    try {
      console.log(`[NAV] goto ${schemaUrl}`);
      await page.goto(schemaUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(300);
      if (schemaUrl.includes("#") || schemaUrl.includes("spa/")) {
        await page.waitForFunction(() => document.body && document.body.innerText.replace(/\s/g, "").length > 100, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(600);
      }
    } catch (e) { console.log("[NAV] goto failed:", e); }
  }

  // ═══════════════════════════════════════════════════════════
  // AVAILABILITY FILLING — 3 стратегии
  // ═══════════════════════════════════════════════════════════

  private parseAvailabilityDate(raw: string): { year: number; month: number; day: number } | null {
    if (!raw) return null;
    const s = raw.trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return { year: +iso[1], month: +iso[2], day: +iso[3] };
    const dmy = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (dmy) return { year: +dmy[3], month: +dmy[2], day: +dmy[1] };
    const BG: Record<string, number> = {
      яну:1,фев:2,мар:3,апр:4,май:5,юни:6,юли:7,авг:8,сеп:9,окт:10,ное:11,дек:12,
      jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
    };
    const text = s.match(/^(\d{1,2})\s+([а-яa-z]+)\s+(\d{4})$/i);
    if (text) { const m = BG[text[2].toLowerCase().slice(0, 3)]; if (m) return { year: +text[3], month: m, day: +text[1] }; }
    return null;
  }

  private async fillAvailability(
    page: Page, schema: FormSchemaRow, data: Record<string, unknown>, autoSubmit = true
  ): Promise<{ ok: boolean; message: string; observation?: JsonObj }> {
    const actions: string[] = [];
    const checkInRaw = String(data.check_in || data.checkin || data["Дата на настаняване"] || data["дата на настаняване"] || data.from || data.arrival || data.start || "").trim();
    const checkOutRaw = String(data.check_out || data.checkout || data["Дата на отпътуване"] || data["дата на отпътуване"] || data.to || data.departure || data.end || "").trim();
    const adults = String(data.adults || data.възрастни || data.guests || "").trim();
    const checkInDate  = this.parseAvailabilityDate(checkInRaw);
    const checkOutDate = this.parseAvailabilityDate(checkOutRaw);

    console.log(`[AVAILABILITY] check_in="${checkInRaw}" parsed=${JSON.stringify(checkInDate)}`);
    console.log(`[AVAILABILITY] check_out="${checkOutRaw}" parsed=${JSON.stringify(checkOutDate)}`);

    // ── Стратегия 1: Native <input type="date"> ──────────────
    const nativeFilled = await this.tryNativeDateInputs(page, checkInRaw, checkOutRaw);
    if (nativeFilled) {
      if (checkInRaw)  actions.push(`Настаняване: ${checkInRaw}`);
      if (checkOutRaw) actions.push(`Отпътуване: ${checkOutRaw}`);
    }
    // ── Стратегия 2: Calendar Widget (selector-based) ─────────
    else if (checkInDate) {
      const calOpened = await this.openCalendarWidget(page, schema);
      if (calOpened) {
        await page.waitForTimeout(250);
        if (await this.pickDateInCalendar(page, checkInDate)) {
          actions.push(`Настаняване: ${checkInRaw}`);
          await page.waitForTimeout(150);
        } else {
          // Vision fallback за конкретния ден в отворен calendar
          const vLog: string[] = [];
          if (await this.visionFiller.clickDateOnOpenCalendar(page, String(checkInDate.day), vLog)) {
            actions.push(`Настаняване: ${checkInRaw} [vision-cal]`);
          }
          for (const l of vLog) console.log(l);
        }
        if (checkOutDate) {
          if (await this.pickDateInCalendar(page, checkOutDate)) {
            actions.push(`Отпътуване: ${checkOutRaw}`);
          } else {
            const vLog: string[] = [];
            if (await this.visionFiller.clickDateOnOpenCalendar(page, String(checkOutDate.day), vLog)) {
              actions.push(`Отпътуване: ${checkOutRaw} [vision-cal]`);
            }
            for (const l of vLog) console.log(l);
          }
        }
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(150);
      }
    }

    // ── Стратегия 3: Vision LLM (universal fallback) ──────────
    if (actions.length === 0 && this.visionFiller.isEnabled()) {
      console.log("[AVAILABILITY] Strategies 1+2 failed — using Vision LLM");
      const visionResult = await this.visionFiller.fillAvailabilityVision(page, {
        check_in: checkInRaw || undefined,
        check_out: checkOutRaw || undefined,
        adults: adults || undefined,
      });
      for (const line of visionResult.log) console.log(line);
      if (visionResult.ok) {
        if (checkInRaw)  actions.push(`Настаняване: ${checkInRaw} [vision]`);
        if (checkOutRaw) actions.push(`Отпътуване: ${checkOutRaw} [vision]`);
        if (adults)      actions.push(`Гости: ${adults} [vision]`);
      } else {
        console.log("[AVAILABILITY] All 3 strategies failed");
      }
    }

    // ── Гости (selector-based, за всяка стратегия) ────────────
    if (adults && !actions.some(a => a.includes("Гости"))) {
      await this.trySetGuestCount(page, adults);
      actions.push(`Гости: ${adults}`);
    }

    // ── Submit ─────────────────────────────────────────────────
    if (autoSubmit) {
      if (await this.clickAvailabilitySearchButton(page)) {
        actions.push("Търсене");
        await page.waitForFunction(() => document.body && document.body.innerText.replace(/\s/g, "").length > 200, { timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
    }

    const obs = await this.scrapeAvailabilityResults(page);
    if (actions.length) obs.actions = actions;
    return { ok: true, message: actions.join(" → ") || "Availability: страница отворена", observation: obs };
  }

  private async tryNativeDateInputs(page: Page, checkIn: string, checkOut: string): Promise<boolean> {
    try {
      const inputs = await page.$$('input[type="date"]');
      const visible: any[] = [];
      for (const inp of inputs) { if (await inp.isVisible().catch(() => false)) visible.push(inp); }
      if (!visible.length) return false;
      if (checkIn  && visible[0]) await visible[0].fill(checkIn).catch(() => {});
      if (checkOut && visible[1]) await visible[1].fill(checkOut).catch(() => {});
      return true;
    } catch { return false; }
  }

  private async openCalendarWidget(page: Page, schema: FormSchemaRow): Promise<boolean> {
    for (const c of (schema.schema.calendar_containers || [])) {
      for (const sel of (c.selector_candidates || [])) {
        try {
          const el = await page.$(sel);
          if (!el || !await el.isVisible().catch(() => false)) continue;
          await el.click({ timeout: 500 });
          console.log(`[AVAILABILITY] opened via schema: ${sel}`);
          return true;
        } catch {}
      }
    }
    for (const sel of [
      'i[class*="calendar"]', '.fa-calendar', '[class*="calendar-icon"]', '[class*="calendarIcon"]',
      'input[readonly][class*="date"]', 'input[readonly][class*="Date"]',
      'input[placeholder*="астан"]', 'input[placeholder*="Check"]',
      'input[placeholder*="дата"]', 'input[placeholder*="date"]',
      '[class*="daterange"]', '[class*="date-range"]', '[class*="DateRange"]',
      '[class*="datepicker"]:not(input)', '[class*="date-picker"]:not(input)',
      '[class*="dateInput"]', '[class*="checkin"]', '[class*="check-in"]',
      'input[readonly]',
    ]) {
      try {
        const el = await page.$(sel);
        if (!el || !await el.isVisible().catch(() => false)) continue;
        await el.click({ timeout: 500 });
        console.log(`[AVAILABILITY] opened via universal: ${sel}`);
        return true;
      } catch {}
    }
    return false;
  }

  private async pickDateInCalendar(page: Page, target: { year: number; month: number; day: number }): Promise<boolean> {
    for (let attempt = 0; attempt < 24; attempt++) {
      const current = await this.detectCalendarMonth(page);
      if (!current) break;
      const diff = (target.year - current.year) * 12 + (target.month - current.month);
      if (diff === 0) return await this.clickCalendarDay(page, target.day, target.month, target.year);
      if (!await this.clickCalendarNav(page, diff > 0 ? "next" : "prev")) break;
      await page.waitForTimeout(150);
    }
    return await this.clickCalendarDay(page, target.day, target.month, target.year);
  }

  private async detectCalendarMonth(page: Page): Promise<{ year: number; month: number } | null> {
    try {
      return await page.evaluate(() => {
        const M: Record<string, number> = {
          "януари":1,"февруари":2,"март":3,"април":4,"май":5,"юни":6,
          "юли":7,"август":8,"септември":9,"октомври":10,"ноември":11,"декември":12,
          "january":1,"february":2,"march":3,"april":4,"may":5,"june":6,
          "july":7,"august":8,"september":9,"october":10,"november":11,"december":12,
        };
        const isV = (el: Element) => { const s = window.getComputedStyle(el as any); if (s.display==="none"||s.visibility==="hidden") return false; const r=(el as any).getBoundingClientRect?.(); return !!r&&r.width>0&&r.height>0; };
        for (const el of Array.from(document.querySelectorAll('[class*="month"],[class*="Month"],[class*="calendar-title"],[class*="datepicker-title"],[class*="CalendarMonth"],.flatpickr-month,[class*="calendar-header"],[class*="picker-header"]')).filter(isV)) {
          const txt = (el.textContent||"").trim().toLowerCase();
          if (!txt||txt.length>80) continue;
          const yr = txt.match(/\b(202[0-9]|203[0-9])\b/);
          if (!yr) continue;
          for (const [n,num] of Object.entries(M)) { if (txt.includes(n.toLowerCase())) return { year:+yr[1], month:num }; }
          const nm = txt.match(/\b(0?[1-9]|1[0-2])\b/);
          if (nm) return { year:+yr[1], month:+nm[1] };
        }
        return null;
      });
    } catch { return null; }
  }

  private async clickCalendarNav(page: Page, direction: "next" | "prev"): Promise<boolean> {
    const sels = direction === "next"
      ? ['button[aria-label*="next" i]','button[aria-label*="напред" i]','button[aria-label*="следващ" i]','[class*="next-month"]','[class*="nextMonth"]','.flatpickr-next-month','[class*="arrow-right"]','button:has-text(">")','button:has-text("→")','button:has-text("»")']
      : ['button[aria-label*="prev" i]','button[aria-label*="назад" i]','button[aria-label*="предишен" i]','[class*="prev-month"]','[class*="prevMonth"]','.flatpickr-prev-month','[class*="arrow-left"]','button:has-text("<")','button:has-text("←")','button:has-text("«")'];
    for (const sel of sels) {
      try {
        const el = await page.$(sel);
        if (!el||!await el.isVisible().catch(()=>false)) continue;
        await el.click({ timeout: 500 });
        return true;
      } catch {}
    }
    return false;
  }

  private async clickCalendarDay(page: Page, day: number, month: number, year: number): Promise<boolean> {
    try {
      return await page.evaluate(({ day, month, year }) => {
        const isV = (el: Element) => { const s=window.getComputedStyle(el as any); if(s.display==="none"||s.visibility==="hidden"||s.opacity==="0") return false; const r=(el as any).getBoundingClientRect?.(); return !!r&&r.width>0&&r.height>0; };
        const mm=String(month).padStart(2,"0"), dd=String(day).padStart(2,"0"), ds=String(day);
        for (const sel of [`[data-date="${year}-${mm}-${dd}"]`,`[data-date*="${year}-${mm}-${dd}"]`,`[data-day="${day}"]`]) {
          const el=document.querySelector(sel) as HTMLElement|null;
          if (el&&isV(el)&&!(el as any).disabled) { const c=(el.className||"").toLowerCase(); if (!c.includes("disabled")&&!c.includes("unavail")) { el.click(); return true; } }
        }
        for (const el of Array.from(document.querySelectorAll('[class*="day"]:not([class*="dayname"]):not([class*="day-name"]):not([class*="weekday"]):not([class*="header"]),[class*="date-cell"],[class*="dateCell"],td[class*="day"],td[class*="date"],.flatpickr-day'))) {
          if (!isV(el)||(el.textContent||"").trim()!==ds) continue;
          const c=(el.className||"").toLowerCase();
          if (c.includes("disabled")||c.includes("past")||c.includes("unavail")||c.includes("gray")) continue;
          if ((el as any).disabled) continue;
          (el as HTMLElement).click(); return true;
        }
        return false;
      }, { day, month, year });
    } catch { return false; }
  }

  private async trySetGuestCount(page: Page, adults: string): Promise<void> {
    for (const sel of ['select[name*="adult"]','select[name*="guest"]','[class*="adult"] select','[class*="guest"] select','select[aria-label*="възрастн" i]','select[aria-label*="adult" i]']) {
      try {
        const el = await page.$(sel);
        if (!el||!await el.isVisible().catch(()=>false)) continue;
        await (el as any).selectOption({ label: adults }).catch(async () => { await (el as any).selectOption({ value: adults }).catch(()=>{}); });
        return;
      } catch {}
    }
  }

  private async clickAvailabilitySearchButton(page: Page): Promise<boolean> {
    for (const sel of ['button:has-text("Търсене")','button:has-text("Search")','button:has-text("Провери")','button:has-text("Check availability")','button:has-text("Резервирай")','button:has-text("Book")','input[type="submit"][value*="Търс"]','input[type="submit"][value*="Search"]','button[type="submit"]','input[type="submit"]']) {
      try {
        const el = await page.$(sel);
        if (!el||!await el.isVisible().catch(()=>false)) continue;
        await el.click({ timeout: 1000 });
        console.log(`[AVAILABILITY] search: ${sel}`);
        return true;
      } catch {}
    }
    return false;
  }

  private async scrapeAvailabilityResults(page: Page): Promise<JsonObj> {
    try {
      return await page.evaluate(() => {
        const isV = (el: Element) => { const s=window.getComputedStyle(el as any); if(s.display==="none"||s.visibility==="hidden") return false; const r=(el as any).getBoundingClientRect?.(); return !!r&&r.width>0&&r.height>0; };
        const rooms: any[] = [];
        const seen = new Set<Element>();
        const allSels = ['[class*="room-type"]','[class*="roomType"]','[class*="RoomType"]','[class*="rate-plan"]','[class*="ratePlan"]','[class*="wbe-room"]','[class*="wbeRoom"]','[class*="accommodation-type"]','[data-room-type]','[data-rate-plan]','[class*="room"]','[class*="accommodation"]','[class*="стая"]','[class*="suite"]','[class*="result"]','[class*="card"]','[class*="unit"]','[class*="listing"]','[class*="offer"]','[class*="package"]','[class*="rate"]'];
        for (const sel of allSels) {
          document.querySelectorAll(sel).forEach(el => {
            if (seen.has(el)||!isV(el)) return;
            const t = el.textContent||"";
            if (t.length<5||t.length>3000) return;
            seen.add(el);
            const nameEl  = el.querySelector("h1,h2,h3,h4,[class*='title'],[class*='name'],[class*='heading'],[class*='type']");
            const priceEl = el.querySelector("[class*='price'],[class*='цена'],[class*='cost'],[class*='rate'],[class*='amount'],[class*='tariff'],[class*='total']");
            const descEl  = el.querySelector("[class*='desc'],[class*='info'],[class*='detail']");
            const name  = (nameEl?.textContent  || "").trim();
            const price = (priceEl?.textContent || "").trim();
            const desc  = (descEl?.textContent  || "").trim().slice(0, 120);
            if (name||price) rooms.push({ name, price, ...(desc ? { desc } : {}) });
          });
          if (rooms.length>=15) break;
        }
        const snippet = (document.body?.innerText||"").replace(/\s+/g," ").slice(0,1200);
        return { url: window.location.href, title: document.title, rooms: rooms.slice(0,15), snippet, submitted: true, spa_rendered: rooms.length > 0 };
      });
    } catch { return { url:"", snippet:"", submitted:false, spa_rendered:false }; }
  }

  // ─────────────────────────────────────────────────────────
  // Form/Wizard filling (unchanged from v6.2)
  // ─────────────────────────────────────────────────────────

  private matchFieldValue(field: FormSchemaField, data: Record<string, unknown>): string | undefined {
    if (field.name && data[field.name] !== undefined) return String(data[field.name]);
    if (isEmailField(field) && (data as any).email) return String((data as any).email);
    if (isPhoneField(field) && ((data as any).phone || (data as any).telephone)) return String((data as any).phone || (data as any).telephone);
    if (isNameField(field) && ((data as any).name || (data as any).full_name || (data as any).first_name)) return String((data as any).name || (data as any).full_name || (data as any).first_name);
    if (isMessageField(field) && ((data as any).message || (data as any).note || (data as any).comment)) return String((data as any).message || (data as any).note || (data as any).comment);
    return undefined;
  }

  private async fillFormSchema(page: Page, schema: FormSchemaRow, data: Record<string, unknown>, file?: FillFormRequest["file"], autoSubmit = true, strictSelect = false): Promise<{ ok: boolean; message: string; observation?: JsonObj }> {
    const fields = schema.schema.fields || [];
    const actions: string[] = [];
    const filledSelectors: string[] = [];
    console.log(`[FILL-FORM][SCHEMA] submitText="${schema.schema.submit?.text || ""}" submitCandidates=${(schema.schema.submit?.selector_candidates || []).length}`);
    let matchedCount = 0;
    for (const f of fields) {
      const v = this.matchFieldValue(f, data);
      console.log(`[FIELD] name="${f.name}" label="${f.label}" tag=${f.tag} type=${f.type} required=${!!f.required} matched=${v !== undefined ? "yes" : "no"}`);
      if (v === undefined) continue;
      matchedCount++;
      const usedSel = await this.fillSingleField(page, f, String(v), strictSelect);
      if (usedSel) { filledSelectors.push(usedSel); actions.push(`${f.label || f.name || f.placeholder || f.type}: ${summarizeValue(f.name || f.type, v)}`); }
      else { actions.push(`${f.label || f.name || f.placeholder || f.type}: (не успях)`); }
    }
    if (matchedCount === 0) console.log("[FILL-FORM][NO_MATCHED_FIELDS] payload keys:", Object.keys(data));
    if (file) { const up = await this.uploadFile(page, fields, file); if (up) actions.push(`Файл: ${file.filename}`); }
    const submitInfo: JsonObj = {};
    let submitClicked = false;
    if (autoSubmit) {
      console.log("[SUBMIT] attempting...");
      const submit = await this.trySubmitUniversal(page, schema, filledSelectors);
      submitInfo.submit_attempted = submit.attempted;
      submitInfo.submit_method = submit.method;
      submitInfo.submit_clicked = submit.clicked;
      submitInfo.submit_debug = submit.debug;
      submitClicked = !!submit.clicked;
      const invalid = await this.getInvalidFields(page);
      submitInfo.invalid_fields = invalid;
      console.log(`[SUBMIT] clicked=${submit.clicked} method=${submit.method} invalid=${invalid.join(",") || "none"}`);
      if (submit.clicked) actions.push("Кликнах Изпрати");
      else actions.push("Не намерих submit бутон за клик");
      if (invalid.length > 0) actions.push(`VALIDATION BLOCKED: ${invalid.join(", ")}`);
    }
    const obs = await this.quickObserve(page);
    obs.submit = submitInfo;
    return { ok: autoSubmit ? submitClicked : true, message: actions.length ? `Попълних: ${actions.join(", ")}` : "Не успях да попълня полета", observation: obs };
  }

  private async fillWizard(page: Page, schema: FormSchemaRow, data: Record<string, unknown>, autoSubmit = true, strictSelect = false): Promise<{ ok: boolean; message: string; observation?: JsonObj }> {
    try {
      const actions: string[] = [];
      const maxSteps = 8;
      const hasAnyData = Object.values(data || {}).some((v) => String(v ?? "").trim().length > 0);
      if (!hasAnyData) {
        const obs = await this.quickObserve(page);
        (obs as any).wizard = { note: "Missing data payload" };
        return { ok: false, message: "Wizard: липсват данни за попълване (payload е празен)", observation: obs };
      }
      let didInteract = false;
      console.log(`[WIZARD] start url=${page.url()}`);
      for (let step = 1; step <= maxSteps; step++) {
        const beforeSig = await this.getWizardDomSignature(page);
        const scanned = await this.scanWizardStep(page);
        console.log(`[WIZARD] step=${step} fields=${scanned.fields.length} choices=${scanned.choices.length}`);
        let filled = 0;
        for (const f of scanned.fields) {
          const v = this.matchWizardFieldValue(f, data);
          const matched = v !== undefined && String(v).trim().length > 0;
          console.log(`[WIZARD][FIELD] tag=${f.tag} type=${f.type} name="${f.name}" label="${f.label}" required=${f.required} matched=${matched ? "yes" : "no"}`);
          if (!matched) continue;
          const ok = await this.fillWizardField(page, f, String(v), strictSelect);
          if (ok) { filled++; actions.push(`${f.label || f.name || f.placeholder || f.type}: ${summarizeValue(f.name || f.type, v)}`); }
        }
        if (filled > 0) didInteract = true;
        for (const group of scanned.choiceGroups) {
          const groupNameNorm = normLabel(group.name);
          let desiredValue = "";
          for (const k of Object.keys(data)) {
            const kNorm = normLabel(k);
            if (kNorm === groupNameNorm || labelSoftIncludes(k, group.name) || labelSoftIncludes(k, group.label)) { desiredValue = String((data as any)[k] ?? "").trim(); break; }
          }
          if (!desiredValue) {
            for (const k of Object.keys(data)) {
              const v = String((data as any)[k] ?? "").trim();
              if (!v || v.includes("@") || v.length > 40 || /^\+?\d{7,}$/.test(v.replace(/[\s()-]/g, ""))) continue;
              const vNorm = normLabel(v);
              if (!vNorm || vNorm.length < 2) continue;
              if (group.options.some((o) => normLabel(o.text) === vNorm)) { desiredValue = v; break; }
            }
          }
          if (!desiredValue) continue;
          const wantedNorm = normLabel(desiredValue);
          const pick = group.options.find((c) => normLabel(c.text) === wantedNorm) || group.options.find((c) => { const n = normLabel(c.text); return n.length >= 3 && wantedNorm.length >= 3 && (n.includes(wantedNorm) || wantedNorm.includes(n)); });
          if (pick) {
            const clicked = await this.safeClick(page, pick.selector);
            console.log(`[WIZARD][CHOICE] group="${group.name}" desired="${desiredValue}" picked="${pick.text}" clicked=${clicked}`);
            if (clicked) { actions.push(`${group.name}: ${pick.text}`); didInteract = true; }
          }
        }
        let needNow = this.buildWizardNeedPayload(scanned, data);
        if (needNow.missing_required.length > 0) {
          const domMissing = await this.detectWizardMissingByDom(page, scanned.fields);
          if (filled > 0 && domMissing.length === 0) needNow = { ...needNow, missing_required: [] };
          else if (domMissing.length > 0) needNow = { ...needNow, missing_required: needNow.missing_required.filter((m) => domMissing.some((x) => labelSoftIncludes(x, m.label))) };
        }
        if (needNow.missing_required.length > 0) {
          const obs = await this.quickObserve(page);
          (obs as any).needs_input = true;
          (obs as any).wizard_next = { ...needNow, step, total_steps: maxSteps, advanced: false, last_clicked: null };
          console.log(`[WIZARD] needs_input step=${step} missing=${needNow.missing_required.length}`);
          return { ok: false, message: "Wizard: нужни са още данни", observation: obs };
        }
        const clicked = await this.clickWizardNextOrSubmit(page, autoSubmit);
        console.log(`[WIZARD] step=${step} clicked=${clicked.clicked} kind=${clicked.kind} text="${clicked.text}"`);
        if (clicked.clicked) {
          didInteract = true;
          actions.push(clicked.kind === "next" ? "Кликнах Напред" : "Кликнах Изпрати");
          await this.waitForWizardStepChange(page, beforeSig);
          const afterSig = await this.getWizardDomSignature(page);
          const nextScanned = await this.scanWizardStep(page);
          let nextNeed = this.buildWizardNeedPayload(nextScanned, data);
          if (nextNeed.missing_required.length > 0) {
            const domMissing2 = await this.detectWizardMissingByDom(page, nextScanned.fields);
            if (domMissing2.length === 0) nextNeed = { ...nextNeed, missing_required: [] };
            else nextNeed = { ...nextNeed, missing_required: nextNeed.missing_required.filter((m) => domMissing2.some((x) => labelSoftIncludes(x, m.label))) };
          }
          if (nextNeed.missing_required.length > 0) {
            const obs = await this.quickObserve(page);
            (obs as any).needs_input = true;
            (obs as any).wizard_next = { ...nextNeed, step: Math.min(step + 1, maxSteps), total_steps: maxSteps, advanced: beforeSig !== afterSig, last_clicked: { kind: clicked.kind, text: clicked.text } };
            return { ok: false, message: "Wizard: нужни са още данни", observation: obs };
          }
          const unfilled = await this.countUnfilledVisibleFields(page);
          if (unfilled.count > 0) {
            const freshScanned = await this.scanWizardStep(page);
            let filledOnNewStep = 0;
            for (const f of freshScanned.fields) {
              const v = this.matchWizardFieldValue(f, data);
              if (v !== undefined && String(v).trim().length > 0) {
                const ok = await this.fillWizardField(page, f, String(v), strictSelect);
                if (ok) { filledOnNewStep++; actions.push(`${f.label || f.name || f.type}: ${summarizeValue(f.name || f.type, v)}`); }
              }
            }
            for (const group of freshScanned.choiceGroups) {
              const groupNameNorm = normLabel(group.name);
              let desiredValue = "";
              for (const k of Object.keys(data)) { if (normLabel(k) === groupNameNorm || labelSoftIncludes(k, group.name)) { desiredValue = String((data as any)[k] ?? "").trim(); break; } }
              if (!desiredValue) { for (const k of Object.keys(data)) { const v = String((data as any)[k] ?? "").trim(); if (!v || v.includes("@") || v.length > 40) continue; const vNorm = normLabel(v); if (!vNorm || vNorm.length < 2) continue; if (group.options.some((o) => normLabel(o.text) === vNorm)) { desiredValue = v; break; } } }
              if (desiredValue) {
                const wNorm = normLabel(desiredValue);
                const pick = group.options.find((c) => normLabel(c.text) === wNorm) || group.options.find((c) => { const n = normLabel(c.text); return n.length >= 3 && wNorm.length >= 3 && (n.includes(wNorm) || wNorm.includes(n)); });
                if (pick) { const cl = await this.safeClick(page, pick.selector); if (cl) { filledOnNewStep++; actions.push(`${group.name}: ${pick.text}`); } }
              }
            }
            const stillUnfilled = await this.countUnfilledVisibleFields(page);
            if (stillUnfilled.count > 0) {
              const freshScanned2 = await this.scanWizardStep(page);
              const freshNeed = this.buildWizardNeedPayload(freshScanned2, data);
              const domEmptyLabels = stillUnfilled.labels.map((l) => normLabel(l));
              for (const f of freshScanned2.fields) {
                const fLabel = (f.label || f.aria_label || f.placeholder || f.name || f.id || "").trim();
                if (!fLabel) continue;
                const fNorm = normLabel(fLabel);
                const isStillEmpty = domEmptyLabels.some((dl) => dl === fNorm || dl.includes(fNorm) || fNorm.includes(dl));
                if (isStillEmpty && !freshNeed.missing_required.some((m) => normLabel(m.label) === fNorm)) {
                  freshNeed.missing_required.push({ label: fLabel, type: f.type || f.tag, selector: f.selector, options: f.options });
                }
              }
              for (const group of freshScanned2.choiceGroups) {
                const groupDisplayLabel = (group.label && group.label !== "button_choice") ? group.label : group.options.map((o) => o.text).join(" / ");
                if (!freshNeed.missing_required.some((m) => normLabel(m.label) === normLabel(groupDisplayLabel))) {
                  const groupNameNorm = normLabel(group.name);
                  let hasVal = false;
                  for (const k of Object.keys(data)) { if (normLabel(k) === groupNameNorm || labelSoftIncludes(k, group.name)) { if (String((data as any)[k] ?? "").trim()) { hasVal = true; break; } } }
                  if (!hasVal) freshNeed.missing_required.push({ label: groupDisplayLabel, type: "button_group", selector: group.options[0]?.selector || "", options: group.options.map((o) => ({ value: o.text, label: o.text })) });
                }
              }
              if (freshNeed.missing_required.length > 0) {
                const obs = await this.quickObserve(page);
                (obs as any).needs_input = true;
                (obs as any).wizard_next = { ...freshNeed, step: Math.min(step + 1, maxSteps), total_steps: maxSteps, advanced: true, last_clicked: { kind: clicked.kind, text: clicked.text } };
                return { ok: false, message: "Wizard: нужни са още данни за следващата стъпка", observation: obs };
              }
            }
            if (filledOnNewStep > 0) continue;
          }
          if (await this.detectWizardSuccess(page)) {
            const obs = await this.quickObserve(page);
            return { ok: true, message: actions.length ? `Wizard: ${actions.join(", ")}` : "Wizard: изпълнено", observation: obs };
          }
          if (!autoSubmit) {
            const obs = await this.quickObserve(page);
            (obs as any).wizard_next = { ...nextNeed, step: Math.min(step + 1, maxSteps), total_steps: maxSteps, advanced: beforeSig !== afterSig, last_clicked: { kind: clicked.kind, text: clicked.text } };
            return { ok: false, message: "Wizard: следваща стъпка е готова", observation: obs };
          }
          continue;
        }
        const invalid = await this.getInvalidFields(page);
        if (invalid.length) actions.push(`VALIDATION BLOCKED: ${invalid.join(", ")}`);
        const obs = await this.quickObserve(page);
        (obs as any).wizard = { step, filled, invalid_fields: invalid, note: "No next/submit button detected" };
        return { ok: false, message: actions.length ? `Wizard: ${actions.join(", ")}` : "Wizard: не намерих следващ бутон", observation: obs };
      }
      const obs = await this.quickObserve(page);
      (obs as any).wizard = { note: "maxSteps reached" };
      return { ok: false, message: actions.length ? `Wizard: ${actions.join(", ")}` : "Wizard: прекалено много стъпки", observation: obs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[WIZARD][CRASH] ${msg}`, e);
      const obs = await this.quickObserve(page).catch(() => ({} as JsonObj));
      (obs as any).wizard_error = msg;
      return { ok: false, message: `Wizard error: ${msg}`, observation: obs };
    }
  }

  // ─────────────────────────────────────────────────────────
  // Wizard helpers (unchanged)
  // ─────────────────────────────────────────────────────────

  private wizardFieldText(f: WizardScannedField): string {
    return `${f.name || ""} ${f.id || ""} ${f.label || ""} ${f.placeholder || ""} ${f.aria_label || ""}`.toLowerCase();
  }

  private buildWizardNeedPayload(scanned: { fields: WizardScannedField[]; choices: WizardChoiceButton[]; choiceGroups: WizardChoiceGroup[] }, data: Record<string, unknown>) {
    const missing_required: Array<{ label: string; type: string; selector: string; options?: { value: string; label: string }[] }> = [];
    for (const f of scanned.fields) {
      if (!f.required) continue;
      const found = this.matchWizardDataForField(f, data);
      if (!found) missing_required.push({ label: (f.label || f.aria_label || f.placeholder || f.name || f.id || "Поле").trim(), type: f.type || f.tag, selector: f.selector, options: f.options });
    }
    for (const group of scanned.choiceGroups) {
      if (!group.required) continue;
      const groupNameNorm = normLabel(group.name);
      let hasValue = false;
      for (const k of Object.keys(data)) {
        const kNorm = normLabel(k);
        if (kNorm === groupNameNorm || labelSoftIncludes(k, group.name) || labelSoftIncludes(k, group.label)) { const v = String((data as any)[k] ?? "").trim(); if (v) { hasValue = true; break; } }
      }
      if (!hasValue) {
        for (const k of Object.keys(data)) {
          const v = String((data as any)[k] ?? "").trim();
          if (!v || v.includes("@") || v.length > 40 || /^\+?\d{7,}$/.test(v.replace(/[\s()-]/g, ""))) continue;
          const vNorm = normLabel(v);
          if (!vNorm || vNorm.length < 2) continue;
          if (group.options.some((o) => normLabel(o.text) === vNorm)) { hasValue = true; break; }
        }
      }
      if (!hasValue) {
        const groupDisplayLabel = (group.label && group.label !== "button_choice") ? group.label : group.options.map(o => o.text).join(" / ");
        missing_required.push({ label: groupDisplayLabel, type: "button_group", selector: group.options[0]?.selector || "", options: group.options.map(o => ({ value: o.text, label: o.text })) });
      }
    }
    const fields = scanned.fields.map((f) => ({ tag: f.tag, type: f.type, name: f.name, id: f.id, label: f.label, placeholder: f.placeholder, aria_label: f.aria_label, required: f.required, selector: f.selector, selector_candidates: f.selector_candidates, options: f.options }));
    return { missing_required, fields, choices: scanned.choices, choiceGroups: scanned.choiceGroups };
  }

  private async detectWizardMissingByDom(page: Page, fields: WizardScannedField[]): Promise<string[]> {
    try {
      const payload = fields.filter((f) => f.required).map((f) => ({ label: f.label || f.aria_label || f.placeholder || f.name || f.id || "Поле", type: (f.type || f.tag || "").toLowerCase(), selectors: Array.from(new Set([...(f.selector_candidates || []), f.selector].filter(Boolean))).slice(0, 10) }));
      const missing = await page.evaluate((reqFields) => {
        const isEmptyValue = (el: any, type: string) => {
          if (!el) return true;
          const tag = (el.tagName || "").toLowerCase();
          if (tag === "select") return !(el.value || "").toString().trim();
          if (type === "checkbox" || type === "radio") return !Boolean(el.checked);
          return !(el.value || "").toString().trim();
        };
        const out: string[] = [];
        for (const f of reqFields as any[]) {
          let el: any = null;
          for (const sel of f.selectors || []) { el = document.querySelector(sel); if (el) break; }
          if (isEmptyValue(el, f.type || "")) out.push(String(f.label || "Поле"));
        }
        return out;
      }, payload);
      return Array.isArray(missing) ? missing.slice(0, 20) : [];
    } catch { return []; }
  }

  private matchWizardDataForField(f: WizardScannedField, data: Record<string, unknown>): { key: string; value: string } | null {
    const txt = this.wizardFieldText(f);
    const pickByKeys = (keys: string[]) => {
      for (const k of keys) { const v = (data as any)[k]; if (v === null || v === undefined) continue; const s = typeof v === "string" ? v : String(v); if (s.trim()) return { key: k, value: s.trim() }; }
      return null;
    };
    if ((f.type || "").includes("email") || txt.includes("имейл") || txt.includes("e-mail")) return pickByKeys(["email", "e_mail", "mail"]);
    if ((f.type || "").includes("tel") || txt.includes("тел") || txt.includes("phone") || txt.includes("gsm")) return pickByKeys(["phone", "tel", "telephone", "gsm"]);
    if ((f.type || "").includes("number") || txt.includes("възраст") || txt.includes("age")) return pickByKeys(["age", "years", "възраст"]);
    if (txt.includes("име") || txt.includes("name")) return pickByKeys(["name", "full_name", "fullname", "first_name", "last_name", "names"]);
    if (txt.includes("съобщ") || txt.includes("message") || txt.includes("коментар") || txt.includes("note")) return pickByKeys(["message", "comment", "note", "details"]);
    const fLabel = f.label || f.aria_label || f.placeholder || f.name || f.id;
    for (const k of Object.keys(data || {})) {
      const v = (data as any)[k]; if (v === null || v === undefined) continue;
      const s = typeof v === "string" ? v : String(v); if (!s.trim()) continue;
      if (labelSoftIncludes(fLabel, k) || labelSoftIncludes(txt, k)) return { key: k, value: s.trim() };
    }
    return null;
  }

  private matchWizardFieldValue(field: WizardScannedField, data: Record<string, unknown>): string | undefined {
    if (field.name && data[field.name] !== undefined) return String(data[field.name]);
    if (field.id && data[field.id] !== undefined) return String(data[field.id]);
    const t = this.wizardFieldText(field);
    if (field.type === "email" || /e-?mail|email|имейл|поща/.test(t)) { const v = (data as any).email || (data as any).e_mail; if (v !== undefined) return String(v); }
    if (field.type === "tel" || /phone|tel|телефон|мобил|gsm/.test(t)) { const v = (data as any).phone || (data as any).telephone || (data as any).tel; if (v !== undefined) return String(v); }
    if (/name|име|first|last|fullname|фамил/.test(t)) { const v = (data as any).name || (data as any).full_name || (data as any).first_name; if (v !== undefined) return String(v); }
    if (field.tag === "textarea" || /message|съобщ|забел|note|comment|описание/.test(t)) { const v = (data as any).message || (data as any).note || (data as any).comment; if (v !== undefined) return String(v); }
    if (/age|възраст/.test(t)) { const v = (data as any).age || (data as any).years || (data as any).възраст; if (v !== undefined) return String(v); }
    const fLabel = field.label || field.aria_label || field.placeholder || field.name || field.id;
    for (const k of Object.keys(data || {})) {
      const v = (data as any)[k]; if (v === null || v === undefined) continue;
      const s = typeof v === "string" ? v : String(v); if (!s.trim()) continue;
      if (labelSoftIncludes(fLabel, k) || labelSoftIncludes(t, k)) return s.trim();
    }
    for (const k of Object.keys(data || {})) {
      if (!k) continue; const kk = k.toLowerCase(); if (kk.length < 3) continue;
      if (t.includes(kk) && (data as any)[k] !== undefined) return String((data as any)[k]);
    }
    return undefined;
  }

  private async fillWizardField(page: Page, f: WizardScannedField, value: string, strictSelect: boolean): Promise<boolean> {
    const candidates = [...(f.selector_candidates || []), f.selector].filter(Boolean);
    console.log(`[WIZARD][FILL] candidates=${candidates.length} value=${summarizeValue(f.name || f.type, value)}`);
    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count().catch(() => 0) <= 0) continue;
        if (!await loc.isVisible().catch(() => false)) continue;
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 500 }).catch(() => {});
        if (f.tag === "select" || f.type === "select") { const ok = await this.smartSelectOption(page, sel, String(value), strictSelect); if (ok) return true; continue; }
        await loc.fill(String(value), { timeout: 3000 });
        await page.keyboard.press("Tab").catch(() => {});
        await page.waitForTimeout(30).catch(() => {});
        return true;
      } catch {}
    }
    return false;
  }

  private async safeClick(page: Page, selector: string): Promise<boolean> {
    try {
      const el = await page.$(selector);
      if (!el) return false;
      if (!await el.isVisible().catch(() => false)) return false;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 2500, force: true });
      return true;
    } catch { return false; }
  }

  private async clickWizardNextOrSubmit(page: Page, autoSubmit: boolean): Promise<{ clicked: boolean; kind: "next" | "submit" | "none"; text: string }> {
    const nextTexts = ["Напред", "Следва", "Продължи", "Next", "Continue", ">", "→"];
    const submitTexts = ["Изпрати", "Завърши", "Готово", "Submit", "Send", "Finish", "Потвърди"];
    const clickedNext = await this.clickWizardButtonByTexts(page, nextTexts);
    if (clickedNext.clicked) return { clicked: true, kind: "next", text: clickedNext.text };
    if (!autoSubmit) return { clicked: false, kind: "none", text: "" };
    const clickedSubmit = await this.clickWizardButtonByTexts(page, submitTexts, true);
    if (clickedSubmit.clicked) return { clicked: true, kind: "submit", text: clickedSubmit.text };
    try {
      const ok = await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"], input[type="submit"]') as any;
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return false;
        btn.click(); return true;
      });
      if (ok) return { clicked: true, kind: "submit", text: "type=submit" };
    } catch {}
    return { clicked: false, kind: "none", text: "" };
  }

  private async clickWizardButtonByTexts(page: Page, texts: string[], allowSubmitInputs = false): Promise<{ clicked: boolean; text: string }> {
    for (const t of texts) {
      const text = (t || "").trim(); if (!text) continue;
      const candidates = [`button:has-text("${text}")`, `a:has-text("${text}")`];
      if (allowSubmitInputs) candidates.push(`input[type="submit"][value*="${text}"]`);
      for (const sel of candidates) {
        try {
          const el = await page.$(sel);
          if (!el || !await el.isVisible().catch(() => false)) continue;
          if (await el.evaluate((n: any) => !!n.disabled).catch(() => false)) continue;
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click({ timeout: 2500, force: true });
          return { clicked: true, text };
        } catch {}
      }
    }
    return { clicked: false, text: "" };
  }

  private async scanWizardStep(page: Page): Promise<{ fields: WizardScannedField[]; choices: WizardChoiceButton[]; choiceGroups: WizardChoiceGroup[] }> {
    return await page.evaluate(() => {
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el as any);
        if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const r = (el as any).getBoundingClientRect?.();
        return !!(r && r.width > 0 && r.height > 0);
      };
      const cssEscape = (s: string) => { try { return (CSS as any).escape(s); } catch { return s.replace(/[^a-zA-Z0-9_-]/g, "\\$"); } };
      const getSelector = (el: Element): string => {
        const any = el as any;
        const id = any.id ? String(any.id) : "";
        if (id) return `#${cssEscape(id)}`;
        const name = any.name ? String(any.name) : "";
        const tag = el.tagName.toLowerCase();
        if (name) return `${tag}[name="${name.replace(/\"/g, "")}"]`;
        const aria = any.getAttribute?.("aria-label") || "";
        if (aria) return `${tag}[aria-label="${aria.replace(/\"/g, "")}"]`;
        let cur: Element | null = el; const parts: string[] = []; let depth = 0;
        while (cur && depth < 5) {
          const t = cur.tagName.toLowerCase(); const par = cur.parentElement as Element | null; if (!par) break;
          const siblings = Array.from(par.children as unknown as Element[]).filter((c: Element) => c.tagName === cur!.tagName);
          parts.unshift(`${t}:nth-of-type(${siblings.indexOf(cur) + 1})`);
          cur = par; depth++;
          if (t === "form" || t === "main") break;
        }
        return parts.length ? parts.join(" > ") : el.tagName.toLowerCase();
      };
      const getSelectorCandidates = (el: Element): string[] => {
        const any = el as any; const tag = el.tagName.toLowerCase(); const out: string[] = [];
        const id = any.id ? String(any.id) : ""; const name = any.name ? String(any.name) : "";
        const type = (any.type || (tag === "select" ? "select" : tag)).toLowerCase();
        const ph = any.placeholder ? String(any.placeholder) : ""; const aria = any.getAttribute?.("aria-label") ? String(any.getAttribute("aria-label")) : "";
        if (id) out.push(`#${cssEscape(id)}`);
        if (name) out.push(`${tag}[name="${name.replace(/\"/g, "")}"]`);
        if (aria) out.push(`${tag}[aria-label="${aria.replace(/\"/g, "")}"]`);
        if (ph) out.push(`${tag}[placeholder="${ph.replace(/\"/g, "")}"]`);
        if (tag === "input" && type) out.push(`input[type="${type}"]`);
        if (tag === "textarea") out.push("textarea");
        if (tag === "select") out.push("select");
        out.push(getSelector(el));
        return Array.from(new Set(out)).slice(0, 12);
      };
      const getLabel = (el: Element) => {
        const any = el as any; const id = any.id ? String(any.id) : "";
        if (id) { const lab = document.querySelector(`label[for="${cssEscape(id)}"]`) as HTMLElement | null; if (lab && lab.textContent) return lab.textContent.trim(); }
        let p: Element | null = el;
        for (let i = 0; i < 4; i++) { if (!p) break; const lab = (p as any).querySelector?.("label") as HTMLElement | null; if (lab && lab.textContent) return lab.textContent.trim(); p = (p as any).parentElement; }
        const labelledby = any.getAttribute?.("aria-labelledby") || "";
        if (labelledby) { const t = labelledby.split(/\s+/).map((id: string) => document.getElementById(id)?.textContent?.trim() || "").filter(Boolean).join(" "); if (t) return t; }
        return "";
      };
      const inputs = Array.from(document.querySelectorAll("input, textarea, select"));
      const fields = inputs.filter((el) => {
        const any = el as any; if (!isVisible(el)) return false;
        const tag = el.tagName.toLowerCase();
        if (tag === "input") { const type = (any.type || "").toLowerCase(); if (["hidden","submit","button","image","reset"].includes(type)) return false; }
        if (any.disabled || any.getAttribute?.("aria-hidden") === "true") return false;
        return true;
      }).slice(0, 40).map((el) => {
        const any = el as any; const tag = el.tagName.toLowerCase() as any;
        const type = (any.type || (tag === "select" ? "select" : tag)).toLowerCase();
        const label = getLabel(el);
        const required = (() => { const ariaReq = (any.getAttribute?.("aria-required") || "").toString().toLowerCase() === "true"; const dataReq = (any.getAttribute?.("data-required") || "").toString().toLowerCase() === "true"; const star = (label || "").includes("*"); return !!any.required || ariaReq || dataReq || star; })();
        return { tag, type, name: any.name ? String(any.name) : "", id: any.id ? String(any.id) : "", label, placeholder: any.placeholder ? String(any.placeholder) : "", aria_label: any.getAttribute?.("aria-label") ? String(any.getAttribute("aria-label")) : "", required, selector: getSelector(el), selector_candidates: getSelectorCandidates(el), options: tag === "select" ? Array.from((el as HTMLSelectElement).options || []).slice(0, 60).map((o) => ({ value: (o as any).value ? String((o as any).value) : "", label: (o as any).label ? String((o as any).label) : (o.textContent || "").trim() })) : undefined };
      });
      const btns: Array<{ text: string; selector: string; groupLabel: string; required: boolean }> = [];
      const seenContainers = new Set<Element>();
      const submitRe = /напред|назад|next|back|prev|submit|изпрати|запази|book|reserve|резерв|close|затвори|отказ|cancel|продължи|следва|finish|готово|завърши|потвърди/i;
      const langCodes = new Set(["bg","en","de","fr","es","it","ru","tr","nl","pl","ro","cs","el","pt","ar","zh","ja","ko"]);
      const isLangSwitcher = (btns: Element[]) => btns.length >= 2 && btns.length <= 5 && btns.every((b) => { const t = ((b as any).textContent || "").trim().toLowerCase(); return t.length <= 3 && (langCodes.has(t) || /^[a-z]{2}(-[a-z]{2})?$/.test(t)); });
      document.querySelectorAll("button, [role='button']").forEach((btn) => {
        if (!isVisible(btn)) return;
        const parent = btn.parentElement; if (!parent || seenContainers.has(parent)) return;
        const siblingBtns = Array.from(parent.querySelectorAll(":scope > button, :scope > * > button")).filter((b) => isVisible(b));
        if (siblingBtns.length < 2) return;
        const optionBtns = siblingBtns.filter((b) => { const t = ((b as any).textContent || "").trim(); return t.length >= 1 && t.length <= 30 && !submitRe.test(t); });
        if (optionBtns.length < 2 || isLangSwitcher(optionBtns)) return;
        if (parent.closest("nav, header, [role='navigation']")) return;
        seenContainers.add(parent);
        let groupLabel = ""; const prevSib = parent.previousElementSibling as HTMLElement | null;
        if (prevSib) { const t = (prevSib.textContent || "").trim(); const looksLikeData = /@/.test(t) || /^https?:/.test(t) || /^\+?\d[\d\s()-]{6,}$/.test(t); if (t.length >= 2 && t.length <= 60 && !looksLikeData) groupLabel = t; }
        if (!groupLabel) { const gp = parent.parentElement; if (gp) { const lab = gp.querySelector("label, [class*='label']") as HTMLElement | null; if (lab) { const t = (lab.textContent || "").trim(); const looksLikeData = /@/.test(t) || /^https?:/.test(t) || /^\+?\d[\d\s()-]{6,}$/.test(t); if (t.length >= 2 && t.length <= 60 && !looksLikeData) groupLabel = t; } } }
        const isRequired = /\*|задължително|required/i.test(groupLabel);
        const cleanLabel = groupLabel.replace(/\s*\*\s*$/, "").trim();
        optionBtns.forEach((b) => { const text = ((b as any).textContent || "").trim(); btns.push({ text, selector: getSelector(b), groupLabel: cleanLabel || "button_choice", required: isRequired }); });
      });
      document.querySelectorAll('[role="radio"], button[aria-pressed]').forEach((btn) => {
        if (!isVisible(btn)) return;
        const text = ((btn as any).textContent || "").trim();
        if (!text || text.length < 1 || text.length > 30 || submitRe.test(text)) return;
        const parent = btn.parentElement; let groupLabel = "";
        if (parent) { const prevSib = parent.previousElementSibling as HTMLElement | null; if (prevSib) { const t = (prevSib.textContent || "").trim(); if (t.length >= 2 && t.length <= 60) groupLabel = t; } }
        if (btns.some((b) => b.selector === getSelector(btn))) return;
        btns.push({ text, selector: getSelector(btn), groupLabel: groupLabel.replace(/\s*\*\s*$/, "").trim() || "button_choice", required: /\*|задължително|required/i.test(groupLabel) });
      });
      const radiosByName = new Map<string, Element[]>();
      document.querySelectorAll('input[type="radio"]').forEach((radio) => {
        const name = (radio as any).name || ""; if (!name) return;
        if (!radiosByName.has(name)) radiosByName.set(name, []);
        radiosByName.get(name)!.push(radio);
      });
      for (const [rName, radios] of radiosByName) {
        if (radios.length < 2) continue;
        const radioOptions: Array<{ text: string; selector: string }> = [];
        for (const radio of radios) {
          let clickTarget: Element | null = radio;
          for (let d = 0; d < 6; d++) { if (!clickTarget) break; if (isVisible(clickTarget)) { const r = (clickTarget as any).getBoundingClientRect?.(); if (r && r.width > 30 && r.height > 20) break; } clickTarget = (clickTarget as any).parentElement; }
          if (!clickTarget || !isVisible(clickTarget)) continue;
          const text = (clickTarget.textContent || "").trim();
          if (!text || text.length < 1 || text.length > 80 || submitRe.test(text)) continue;
          const sel = getSelector(clickTarget);
          if (btns.some((b) => b.selector === sel)) continue;
          radioOptions.push({ text, selector: sel });
        }
        if (radioOptions.length < 2) continue;
        let groupLabel = ""; let groupContainer = radios[0].parentElement;
        for (let d = 0; d < 5; d++) { if (!groupContainer) break; if (radios.every((r) => groupContainer!.contains(r))) break; groupContainer = (groupContainer as any).parentElement; }
        if (groupContainer) {
          const prevSib = (groupContainer as any).previousElementSibling as HTMLElement | null;
          if (prevSib) { const t = (prevSib.textContent || "").trim(); if (t.length >= 2 && t.length <= 80 && !/@|^https?:/.test(t)) groupLabel = t; }
          if (!groupLabel && (groupContainer as any).parentElement) {
            for (const child of Array.from((groupContainer as any).parentElement.children)) { if (child === groupContainer) break; const t = (child as any).textContent?.trim() || ""; if (t.length >= 2 && t.length <= 80 && !/@|^https?:/.test(t)) groupLabel = t; }
          }
        }
        const isReq = /\*|задължително|required/i.test(groupLabel);
        const cleanLbl = groupLabel.replace(/\s*\*\s*$/, "").trim();
        for (const opt of radioOptions) btns.push({ text: opt.text, selector: opt.selector, groupLabel: cleanLbl || ("radio_" + rName), required: isReq });
      }
      const seenDivGroups = new Set<Element>();
      const findGroupLabel = (container: Element): { label: string; required: boolean } => {
        let groupLabel = "";
        const prevSib = container.previousElementSibling as HTMLElement | null;
        if (prevSib) { const t = (prevSib.textContent || "").trim(); if (t.length >= 2 && t.length <= 80 && !/@|^https?:|^\+?\d[\d\s()-]{6,}$/.test(t)) groupLabel = t; }
        if (!groupLabel && (container as any).parentElement) { for (const child of Array.from((container as any).parentElement.children)) { if (child === container) break; const t = (child as any).textContent?.trim() || ""; if (t.length >= 2 && t.length <= 80 && !/@|^https?:/.test(t)) groupLabel = t; } }
        return { label: groupLabel.replace(/\s*\*\s*$/, "").trim(), required: /\*|задължително|required/i.test(groupLabel) };
      };
      document.querySelectorAll("div, label, li, span, a").forEach((el) => {
        if (!isVisible(el)) return;
        const parent = el.parentElement; if (!parent || seenDivGroups.has(parent)) return;
        if (parent.closest("nav, header, [role='navigation'], form > div:only-child")) return;
        const cls = ((el as any).className || "").toString(); const style = window.getComputedStyle(el);
        const hasBorder = (cls.includes("border") || cls.includes("rounded") || (style.borderWidth && parseFloat(style.borderWidth) >= 1) || cls.includes("cursor-pointer") || style.cursor === "pointer");
        if (!hasBorder) return;
        const siblings = Array.from(parent.children).filter((child) => {
          if (!isVisible(child)) return false; if (child.tagName.toLowerCase() === "button") return false;
          const cCls = ((child as any).className || "").toString(); const cStyle = window.getComputedStyle(child);
          return cCls.includes("border") || cCls.includes("rounded") || (cStyle.borderWidth && parseFloat(cStyle.borderWidth) >= 1) || cCls.includes("cursor-pointer") || cStyle.cursor === "pointer";
        });
        if (siblings.length < 2 || siblings.length > 10) return;
        if (!siblings.every((s) => { const t = (s.textContent || "").trim(); return t.length >= 1 && t.length <= 80; })) return;
        const validOpts = siblings.filter((s) => !submitRe.test((s.textContent || "").trim()));
        if (validOpts.length < 2 || isLangSwitcher(validOpts)) return;
        seenDivGroups.add(parent);
        const { label: gLabel, required: gReq } = findGroupLabel(parent);
        for (const opt of validOpts) { const text = (opt.textContent || "").trim(); const sel = getSelector(opt); if (btns.some((b) => b.selector === sel)) continue; btns.push({ text, selector: sel, groupLabel: gLabel || "div_choice", required: gReq }); }
      });
      const choiceGroups: Array<{ name: string; label: string; required: boolean; type: "button_group"; options: Array<{ text: string; selector: string }> }> = [];
      const groupMap = new Map<string, typeof btns>();
      for (const b of btns) { if (!groupMap.has(b.groupLabel)) groupMap.set(b.groupLabel, []); groupMap.get(b.groupLabel)!.push(b); }
      for (const [name, items] of groupMap) { choiceGroups.push({ name, label: name, required: items.some((i) => i.required), type: "button_group", options: items.map((i) => ({ text: i.text, selector: i.selector })) }); }
      return { fields, choices: btns, choiceGroups };
    });
  }

  private async getWizardDomSignature(page: Page): Promise<string> {
    try {
      return await page.evaluate(() => {
        const title = document.title || ""; const h1 = (document.querySelector("h1")?.textContent || "").trim();
        const step = (document.querySelector("[aria-current='step']")?.textContent || "").trim();
        const inputs = Array.from(document.querySelectorAll("input, textarea, select")).filter((el: any) => { const r = (el as any).getBoundingClientRect?.(); if (!r) return false; const style = window.getComputedStyle(el as any); if (style.display === "none" || style.visibility === "hidden") return false; return r.width > 0 && r.height > 0; }).slice(0, 25).map((el: any) => `${(el.tagName || "").toLowerCase()}:${(el.type || "").toLowerCase()}:${el.name || ""}:${el.id || ""}`).join("|");
        return `${location.pathname}||${title}||${h1}||${step}||${inputs}`;
      });
    } catch { return `sig:${Date.now()}`; }
  }

  private async waitForWizardStepChange(page: Page, beforeSig: string): Promise<void> {
    try {
      await page.waitForFunction((sig: string) => {
        const title = document.title || ""; const h1 = (document.querySelector("h1")?.textContent || "").trim(); const step = (document.querySelector("[aria-current='step']")?.textContent || "").trim();
        const inputs = Array.from(document.querySelectorAll("input, textarea, select")).filter((el: any) => { const r = (el as any).getBoundingClientRect?.(); if (!r) return false; const style = window.getComputedStyle(el as any); return !(style.display === "none" || style.visibility === "hidden") && r.width > 0 && r.height > 0; }).slice(0, 25).map((el: any) => `${(el.tagName || "").toLowerCase()}:${(el.type || "").toLowerCase()}:${el.name || ""}:${el.id || ""}`).join("|");
        return `${location.pathname}||${title}||${h1}||${step}||${inputs}` !== sig;
      }, beforeSig, { timeout: 4000 });
    } catch { await page.waitForTimeout(300).catch(() => {}); }
  }

  private async countUnfilledVisibleFields(page: Page): Promise<{ count: number; labels: string[] }> {
    try {
      return await page.evaluate(() => {
        const isVisible = (el: Element) => { const s = window.getComputedStyle(el as any); if (!s || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false; const r = (el as any).getBoundingClientRect?.(); return !!(r && r.width > 0 && r.height > 0); };
        const getLabel = (el: Element) => {
          const any = el as any; const id = any.id ? String(any.id) : "";
          if (id) { const lab = document.querySelector(`label[for="${id}"]`) as HTMLElement | null; if (lab && lab.textContent) return lab.textContent.trim(); }
          let p: Element | null = el;
          for (let i = 0; i < 3; i++) { if (!p) break; p = (p as any).parentElement; if (p) { const lab = (p as any).querySelector?.("label") as HTMLElement | null; if (lab && lab.textContent) return lab.textContent.trim(); } }
          return any.placeholder || any.name || any.type || "field";
        };
        const pending: string[] = [];
        document.querySelectorAll("input, textarea, select").forEach((el: any) => {
          if (!isVisible(el)) return; const type = (el.type || "").toLowerCase();
          if (["hidden","submit","button","image","reset","file","checkbox","radio"].includes(type)) return;
          if (el.disabled || el.getAttribute?.("aria-hidden") === "true") return;
          if (!(el.value || "").toString().trim()) pending.push(getLabel(el));
        });
        const submitRe = /напред|назад|next|back|prev|submit|изпрати|запази|book|reserve|close|затвори|отказ|cancel|продължи|следва|finish|готово|завърши|потвърди/i;
        const langCodes = new Set(["bg","en","de","fr","es","it","ru","tr","nl","pl","ro","cs","el","pt","ar","zh","ja","ko"]);
        const seenContainers = new Set<Element>();
        document.querySelectorAll("button, [role='button']").forEach((btn) => {
          if (!isVisible(btn)) return; const parent = btn.parentElement; if (!parent || seenContainers.has(parent)) return;
          if (parent.closest("nav, header, [role='navigation']")) return;
          const siblings = Array.from(parent.querySelectorAll(":scope > button, :scope > * > button")).filter((b) => isVisible(b));
          if (siblings.length < 2) return;
          const optBtns = siblings.filter((b) => { const t = ((b as any).textContent || "").trim(); return t.length >= 1 && t.length <= 30 && !submitRe.test(t); });
          if (optBtns.length < 2) return;
          const allLang = optBtns.every((b) => { const t = ((b as any).textContent || "").trim().toLowerCase(); return t.length <= 3 && (langCodes.has(t) || /^[a-z]{2}(-[a-z]{2})?$/.test(t)); });
          if (allLang) return;
          seenContainers.add(parent);
          const hasSelected = optBtns.some((b: any) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true" || b.getAttribute("data-state") === "on" || b.getAttribute("data-state") === "active" || /\bactive\b|\bselected\b|\bchosen\b|\bchecked\b/.test((b.className || "").toLowerCase()) || b.getAttribute("data-selected") === "true");
          if (!hasSelected) { let gLabel = ""; const prevSib = parent.previousElementSibling as HTMLElement | null; if (prevSib) { const t = (prevSib.textContent || "").trim(); const bad = /@/.test(t) || /^https?:/.test(t) || /^\+?\d[\d\s()-]{6,}$/.test(t); if (t.length >= 2 && t.length <= 60 && !bad) gLabel = t; } const optTexts = optBtns.map((b: any) => ((b as any).textContent || "").trim()).join("/"); pending.push(gLabel ? `${gLabel} (${optTexts})` : `Избор: ${optTexts}`); }
        });
        const radiosByName2 = new Map<string, Element[]>();
        document.querySelectorAll('input[type="radio"]').forEach((radio) => { const name = (radio as any).name || ""; if (!name) return; if (!radiosByName2.has(name)) radiosByName2.set(name, []); radiosByName2.get(name)!.push(radio); });
        for (const [, radios] of radiosByName2) {
          if (radios.length < 2) continue; if (radios.some((r: any) => r.checked)) continue;
          let gc = (radios[0] as any).parentElement; for (let i = 0; i < 5 && gc; i++) { if (radios.every((r) => gc!.contains(r))) break; gc = gc.parentElement; }
          let groupLabel = ""; if (gc?.previousElementSibling) { const t = (gc.previousElementSibling.textContent || "").trim(); if (t.length >= 2 && t.length <= 80) groupLabel = t; }
          const optTexts = radios.map((r) => { let el: Element | null = r; for (let i = 0; i < 4; i++) { if (!el) break; if (isVisible(el) && (el as any).getBoundingClientRect().width > 30) break; el = (el as any).parentElement; } return (el?.textContent || "").trim(); }).filter(Boolean).join("/");
          pending.push(groupLabel ? `${groupLabel} (${optTexts})` : `Избор: ${optTexts}`);
        }
        return { count: pending.length, labels: pending.slice(0, 15) };
      });
    } catch { return { count: 0, labels: [] }; }
  }

  private async detectWizardSuccess(page: Page): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        const url = (location.href || "").toLowerCase();
        const urlSuccess = ["thank","thanks","success","submitted","thank-you","blagodar","благодар"].some((x) => url.includes(x));
        const txt = (document.body?.innerText || "").toLowerCase();
        const textSuccess = ["благодар","успеш","изпрат","thank you","success","submitted"].some((h) => txt.includes(h));
        const isVisible = (el: Element) => { const s = window.getComputedStyle(el as any); if (!s || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false; const r = (el as any).getBoundingClientRect?.(); return !!(r && r.width > 0 && r.height > 0); };
        const inputs = Array.from(document.querySelectorAll("input, textarea, select")).filter((el: any) => { if (!isVisible(el)) return false; const tag = (el.tagName || "").toLowerCase(); if (tag === "input") { const type = (el.type || "").toLowerCase(); if (["hidden","submit","button","image","reset"].includes(type)) return false; } return !el.disabled && el.getAttribute?.("aria-hidden") !== "true"; });
        if (inputs.length > 0 && !urlSuccess) return false;
        return Boolean(urlSuccess || textSuccess);
      });
    } catch { return false; }
  }

  private async fillSingleField(page: Page, f: FormSchemaField, value: string, strictSelect: boolean): Promise<string | null> {
    const selectors = [...(f.selector_candidates || []), f.name ? `[name="${f.name}"]` : "", f.name ? `#${f.name}` : ""].filter(Boolean);
    console.log(`[FILL] target="${f.label || f.name}" value=${summarizeValue(f.name || f.type, value)} candidates=${selectors.length}`);
    for (const sel of selectors) {
      try {
        const el = await page.$(sel); if (!el) { console.log(`[FILL][MISS] ${sel}`); continue; }
        const visible = await el.isVisible().catch(() => false);
        if (!visible && f.tag !== "select" && f.type !== "select") { console.log(`[FILL][HIDDEN] ${sel}`); continue; }
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 1200 }).catch(() => {});
        if (f.tag === "select" || f.type === "select") { const ok = await this.smartSelectOption(page, sel, String(value), strictSelect); console.log(`[FILL][SELECT] ${sel} ok=${ok}`); if (ok) return sel; continue; }
        if (f.type === "file") continue;
        await page.fill(sel, String(value), { timeout: 3000 });
        await page.keyboard.press("Tab").catch(() => {});
        await page.waitForTimeout(30).catch(() => {});
        console.log(`[FILL][OK] ${sel}`);
        return sel;
      } catch (e) { console.log(`[FILL][FAIL] ${sel}`, e); }
    }
    console.log(`[FILL][GIVEUP] target="${f.label || f.name}"`);
    return null;
  }

  private async smartSelectOption(page: Page, selectSelector: string, desired: string, strictSelect: boolean): Promise<boolean> {
    const desiredRaw = String(desired || "").trim();
    const wanted = normSelectText(desiredRaw);
    const options = await page.evaluate<{ value: string; label: string }[], { sel: string }>(({ sel }) => { const el = document.querySelector(sel) as HTMLSelectElement | null; if (!el) return []; return Array.from(el.options).map((o: HTMLOptionElement) => ({ value: (o.value || "").toString(), label: (o.textContent || "").trim() })); }, { sel: selectSelector });
    console.log(`[SELECT] selector=${selectSelector} desired="${desiredRaw}" options=${options.length} strict=${strictSelect}`);
    for (const o of options.slice(0, 20)) console.log(`[SELECT][OPT] value="${o.value}" label="${o.label}"`);
    const nonEmpty = options.filter((o) => (o.value || "").trim() !== "");
    if (/^\d+$/.test(wanted)) { const idx = Math.max(1, parseInt(wanted, 10)); const candidate = nonEmpty[idx - 1]; if (candidate) { const ok = await page.evaluate<boolean, { sel: string; v: string }>(({ sel, v }) => { const el = document.querySelector(sel) as HTMLSelectElement | null; if (!el) return false; el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; }, { sel: selectSelector, v: candidate.value }); console.log(`[SELECT] picked(numeric) value="${candidate.value}" ok=${ok}`); return ok; } }
    let picked = options.find((o) => normSelectText(o.value) === wanted) || options.find((o) => normSelectText(o.label) === wanted) || (wanted ? options.find((o) => normSelectText(o.label).includes(wanted)) : undefined) || (wanted ? options.find((o) => normSelectText(o.value).includes(wanted)) : undefined);
    if (!picked) { const intent = pickPlanIntent(desiredRaw); if (intent) { let best: { opt: { value: string; label: string }; score: number } | null = null; for (const o of nonEmpty) { const score = planOptionScore(o, intent); if (!best || score > best.score) best = { opt: o, score }; } if (best && best.score >= 80) picked = best.opt; } }
    if (!picked && strictSelect) { console.log(`[SELECT] strict_select=ON -> no match`); return false; }
    if (!picked) picked = nonEmpty[0];
    if (!picked || !String(picked.value || "").trim()) return false;
    const ok = await page.evaluate<boolean, { sel: string; v: string }>(({ sel, v }) => { const el = document.querySelector(sel) as HTMLSelectElement | null; if (!el) return false; el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; }, { sel: selectSelector, v: picked.value });
    console.log(`[SELECT] picked value="${picked.value}" label="${picked.label}" ok=${ok}`);
    return ok;
  }

  private async uploadFile(page: Page, fields: FormSchemaField[], file: NonNullable<FillFormRequest["file"]>): Promise<boolean> {
    const fs = await import("fs");
    const tmpPath = `/tmp/upload_${Date.now()}_${file.filename}`;
    try {
      fs.writeFileSync(tmpPath, Buffer.from(file.base64, "base64"));
      const fileFields = fields.filter(f => f.type === "file" || f.tag === "input");
      const target = fileFields.find(f => f.name === file.field_name) || fileFields[0];
      const selectors: string[] = [];
      if (target) { selectors.push(...(target.selector_candidates || [])); if (target.name) selectors.push(`input[name="${target.name}"]`); }
      selectors.push('input[type="file"]');
      for (const sel of selectors) { try { const el = await page.$(sel); if (!el) continue; await (el as any).setInputFiles(tmpPath); try { fs.unlinkSync(tmpPath); } catch {} return true; } catch {} }
      try { fs.unlinkSync(tmpPath); } catch {}
      return false;
    } catch { try { fs.unlinkSync(tmpPath); } catch {} return false; }
  }

  private async clickBySelectors(page: Page, selectors: string[], debug: string[]): Promise<boolean> {
    for (const sel of selectors) {
      if (!sel) continue;
      try {
        const el = await page.$(sel); if (!el) { debug.push(`miss:${sel}`); continue; }
        if (!await el.isVisible().catch(() => false)) { debug.push(`hidden:${sel}`); continue; }
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 3000, force: true });
        debug.push(`clicked:${sel}`); return true;
      } catch { debug.push(`fail:${sel}`); }
    }
    return false;
  }

  private async clickByTextHeuristic(page: Page, text: string, debug: string[]): Promise<boolean> {
    const t = (text || "").trim(); if (!t) return false;
    for (const sel of [`button:has-text("${t}")`, `a:has-text("${t}")`, `input[type="submit"][value*="${t}"]`, `text="${t}"`]) {
      try { await page.click(sel, { timeout: 2500, force: true }); debug.push(`clicked_text:${sel}`); return true; } catch { debug.push(`fail_text:${sel}`); }
    }
    return false;
  }

  private async clickSubmitWithinClosestForm(page: Page, anchorSelector: string, debug: string[]): Promise<boolean> {
    const ok = await page.evaluate<boolean, { sel: string }>(({ sel }) => {
      const anchor = document.querySelector(sel) as HTMLElement | null; if (!anchor) return false;
      const form = anchor.closest("form") as HTMLFormElement | null; if (!form) return false;
      const btn = (form.querySelector('button[type="submit"]') as HTMLElement | null) || (form.querySelector('input[type="submit"]') as HTMLElement | null);
      if (btn) { btn.click(); return true; }
      const anyForm: any = form as any;
      if (typeof anyForm.requestSubmit === "function") { anyForm.requestSubmit(); return true; }
      form.submit(); return true;
    }, { sel: anchorSelector });
    debug.push(ok ? `closest_form:ok` : `closest_form:miss`);
    return ok;
  }

  private async getInvalidFields(page: Page): Promise<string[]> {
    const invalid = await page.evaluate<string[]>(() => { const els = Array.from(document.querySelectorAll("input:invalid, textarea:invalid, select:invalid")) as any[]; return els.slice(0, 20).map(el => el.name || el.id || el.getAttribute("aria-label") || el.tagName.toLowerCase()); }).catch(() => []);
    return Array.isArray(invalid) ? invalid : [];
  }

  private async trySubmitUniversal(page: Page, schema?: FormSchemaRow, filledSelectors: string[] = []): Promise<{ attempted: boolean; clicked: boolean; method: string; debug: string[] }> {
    const debug: string[] = [];
    for (const a of filledSelectors.slice(0, 3)) { const ok = await this.clickSubmitWithinClosestForm(page, a, debug); if (ok) { await page.waitForTimeout(300).catch(() => {}); return { attempted: true, clicked: true, method: "closest_form", debug }; } }
    const schemaSelectors = schema?.schema.submit?.selector_candidates || [];
    if (schemaSelectors.length) { const ok = await this.clickBySelectors(page, schemaSelectors, debug); if (ok) { await page.waitForTimeout(300).catch(() => {}); return { attempted: true, clicked: true, method: "schema.selector_candidates", debug }; } }
    const submitText = (schema?.schema.submit?.text || "").trim();
    if (submitText) { const ok = await this.clickByTextHeuristic(page, submitText, debug); if (ok) { await page.waitForTimeout(300).catch(() => {}); return { attempted: true, clicked: true, method: "schema.text", debug }; } }
    const ok2 = await this.clickBySelectors(page, ['button[type="submit"]','input[type="submit"]','button:has-text("Изпрати")','button:has-text("Submit")','button:has-text("Send")'], debug);
    if (ok2) { await page.waitForTimeout(300).catch(() => {}); return { attempted: true, clicked: true, method: "universal_selectors", debug }; }
    try {
      const ok3 = await page.evaluate<boolean>(() => { const form = document.querySelector("form") as any; if (!form) return false; if (typeof form.requestSubmit === "function") { form.requestSubmit(); return true; } form.submit(); return true; });
      if (ok3) { debug.push("requestSubmit()"); await page.waitForTimeout(300).catch(() => {}); return { attempted: true, clicked: true, method: "requestSubmit", debug }; }
    } catch { debug.push("fail_requestSubmit()"); }
    return { attempted: true, clicked: false, method: "none", debug };
  }

  private async quickObserve(page: Page): Promise<JsonObj> {
    try { return await page.evaluate(() => { const text = (document.body?.innerText || "").slice(0, 1200); return { url: window.location.href, title: document.title, snippet: text.slice(0, 300).replace(/\s+/g, " ") }; }); }
    catch { return { url: "", title: "", snippet: "" }; }
  }

  async loadSchemasForApi(sessionId: string): Promise<FormSchemaRow[]> { return this.loadFormSchemas(sessionId); }
  getSessionByDbSessionId(dbSessionId: string): HotSession | null { for (const [, s] of this.sessions) { if (s.sessionId === dbSessionId) return s; } return null; }
}

// ───────────────────────────────────────────────────────────────
// Server
// ───────────────────────────────────────────────────────────────

async function main() {
  const manager = new HotSessionManager();
  const app = express();
  app.use(express.json({ limit: "12mb" }));

  app.use((req, res, next) => {
    if (req.path === "/" || req.path === "/health") return next();
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (token !== WORKER_SECRET) return res.status(401).json({ success: false, error: "Unauthorized" });
    next();
  });

  app.get("/", (_, res) => { res.json({ name: "NEO Worker", version: "6.3.0-vision-availability", mode: "schema-first+vision" }); });
  app.get("/health", (_, res) => { res.json({ status: "ok", ...manager.getStatus() }); });

  app.get("/vision-cache-stats", (_, res) => {
    const s = (manager as any).visionFiller as VisionFormFiller;
    res.json({ success: true, ...s.getCacheStats() });
  });

  app.post("/prepare-session", async (req: Request, res: Response) => {
    const { site_id, site_map, session_id } = req.body || {};
    if (!site_id || !site_map) return res.json({ success: false, error: "Missing site_id/site_map" });
    const ok = await manager.prepareSession(String(site_id), site_map as SiteMap, session_id ? String(session_id) : undefined);
    res.json({ success: ok, session_ready: ok });
  });

  app.post("/fill-form", async (req: Request, res: Response) => {
    const body = req.body as FillFormRequest;
    if (!body?.site_id || !body?.data) return res.json({ success: false, message: "Missing site_id/data" });
    const dataKeys = safeKeys(body.data);
    const confKeys = safeKeys(body.confirmed);
    console.log(`[HTTP][/fill-form] site_id=${body.site_id} session_id=${body.session_id || ""} form_id=${body.form_id || ""} fingerprint=${(body.fingerprint || "").slice(0, 12)} kind=${body.kind || ""} auto_submit=${body.auto_submit !== false} strict_select=${body.strict_select === true}`);
    console.log(`[HTTP][/fill-form] data_keys=${dataKeys.join(",")} confirmed_keys=${confKeys.join(",")}`);
    const r = await manager.executeFillForm(body);
    res.json(r);
  });

  app.post("/execute", async (req: Request, res: Response) => {
    const { site_id, session_id, keywords, data } = req.body || {};
    if (!site_id || !Array.isArray(keywords)) return res.json({ success: false, message: "Invalid request" });
    const r = await manager.execute({ site_id: String(site_id), session_id: session_id ? String(session_id) : undefined, keywords, data: (data || undefined) as any });
    res.json(r);
  });

  app.get("/forms/:sessionId", async (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId || "");
    if (!sessionId) return res.json({ success: false, error: "Missing sessionId" });
    const cached = manager.getSessionByDbSessionId(sessionId);
    if (cached) return res.json({ success: true, source: "cache", forms: cached.formSchemas });
    const forms = await manager.loadSchemasForApi(sessionId);
    res.json({ success: true, source: "db", forms });
  });

  app.post("/refresh-forms", async (req: Request, res: Response) => {
    const { site_id } = req.body || {};
    if (!site_id) return res.json({ success: false, error: "Missing site_id" });
    const forms = await manager.refreshFormSchemas(String(site_id));
    res.json({ success: true, count: forms.length, forms });
  });

  app.post("/close-session", async (req: Request, res: Response) => {
    const { site_id } = req.body || {};
    if (site_id) await manager.closeSession(String(site_id));
    res.json({ success: true });
  });

  app.listen(PORT, () => { console.log(`🚀 NEO Worker v6.3.0-vision-availability listening on :${PORT}`); });
  await manager.start();

  process.on("SIGTERM", async () => { console.log("[SIGTERM] closing..."); process.exit(0); });
  process.on("SIGINT",  async () => { console.log("[SIGINT] closing...");  process.exit(0); });
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
