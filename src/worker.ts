/**
 * NEO WORKER v7.0.0-booking — Universal, deterministic, schema-first
 *
 * v7.0.0-booking — НОВO:
 * - makeReservation(): пълен workflow за резервация
 *     1. Попълва availability form (дати, гости)
 *     2. Взима screenshot → Gemini парсва цени/стаи
 *     3. Ако клиентът е съгласен → попълва reservation details (имена, email, телефон)
 *     4. Спира преди плащане → копира booking URL за клиента
 * - /make-reservation endpoint
 * - fillIframeBookingWidget(): взаимодейства вътре в booking iframes
 *     поддържа: Cloudbeds, Beds24, Mews, Synxis, SabeApp, LittleHotelier, HotelRunner
 *     използва page.frameLocator() за достъп до iframe DOM
 * - fillCustomDatepicker(): universal handler за custom calendar widgets
 *     поддържа: Flatpickr, Pikaday, React DatePicker, AirDatepicker, jQuery UI Datepicker
 *     стратегии: click на ден в calendar grid, keyboard navigation, direct input
 * - fillStyledChoiceGroups(): styled div/li choice groups в form context (не само wizard)
 * - Всички съществуващи функции непроменени
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

interface MakeReservationRequest {
  site_id: string;
  session_id?: string;
  fingerprint?: string;
  // Availability data (step 1)
  check_in: string;
  check_out: string;
  guests?: string | number;
  rooms?: string | number;
  room_type?: string;
  // Guest details (step 2 — after client confirms price)
  guest_name?: string;
  guest_email?: string;
  guest_phone?: string;
  guest_message?: string;
  // Control flags
  phase: "check" | "reserve";  // "check" = само availability screenshot; "reserve" = попълни до плащане
  confirmed_price?: string;     // цената, която клиентът е потвърдил
  auto_submit?: boolean;        // дали да кликне финален submit (default: false — спира преди плащане)
}

// ───────────────────────────────────────────────────────────────
// Logging helpers (PII-safe)
// ───────────────────────────────────────────────────────────────

function safeKeys(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj as Record<string, unknown>);
}

function maskEmail(e: string): string {
  const s = (e || "").trim();
  const at = s.indexOf("@");
  if (at <= 1) return "***";
  const head = s.slice(0, 1);
  const domain = at >= 0 ? s.slice(at) : "";
  return `${head}***${domain}`;
}

function maskPhone(p: string): string {
  const s = (p || "").replace(/[^\d+]/g, "");
  if (s.length <= 4) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function summarizeValue(key: string, v: unknown): string {
  const s = String(v ?? "");
  const k = key.toLowerCase();
  if (k.includes("email")) return maskEmail(s);
  if (k.includes("phone") || k.includes("tel")) return maskPhone(s);
  if (k.includes("message") || k.includes("note") || k.includes("comment")) return `len=${s.length}`;
  if (s.length > 24) return `len=${s.length}`;
  return s;
}

function createSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  } catch {
    return null;
  }
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

function mergeConfirmedData(
  data: Record<string, unknown>,
  confirmed?: Record<string, unknown>
): Record<string, unknown> {
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
  const t = String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\*/g, " ")
    .replace(/[“”"']/g, " ")
    .replace(/[(){}\[\]:;,.!?/\\|<>+=_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

function labelSoftIncludes(a: string, b: string): boolean {
  const A = normLabel(a);
  const B = normLabel(b);
  if (!A || !B) return false;
  return A.includes(B) || B.includes(A);
}

// ───────────────────────────────────────────────────────────────
// Select normalization + matching
// ───────────────────────────────────────────────────────────────

function normSelectText(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[₀-₉]/g, "")
    .replace(/[(){}\[\]:;,.!?/\\|<>+=_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickPlanIntent(desiredRaw: string): "essential" | "advanced" | "ultimate" | "" {
  const d = normSelectText(desiredRaw);

  if (/^\d+$/.test(d)) {
    if (d === "1") return "essential";
    if (d === "2") return "advanced";
    if (d === "3") return "ultimate";
  }

  if (d.includes("advanced") || d.includes("standart") || d.includes("стандарт")) return "advanced";
  if (d.includes("ultimate") || d.includes("premium") || d.includes("премиум")) return "ultimate";
  if (d.includes("essential") || d.includes("basic") || d.includes("start") || d.includes("старт")) return "essential";

  if (d.includes("втори") || d.includes("2")) return "advanced";
  if (d.includes("първи") || d.includes("1")) return "essential";
  if (d.includes("трети") || d.includes("3")) return "ultimate";

  return "";
}

function planOptionScore(opt: { value: string; label: string }, intent: string): number {
  const v = normSelectText(opt.value);
  const l = normSelectText(opt.label);
  const hay = `${v} ${l}`;

  if (!intent) return 0;

  if (intent === "essential") {
    if (hay.includes("startov") || hay.includes("стартов")) return 100;
    if (hay.includes("standarten") || hay.includes("стандарт")) return 40;
    if (hay.includes("premium") || hay.includes("премиум")) return 20;
  }
  if (intent === "advanced") {
    if (hay.includes("standarten") || hay.includes("стандарт")) return 100;
    if (hay.includes("startov") || hay.includes("стартов")) return 40;
    if (hay.includes("premium") || hay.includes("премиум")) return 60;
  }
  if (intent === "ultimate") {
    if (hay.includes("premium") || hay.includes("премиум") || hay.includes("индивидуал")) return 100;
    if (hay.includes("standarten") || hay.includes("стандарт")) return 60;
    if (hay.includes("startov") || hay.includes("стартов")) return 40;
  }

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
  }

  getStatus() {
    const sessionDetails: Record<string, { url: string; schemas: number; age_sec: number }> = {};
    for (const [id, s] of this.sessions) {
      sessionDetails[id] = {
        url: s.currentUrl,
        schemas: s.formSchemas.length,
        age_sec: Math.round((Date.now() - s.lastActivity) / 1000),
      };
    }
    return {
      ready: this.isReady,
      db: !!this.supabase,
      sessions: this.sessions.size,
      maxSessions: this.MAX_SESSIONS,
      sessionDetails,
      uptime_sec: Math.floor(process.uptime()),
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
      const { data, error } = await this.supabase
        .from("form_schemas")
        .select("*")
        .eq("session_id", sessionId)
        .limit(50);

      if (error) {
        console.error("[DB] form_schemas error:", error.message);
        return [];
      }
      const rows = (data || []) as FormSchemaRow[];
      console.log(`[DB] Loaded ${rows.length} form_schemas for session ${sessionId.slice(0, 8)}…`);
      return rows;
    } catch (e) {
      console.error("[DB] loadFormSchemas exception:", e);
      return [];
    }
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
        locale: "bg-BG",
        timezoneId: "Europe/Sofia",
        ignoreHTTPSErrors: true,
      });

      const page = await context.newPage();

      let url = siteMap.url;
      if (url && !url.startsWith("http")) url = "https://" + url;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1200);

      const dbSessionId = sessionId || siteId;
      const schemas = await this.loadFormSchemas(dbSessionId);

      this.sessions.set(siteId, {
        page,
        context,
        siteMap,
        sessionId: dbSessionId,
        formSchemas: schemas,
        lastActivity: Date.now(),
        currentUrl: page.url(),
      });

      console.log(`[PREPARE] ✓ Session ready in ${Date.now() - start}ms (${schemas.length} form schemas)`);
      return true;
    } catch (e) {
      console.error("[PREPARE] Failed:", e);
      return false;
    }
  }

  async refreshFormSchemas(siteId: string): Promise<FormSchemaRow[]> {
    const s = this.sessions.get(siteId);
    if (!s) return [];
    const dbSessionId = s.sessionId || siteId;
    const schemas = await this.loadFormSchemas(dbSessionId);
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
    if (!schema) schema = session.formSchemas.find(s => s.kind === "form" || s.kind === "wizard");

    if (!schema) {
      console.log(`[FILL-FORM][NO_SCHEMA] form_id=${form_id || ""} fingerprint=${(fingerprint || "").slice(0, 12)} schemas=${session.formSchemas.length} ids=${session.formSchemas.map(s => s.id).join(",")}`);
      return { success: false, message: `Не намерих форма (schemas=${session.formSchemas.length})` };
    }

    console.log(`[FILL-FORM] kind=${schema.kind} form_id=${schema.id} fingerprint=${schema.fingerprint.slice(0, 12)}… fields=${schema.schema.fields?.length || 0}`);

    const merged = mergeConfirmedData(data || {}, confirmed as any);

    const mergedKeys = Object.keys(merged);
    const mergedPreview = mergedKeys.slice(0, 12).map(k => `${k}=${summarizeValue(k, (merged as any)[k])}`);
    console.log(`[FILL-FORM][PAYLOAD] keys=${mergedKeys.join(",")} preview=${mergedPreview.join(" | ")}`);

    await this.ensureOnSchemaUrl(session.page, schema.url);

    let result: { ok: boolean; message: string; observation?: JsonObj };
    if (schema.kind === "wizard") {
      result = await this.fillWizard(session.page, schema, merged, autoSubmit, strictSelect);
    } else if (schema.kind === "availability") {
      // Availability check — fill dates, click search, take screenshot, return for vision parsing
      result = await this.checkAvailability(session.page, schema, merged);
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

  // ─────────────────────────────────────────────────────────
  // /execute (legacy)
  // ─────────────────────────────────────────────────────────

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
      const cur = new URL(page.url());
      const target = new URL(schemaUrl);
      if (cur.pathname === target.pathname) return;
    } catch {}

    try {
      console.log(`[NAV] goto ${schemaUrl}`);
      await page.goto(schemaUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(900);
    } catch (e) {
      console.log("[NAV] goto failed:", e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // Filling logic
  // ─────────────────────────────────────────────────────────

  private matchFieldValue(field: FormSchemaField, data: Record<string, unknown>): string | undefined {
    if (field.name && data[field.name] !== undefined) return String(data[field.name]);

    if (isEmailField(field) && (data as any).email) return String((data as any).email);
    if (isPhoneField(field) && ((data as any).phone || (data as any).telephone)) return String((data as any).phone || (data as any).telephone);
    if (isNameField(field) && ((data as any).name || (data as any).full_name || (data as any).first_name)) return String((data as any).name || (data as any).full_name || (data as any).first_name);
    if (isMessageField(field) && ((data as any).message || (data as any).note || (data as any).comment)) return String((data as any).message || (data as any).note || (data as any).comment);

    return undefined;
  }

  private async fillFormSchema(
    page: Page,
    schema: FormSchemaRow,
    data: Record<string, unknown>,
    file?: FillFormRequest["file"],
    autoSubmit = true,
    strictSelect = false
  ): Promise<{ ok: boolean; message: string; observation?: JsonObj }> {
    const fields = schema.schema.fields || [];
    const actions: string[] = [];
    const filledSelectors: string[] = [];

    console.log(`[FILL-FORM][SCHEMA] submitText="${schema.schema.submit?.text || ""}" submitCandidates=${(schema.schema.submit?.selector_candidates || []).length}`);

    let matchedCount = 0;

    for (const f of fields) {
      const v = this.matchFieldValue(f, data);

      console.log(
        `[FIELD] name="${f.name}" label="${f.label}" tag=${f.tag} type=${f.type} required=${!!f.required} matched=${v !== undefined ? "yes" : "no"}`
      );

      if (v === undefined) continue;
      matchedCount++;

      const usedSel = await this.fillSingleField(page, f, String(v), strictSelect);
      if (usedSel) {
        filledSelectors.push(usedSel);
        actions.push(`${f.label || f.name || f.placeholder || f.type}: ${summarizeValue(f.name || f.type, v)}`);
      } else {
        actions.push(`${f.label || f.name || f.placeholder || f.type}: (не успях)`);
      }
    }

    if (matchedCount === 0) {
      console.log("[FILL-FORM][NO_MATCHED_FIELDS] payload keys:", Object.keys(data));
    }

    if (file) {
      const up = await this.uploadFile(page, fields, file);
      if (up) actions.push(`Файл: ${file.filename}`);
    }

    // ✅ NEW: Fill choice groups (radio, button_group, select choices) from schema
    const schemaChoices = (schema.schema as any).choices as Array<any> | undefined;
    if (schemaChoices?.length) {
      const choiceActions = await this.fillStyledChoiceGroups(page, schemaChoices, data);
      choiceActions.forEach(a => actions.push(a));
    }

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

    return {
      ok: autoSubmit ? submitClicked : true,
      message: actions.length ? `Попълних: ${actions.join(", ")}` : "Не успях да попълня полета",
      observation: obs,
    };
  }

  private async fillWizard(
    page: Page,
    schema: FormSchemaRow,
    data: Record<string, unknown>,
    autoSubmit = true,
    strictSelect = false
  ): Promise<{ ok: boolean; message: string; observation?: JsonObj }> {
    try {
    const actions: string[] = [];
    const maxSteps = 8;

    const hasAnyData = Object.values(data || {}).some((v) => String(v ?? "").trim().length > 0);
    if (!hasAnyData) {
      const obs = await this.quickObserve(page);
      (obs as any).wizard = { note: "Missing data payload (no fields to fill)" };
      return { ok: false, message: "Wizard: липсват данни за попълване (payload е празен)", observation: obs };
    }

    let didInteract = false;

    console.log(`[WIZARD] start url=${page.url()}`);

    for (let step = 1; step <= maxSteps; step++) {
      const beforeSig = await this.getWizardDomSignature(page);
      const scanned = await this.scanWizardStep(page);

      console.log(
        `[WIZARD] step=${step} fields=${scanned.fields.length} choices=${scanned.choices.length} sig=${beforeSig.slice(0, 40)}`
      );

      // 1) Fill visible fields
      let filled = 0;
      for (const f of scanned.fields) {
        const v = this.matchWizardFieldValue(f, data);
        const matched = v !== undefined && String(v).trim().length > 0;

        console.log(
          `[WIZARD][FIELD] tag=${f.tag} type=${f.type} name="${f.name}" label="${f.label}" required=${f.required} matched=${matched ? "yes" : "no"}`
        );

        if (!matched) continue;
        const ok = await this.fillWizardField(page, f, String(v), strictSelect);
        if (ok) {
          filled++;
          actions.push(`${f.label || f.name || f.placeholder || f.type}: ${summarizeValue(f.name || f.type, v)}`);
        }
      }
      if (filled > 0) didInteract = true;

      // 2) Handle choice button groups (generic — matches any choice from data)
      for (const group of scanned.choiceGroups) {
        // Try to find the value for this choice group in data
        // Look by group name, label, and common aliases
        const groupNameNorm = normLabel(group.name);
        let desiredValue = "";

        // Direct lookup by group name/label
        for (const k of Object.keys(data)) {
          const kNorm = normLabel(k);
          if (kNorm === groupNameNorm || labelSoftIncludes(k, group.name) || labelSoftIncludes(k, group.label)) {
            desiredValue = String((data as any)[k] ?? "").trim();
            break;
          }
        }

        // Fallback: if no direct key match, check if any data VALUE matches an option text
        // Only use EXACT match (after normalization) to avoid false positives
        // e.g. data has "Пол (избор: Мъж / Жена)": "Мъж" — the key won't match group.name directly
        if (!desiredValue) {
          for (const k of Object.keys(data)) {
            const v = String((data as any)[k] ?? "").trim();
            if (!v) continue;
            // Skip values that are clearly not choice options (emails, phones, long strings)
            if (v.includes("@") || v.length > 40 || /^\+?\d{7,}$/.test(v.replace(/[\s()-]/g, ""))) continue;
            const vNorm = normLabel(v);
            if (!vNorm || vNorm.length < 2) continue;
            // STRICT: only exact match after normalization — no substring matching
            const optMatch = group.options.some((o) => normLabel(o.text) === vNorm);
            if (optMatch) {
              desiredValue = v;
              break;
            }
          }
        }

        if (!desiredValue) continue;

        const wantedNorm = normLabel(desiredValue);
        const pick =
          group.options.find((c) => normLabel(c.text) === wantedNorm) ||
          group.options.find((c) => {
            const optNorm = normLabel(c.text);
            // Only allow substring match if both sides are at least 3 chars
            if (optNorm.length < 3 || wantedNorm.length < 3) return false;
            return optNorm.includes(wantedNorm) || wantedNorm.includes(optNorm);
          });

        if (pick) {
          const clicked = await this.safeClick(page, pick.selector);
          console.log(`[WIZARD][CHOICE] group="${group.name}" desired="${desiredValue}" picked="${pick.text}" clicked=${clicked}`);
          if (clicked) {
            actions.push(`${group.name}: ${pick.text}`);
            didInteract = true;
          }
        } else {
          console.log(`[WIZARD][CHOICE] group="${group.name}" desired="${desiredValue}" NO MATCH in options=[${group.options.map(o => o.text).join(",")}]`);
        }
      }

      // 2.5) Missing required: payload-based + DOM verification fallback
      let needNow = this.buildWizardNeedPayload(scanned, data);
      if (needNow.missing_required.length > 0) {
        const domMissing = await this.detectWizardMissingByDom(page, scanned.fields);
        if (filled > 0 && domMissing.length === 0) {
          needNow = { ...needNow, missing_required: [] };
        } else if (domMissing.length > 0) {
          needNow = {
            ...needNow,
            missing_required: needNow.missing_required.filter((m) =>
              domMissing.some((x) => labelSoftIncludes(x, m.label))
            ),
          };
        }
      }

      if (needNow.missing_required.length > 0) {
        const obs = await this.quickObserve(page);
        (obs as any).needs_input = true;
        (obs as any).wizard_next = {
          ...needNow,
          step,
          total_steps: maxSteps,
          advanced: false,
          last_clicked: null,
        };
        console.log(`[WIZARD] needs_input on current step=${step} missing=${needNow.missing_required.length}`);
        return { ok: false, message: "Wizard: нужни са още данни", observation: obs };
      }

      // 3) Decide Next vs Submit
      const clicked = await this.clickWizardNextOrSubmit(page, autoSubmit);
      console.log(`[WIZARD] step=${step} clicked=${clicked.clicked} kind=${clicked.kind} text="${clicked.text}"`);

      if (clicked.clicked) {
        didInteract = true;
        actions.push(clicked.kind === "next" ? "Кликнах Напред" : "Кликнах Изпрати");

        // ✅ Wait and then ALWAYS rescan
        await this.waitForWizardStepChange(page, beforeSig);

        const afterSig = await this.getWizardDomSignature(page);
        const nextScanned = await this.scanWizardStep(page);

        // ✅ If next step introduces new required fields -> needs_input (NO fake success)
        let nextNeed = this.buildWizardNeedPayload(nextScanned, data);
        if (nextNeed.missing_required.length > 0) {
          const domMissing2 = await this.detectWizardMissingByDom(page, nextScanned.fields);
          if (domMissing2.length === 0) {
            nextNeed = { ...nextNeed, missing_required: [] };
          } else {
            nextNeed = {
              ...nextNeed,
              missing_required: nextNeed.missing_required.filter((m) =>
                domMissing2.some((x) => labelSoftIncludes(x, m.label))
              ),
            };
          }
        }

        if (nextNeed.missing_required.length > 0) {
          const obs = await this.quickObserve(page);
          (obs as any).needs_input = true;
          (obs as any).wizard_next = {
            ...nextNeed,
            step: Math.min(step + 1, maxSteps),
            total_steps: maxSteps,
            advanced: beforeSig !== afterSig,
            last_clicked: { kind: clicked.kind, text: clicked.text },
          };
          console.log(`[WIZARD] needs_input after click step=${step} missing=${nextNeed.missing_required.length}`);
          return { ok: false, message: "Wizard: нужни са още данни", observation: obs };
        }

        // ✅ CRITICAL: Before declaring success, check if there are visible EMPTY fields in DOM.
        // Multi-step wizards show new empty fields after "Напред" — that's a new step, NOT success.
        const unfilled = await this.countUnfilledVisibleFields(page);
        if (unfilled.count > 0) {
          console.log(`[WIZARD] step=${step} after click: ${unfilled.count} unfilled visible fields (${unfilled.labels.join(", ")})`);

          // Rescan to get full field info for the new step
          const freshScanned = await this.scanWizardStep(page);

          // Try to fill whatever we can from existing data
          let filledOnNewStep = 0;
          for (const f of freshScanned.fields) {
            const v = this.matchWizardFieldValue(f, data);
            if (v !== undefined && String(v).trim().length > 0) {
              const ok = await this.fillWizardField(page, f, String(v), strictSelect);
              if (ok) {
                filledOnNewStep++;
                actions.push(`${f.label || f.name || f.placeholder || f.type}: ${summarizeValue(f.name || f.type, v)}`);
              }
            }
          }

          // Try to click any matching choices on the new step
          for (const group of freshScanned.choiceGroups) {
            const groupNameNorm = normLabel(group.name);
            let desiredValue = "";
            for (const k of Object.keys(data)) {
              const kNorm = normLabel(k);
              if (kNorm === groupNameNorm || labelSoftIncludes(k, group.name) || labelSoftIncludes(k, group.label)) {
                desiredValue = String((data as any)[k] ?? "").trim();
                break;
              }
            }
            if (!desiredValue) {
              for (const k of Object.keys(data)) {
                const v = String((data as any)[k] ?? "").trim();
                if (!v || v.includes("@") || v.length > 40) continue;
                const vNorm = normLabel(v);
                if (!vNorm || vNorm.length < 2) continue;
                if (group.options.some((o) => normLabel(o.text) === vNorm)) { desiredValue = v; break; }
              }
            }
            if (desiredValue) {
              const wNorm = normLabel(desiredValue);
              const pick = group.options.find((c) => normLabel(c.text) === wNorm) ||
                group.options.find((c) => { const n = normLabel(c.text); return n.length >= 3 && wNorm.length >= 3 && (n.includes(wNorm) || wNorm.includes(n)); });
              if (pick) {
                const clicked2 = await this.safeClick(page, pick.selector);
                if (clicked2) {
                  filledOnNewStep++;
                  actions.push(`${group.name}: ${pick.text}`);
                }
              }
            }
          }

          // Re-check: are there still unfilled fields?
          const stillUnfilled = await this.countUnfilledVisibleFields(page);
          if (stillUnfilled.count > 0) {
            // Build needs_input with the remaining unfilled fields
            const freshScanned2 = await this.scanWizardStep(page);
            const freshNeed = this.buildWizardNeedPayload(freshScanned2, data);

            // Force include all unfilled fields as missing, even if buildWizardNeedPayload thinks data matches
            // (because the DOM fields are empty — data fuzzy-matching doesn't mean the field is actually filled)
            const domEmptyLabels = stillUnfilled.labels.map((l) => normLabel(l));
            for (const f of freshScanned2.fields) {
              const fLabel = (f.label || f.aria_label || f.placeholder || f.name || f.id || "").trim();
              if (!fLabel) continue;
              const fNorm = normLabel(fLabel);
              const isStillEmpty = domEmptyLabels.some((dl) => dl === fNorm || dl.includes(fNorm) || fNorm.includes(dl));
              if (isStillEmpty && !freshNeed.missing_required.some((m) => normLabel(m.label) === fNorm)) {
                freshNeed.missing_required.push({
                  label: fLabel,
                  type: f.type || f.tag,
                  selector: f.selector,
                  options: f.options,
                });
              }
            }

            // Also add unfilled choice groups
            for (const group of freshScanned2.choiceGroups) {
              const groupDisplayLabel = (group.label && group.label !== "button_choice")
                ? group.label
                : group.options.map((o) => o.text).join(" / ");
              if (!freshNeed.missing_required.some((m) => normLabel(m.label) === normLabel(groupDisplayLabel))) {
                const groupNameNorm = normLabel(group.name);
                let hasVal = false;
                for (const k of Object.keys(data)) {
                  if (normLabel(k) === groupNameNorm || labelSoftIncludes(k, group.name)) {
                    if (String((data as any)[k] ?? "").trim()) { hasVal = true; break; }
                  }
                }
                if (!hasVal) {
                  freshNeed.missing_required.push({
                    label: groupDisplayLabel,
                    type: "button_group",
                    selector: group.options[0]?.selector || "",
                    options: group.options.map((o) => ({ value: o.text, label: o.text })),
                  });
                }
              }
            }

            if (freshNeed.missing_required.length > 0) {
              const obs = await this.quickObserve(page);
              (obs as any).needs_input = true;
              (obs as any).wizard_next = {
                ...freshNeed,
                step: Math.min(step + 1, maxSteps),
                total_steps: maxSteps,
                advanced: true,
                last_clicked: { kind: clicked.kind, text: clicked.text },
              };
              console.log(`[WIZARD] needs_input: new step has ${freshNeed.missing_required.length} missing fields: ${freshNeed.missing_required.map((m) => m.label).join(", ")}`);
              return { ok: false, message: "Wizard: нужни са още данни за следващата стъпка", observation: obs };
            }
          }

          // If we filled everything on the new step, check if there's a Next button to click
          if (filledOnNewStep > 0) {
            console.log(`[WIZARD] filled ${filledOnNewStep} fields on new step, continuing loop`);
            continue;
          }
        }

        if (await this.detectWizardSuccess(page)) {
          const obs = await this.quickObserve(page);
          console.log(`[WIZARD] success detected after click at step=${step}`);
          return {
            ok: true,
            message: actions.length ? `Wizard: ${actions.join(", ")}` : "Wizard: изпълнено",
            observation: obs
          };
        }

        if (!autoSubmit) {
          const obs = await this.quickObserve(page);
          (obs as any).wizard_next = {
            ...nextNeed,
            step: Math.min(step + 1, maxSteps),
            total_steps: maxSteps,
            advanced: beforeSig !== afterSig,
            last_clicked: { kind: clicked.kind, text: clicked.text },
          };
          return { ok: false, message: "Wizard: следваща стъпка е готова", observation: obs };
        }

        continue;
      }

      const invalid = await this.getInvalidFields(page);
      if (invalid.length) {
        actions.push(`VALIDATION BLOCKED: ${invalid.join(", ")}`);
      }

      const obs = await this.quickObserve(page);
      (obs as any).wizard = {
        step,
        filled,
        invalid_fields: invalid,
        note: "No next/submit button detected",
      };

      return {
        ok: false,
        message: actions.length ? `Wizard: ${actions.join(", ")}` : "Wizard: не намерих следващ бутон",
        observation: obs,
      };
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
  // Wizard helpers
  // ─────────────────────────────────────────────────────────

  private wizardFieldText(f: WizardScannedField): string {
    return `${f.name || ""} ${f.id || ""} ${f.label || ""} ${f.placeholder || ""} ${f.aria_label || ""}`.toLowerCase();
  }

  private buildWizardNeedPayload(scanned: { fields: WizardScannedField[]; choices: WizardChoiceButton[]; choiceGroups: WizardChoiceGroup[] }, data: Record<string, unknown>) {
    const missing_required: Array<{
      label: string;
      type: string;
      selector: string;
      options?: { value: string; label: string }[];
    }> = [];

    for (const f of scanned.fields) {
      if (!f.required) continue;
      const found = this.matchWizardDataForField(f, data);
      if (!found) {
        missing_required.push({
          label: (f.label || f.aria_label || f.placeholder || f.name || f.id || "Поле").trim(),
          type: f.type || f.tag,
          selector: f.selector,
          options: f.options,
        });
      }
    }

    // ✅ Also check choice groups for missing required values
    for (const group of scanned.choiceGroups) {
      if (!group.required) continue;

      const groupNameNorm = normLabel(group.name);
      let hasValue = false;

      for (const k of Object.keys(data)) {
        const kNorm = normLabel(k);
        if (kNorm === groupNameNorm || labelSoftIncludes(k, group.name) || labelSoftIncludes(k, group.label)) {
          const v = String((data as any)[k] ?? "").trim();
          if (v) { hasValue = true; break; }
        }
      }

      // Fallback: check if any data value EXACTLY matches an option text
      if (!hasValue) {
        for (const k of Object.keys(data)) {
          const v = String((data as any)[k] ?? "").trim();
          if (!v) continue;
          if (v.includes("@") || v.length > 40 || /^\+?\d{7,}$/.test(v.replace(/[\s()-]/g, ""))) continue;
          const vNorm = normLabel(v);
          if (!vNorm || vNorm.length < 2) continue;
          const optMatch = group.options.some((o) => normLabel(o.text) === vNorm);
          if (optMatch) { hasValue = true; break; }
        }
      }

      if (!hasValue) {
        const groupDisplayLabel = (group.label && group.label !== "button_choice")
          ? group.label
          : group.options.map(o => o.text).join(" / ");
        missing_required.push({
          label: groupDisplayLabel,
          type: "button_group",
          selector: group.options[0]?.selector || "",
          options: group.options.map(o => ({ value: o.text, label: o.text })),
        });
      }
    }

    const fields = scanned.fields.map((f) => ({
      tag: f.tag,
      type: f.type,
      name: f.name,
      id: f.id,
      label: f.label,
      placeholder: f.placeholder,
      aria_label: f.aria_label,
      required: f.required,
      selector: f.selector,
      selector_candidates: f.selector_candidates,
      options: f.options,
    }));

    return { missing_required, fields, choices: scanned.choices, choiceGroups: scanned.choiceGroups };
  }

  private async detectWizardMissingByDom(page: Page, fields: WizardScannedField[]): Promise<string[]> {
    try {
      const payload = fields
        .filter((f) => f.required)
        .map((f) => ({
          label: f.label || f.aria_label || f.placeholder || f.name || f.id || "Поле",
          type: (f.type || f.tag || "").toLowerCase(),
          selectors: Array.from(new Set([...(f.selector_candidates || []), f.selector].filter(Boolean))).slice(0, 10),
        }));

      const missing = await page.evaluate((reqFields) => {
        const isEmptyValue = (el: any, type: string) => {
          if (!el) return true;
          const tag = (el.tagName || "").toLowerCase();
          if (tag === "select") {
            const v = (el.value || "").toString().trim();
            return !v;
          }
          if (type === "checkbox" || type === "radio") {
            return !Boolean(el.checked);
          }
          const v = (el.value || "").toString().trim();
          return !v;
        };

        const out: string[] = [];
        for (const f of reqFields as any[]) {
          let el: any = null;
          for (const sel of f.selectors || []) {
            el = document.querySelector(sel);
            if (el) break;
          }
          if (isEmptyValue(el, f.type || "")) out.push(String(f.label || "Поле"));
        }
        return out;
      }, payload);

      return Array.isArray(missing) ? missing.slice(0, 20) : [];
    } catch {
      return [];
    }
  }

  private matchWizardDataForField(f: WizardScannedField, data: Record<string, unknown>): { key: string; value: string } | null {
    const txt = this.wizardFieldText(f);

    const pickByKeys = (keys: string[]) => {
      for (const k of keys) {
        const v = (data as any)[k];
        if (v === null || v === undefined) continue;
        const s = typeof v === "string" ? v : String(v);
        if (s.trim()) return { key: k, value: s.trim() };
      }
      return null;
    };

    if ((f.type || "").includes("email") || txt.includes("имейл") || txt.includes("e-mail")) {
      return pickByKeys(["email", "e_mail", "mail"]);
    }
    if ((f.type || "").includes("tel") || txt.includes("тел") || txt.includes("phone") || txt.includes("gsm")) {
      return pickByKeys(["phone", "tel", "telephone", "gsm"]);
    }
    if ((f.type || "").includes("number") || txt.includes("възраст") || txt.includes("age")) {
      return pickByKeys(["age", "years", "възраст"]);
    }
    if (txt.includes("име") || txt.includes("name")) {
      return pickByKeys(["name", "full_name", "fullname", "first_name", "last_name", "names"]);
    }
    if (txt.includes("съобщ") || txt.includes("message") || txt.includes("коментар") || txt.includes("note")) {
      return pickByKeys(["message", "comment", "note", "details"]);
    }

    const fLabel = f.label || f.aria_label || f.placeholder || f.name || f.id;
    for (const k of Object.keys(data || {})) {
      const v = (data as any)[k];
      if (v === null || v === undefined) continue;
      const s = typeof v === "string" ? v : String(v);
      if (!s.trim()) continue;

      if (labelSoftIncludes(fLabel, k) || labelSoftIncludes(txt, k)) {
        return { key: k, value: s.trim() };
      }
    }

    return null;
  }

  private matchWizardFieldValue(field: WizardScannedField, data: Record<string, unknown>): string | undefined {
    if (field.name && data[field.name] !== undefined) return String(data[field.name]);
    if (field.id && data[field.id] !== undefined) return String(data[field.id]);

    const t = this.wizardFieldText(field);

    if (field.type === "email" || /e-?mail|email|имейл|поща/.test(t)) {
      const v = (data as any).email || (data as any).e_mail;
      if (v !== undefined) return String(v);
    }

    if (field.type === "tel" || /phone|tel|телефон|мобил|gsm/.test(t)) {
      const v = (data as any).phone || (data as any).telephone || (data as any).tel;
      if (v !== undefined) return String(v);
    }

    if (/name|име|first|last|fullname|фамил/.test(t)) {
      const v = (data as any).name || (data as any).full_name || (data as any).first_name;
      if (v !== undefined) return String(v);
    }

    if (field.tag === "textarea" || /message|съобщ|забел|note|comment|описание/.test(t)) {
      const v = (data as any).message || (data as any).note || (data as any).comment;
      if (v !== undefined) return String(v);
    }

    if (/age|възраст/.test(t)) {
      const v = (data as any).age || (data as any).years || (data as any).възраст;
      if (v !== undefined) return String(v);
    }

    const fLabel = field.label || field.aria_label || field.placeholder || field.name || field.id;
    for (const k of Object.keys(data || {})) {
      const v = (data as any)[k];
      if (v === null || v === undefined) continue;
      const s = typeof v === "string" ? v : String(v);
      if (!s.trim()) continue;

      if (labelSoftIncludes(fLabel, k) || labelSoftIncludes(t, k)) {
        return s.trim();
      }
    }

    for (const k of Object.keys(data || {})) {
      if (!k) continue;
      const kk = k.toLowerCase();
      if (kk.length < 3) continue;
      if (t.includes(kk) && (data as any)[k] !== undefined) return String((data as any)[k]);
    }

    return undefined;
  }

  private async fillWizardField(page: Page, f: WizardScannedField, value: string, strictSelect: boolean): Promise<boolean> {
    const valSummary = summarizeValue(f.name || f.type, value);
    const candidates = [...(f.selector_candidates || []), f.selector].filter(Boolean);

    console.log(`[WIZARD][FILL] candidates=${candidates.length} value=${valSummary}`);

    for (const sel of candidates) {
      try {
        const loc = page.locator(sel).first();
        const count = await loc.count().catch(() => 0);
        if (count <= 0) continue;

        const visible = await loc.isVisible().catch(() => false);
        if (!visible) continue;

        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 1500 }).catch(() => {});

        if (f.tag === "select" || f.type === "select") {
          const ok = await this.smartSelectOption(page, sel, String(value), strictSelect);
          console.log(`[WIZARD][FILL][SELECT] sel=${sel} ok=${ok}`);
          if (ok) return true;
          continue;
        }

        await loc.fill(String(value), { timeout: 3000 });
        await page.keyboard.press("Tab").catch(() => {});
        await page.waitForTimeout(80).catch(() => {});
        console.log(`[WIZARD][FILL][OK] sel=${sel}`);
        return true;
      } catch (e) {
        console.log(`[WIZARD][FILL][FAIL] sel=${sel}`, e);
      }
    }

    console.log(`[WIZARD][FILL][GIVEUP] label="${f.label}"`);
    return false;
  }

  private async safeClick(page: Page, selector: string): Promise<boolean> {
    try {
      const el = await page.$(selector);
      if (!el) return false;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) return false;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 2500, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private async clickWizardNextOrSubmit(
    page: Page,
    autoSubmit: boolean
  ): Promise<{ clicked: boolean; kind: "next" | "submit" | "none"; text: string }>
  {
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
        const visible = r.width > 0 && r.height > 0;
        if (!visible) return false;
        btn.click();
        return true;
      });
      if (ok) return { clicked: true, kind: "submit", text: "type=submit" };
    } catch {}

    return { clicked: false, kind: "none", text: "" };
  }

  private async clickWizardButtonByTexts(
    page: Page,
    texts: string[],
    allowSubmitInputs = false
  ): Promise<{ clicked: boolean; text: string }>
  {
    for (const t of texts) {
      const text = (t || "").trim();
      if (!text) continue;

      const candidates = [
        `button:has-text("${text}")`,
        `a:has-text("${text}")`,
      ];
      if (allowSubmitInputs) candidates.push(`input[type="submit"][value*="${text}"]`);

      for (const sel of candidates) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;

          const disabled = await el.evaluate((n: any) => !!n.disabled).catch(() => false);
          if (disabled) continue;

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
        if (!style) return false;
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const r = (el as any).getBoundingClientRect?.();
        if (!r) return false;
        return r.width > 0 && r.height > 0;
      };

      const cssEscape = (s: string) => {
        try {
          // @ts-ignore
          return CSS.escape(s);
        } catch {
          return s.replace(/[^a-zA-Z0-9_-]/g, "\\$");
        }
      };

      const getSelector = (el: Element): string => {
        const any = el as any;
        const id = any.id ? String(any.id) : "";
        if (id) return `#${cssEscape(id)}`;
        const name = any.name ? String(any.name) : "";
        const tag = el.tagName.toLowerCase();
        if (name) return `${tag}[name="${name.replace(/\"/g, "")}"]`;
        const aria = any.getAttribute?.("aria-label") || "";
        if (aria) return `${tag}[aria-label="${aria.replace(/\"/g, "")}"]`;

        let cur: Element | null = el;
        const parts: string[] = [];
        let depth = 0;
        while (cur && depth < 5) {
          const t = cur.tagName.toLowerCase();
          const par = cur.parentElement as Element | null;
          if (!par) break;
          const siblings = Array.from(par.children as unknown as Element[]).filter((c: Element) => c.tagName === cur!.tagName);
          const idx = siblings.indexOf(cur) + 1;
          parts.unshift(`${t}:nth-of-type(${idx})`);
          cur = par;
          depth++;
          if (t === "form" || t === "main") break;
        }
        return parts.length ? parts.join(" > ") : el.tagName.toLowerCase();
      };

      const getSelectorCandidates = (el: Element): string[] => {
        const any = el as any;
        const tag = el.tagName.toLowerCase();
        const out: string[] = [];

        const id = any.id ? String(any.id) : "";
        const name = any.name ? String(any.name) : "";
        const type = (any.type || (tag === "select" ? "select" : tag)).toLowerCase();
        const ph = any.placeholder ? String(any.placeholder) : "";
        const aria = any.getAttribute?.("aria-label") ? String(any.getAttribute("aria-label")) : "";

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
        const any = el as any;
        const id = any.id ? String(any.id) : "";
        if (id) {
          const lab = document.querySelector(`label[for="${cssEscape(id)}"]`) as HTMLElement | null;
          if (lab && lab.textContent) return lab.textContent.trim();
        }
        let p: Element | null = el;
        for (let i = 0; i < 4; i++) {
          if (!p) break;
          const lab = p.querySelector?.("label") as HTMLElement | null;
          if (lab && lab.textContent) return lab.textContent.trim();
          p = p.parentElement;
        }
        const labelledby = any.getAttribute?.("aria-labelledby") || "";
        if (labelledby) {
          const t = labelledby
            .split(/\s+/)
            .map((id: string) => document.getElementById(id)?.textContent?.trim() || "")
            .filter(Boolean)
            .join(" ");
          if (t) return t;
        }
        return "";
      };

      const inputs = Array.from(document.querySelectorAll("input, textarea, select"));
      const fields = inputs
        .filter((el) => {
          const any = el as any;
          if (!isVisible(el)) return false;
          const tag = el.tagName.toLowerCase();
          if (tag === "input") {
            const type = (any.type || "").toLowerCase();
            if (["hidden", "submit", "button", "image", "reset"].includes(type)) return false;
          }
          if (any.disabled) return false;
          if (any.getAttribute?.("aria-hidden") === "true") return false;
          return true;
        })
        .slice(0, 40)
        .map((el) => {
          const any = el as any;
          const tag = el.tagName.toLowerCase() as any;
          const type = (any.type || (tag === "select" ? "select" : tag)).toLowerCase();

          const label = getLabel(el);
          const required = (() => {
            const ariaReq = (any.getAttribute?.("aria-required") || "").toString().toLowerCase() === "true";
            const dataReq = (any.getAttribute?.("data-required") || "").toString().toLowerCase() === "true";
            const star = (label || "").includes("*");
            return !!any.required || ariaReq || dataReq || star;
          })();

          return {
            tag,
            type,
            name: any.name ? String(any.name) : "",
            id: any.id ? String(any.id) : "",
            label,
            placeholder: any.placeholder ? String(any.placeholder) : "",
            aria_label: any.getAttribute?.("aria-label") ? String(any.getAttribute("aria-label")) : "",
            required,
            selector: getSelector(el),
            selector_candidates: getSelectorCandidates(el),
            options:
              tag === "select"
                ? Array.from((el as HTMLSelectElement).options || []).slice(0, 60).map((o) => ({
                    value: (o as any).value ? String((o as any).value) : "",
                    label: (o as any).label ? String((o as any).label) : (o.textContent || "").trim(),
                  }))
                : undefined,
          };
        });

      const btns: Array<{ text: string; selector: string; groupLabel: string; required: boolean }> = [];

      // Detect button-based choice groups: containers with 2+ sibling buttons
      const seenContainers = new Set<Element>();
      const submitRe = /напред|назад|next|back|prev|submit|изпрати|запази|book|reserve|резерв|close|затвори|отказ|cancel|продължи|следва|finish|готово|завърши|потвърди/i;
      // Language codes & nav elements to skip
      const langCodes = new Set(["bg", "en", "de", "fr", "es", "it", "ru", "tr", "nl", "pl", "ro", "cs", "el", "pt", "ar", "zh", "ja", "ko"]);
      const isLangSwitcher = (btns: Element[]) => {
        if (btns.length < 2 || btns.length > 5) return false;
        return btns.every((b) => {
          const t = ((b as any).textContent || "").trim().toLowerCase();
          return t.length <= 3 && (langCodes.has(t) || /^[a-z]{2}(-[a-z]{2})?$/.test(t));
        });
      };

      document.querySelectorAll("button, [role='button']").forEach((btn) => {
        if (!isVisible(btn)) return;
        const parent = btn.parentElement;
        if (!parent || seenContainers.has(parent)) return;

        // Get sibling buttons in this container
        const siblingBtns = Array.from(parent.querySelectorAll(":scope > button, :scope > * > button"))
          .filter((b) => isVisible(b));

        if (siblingBtns.length < 2) return;

        // Filter out nav/submit buttons
        const optionBtns = siblingBtns.filter((b) => {
          const t = ((b as any).textContent || "").trim();
          return t.length >= 1 && t.length <= 30 && !submitRe.test(t);
        });

        if (optionBtns.length < 2) return;

        // Skip language switchers (BG/EN, etc.)
        if (isLangSwitcher(optionBtns)) return;

        // Skip buttons inside nav/header elements
        const closestNav = parent.closest("nav, header, [role='navigation']");
        if (closestNav) return;

        seenContainers.add(parent);

        // Find group label from preceding element or parent
        let groupLabel = "";
        const prevSib = parent.previousElementSibling as HTMLElement | null;
        if (prevSib) {
          const t = (prevSib.textContent || "").trim();
          // Skip labels that look like emails, URLs, or phone numbers
          const looksLikeData = /@/.test(t) || /^https?:/.test(t) || /^\+?\d[\d\s()-]{6,}$/.test(t);
          if (t.length >= 2 && t.length <= 60 && !looksLikeData) groupLabel = t;
        }
        if (!groupLabel) {
          // Try label inside parent's parent
          const grandParent = parent.parentElement;
          if (grandParent) {
            const lab = grandParent.querySelector("label, [class*='label']") as HTMLElement | null;
            if (lab) {
              const t = (lab.textContent || "").trim();
              const looksLikeData = /@/.test(t) || /^https?:/.test(t) || /^\+?\d[\d\s()-]{6,}$/.test(t);
              if (t.length >= 2 && t.length <= 60 && !looksLikeData) groupLabel = t;
            }
          }
        }

        const isRequired = /\*|задължително|required/i.test(groupLabel);
        const cleanLabel = groupLabel.replace(/\s*\*\s*$/, "").trim();

        optionBtns.forEach((b) => {
          const text = ((b as any).textContent || "").trim();
          btns.push({
            text,
            selector: getSelector(b),
            groupLabel: cleanLabel || "button_choice",
            required: isRequired,
          });
        });
      });

      // Also detect radio-like buttons: [role="radio"], button[aria-pressed]
      document.querySelectorAll('[role="radio"], button[aria-pressed]').forEach((btn) => {
        if (!isVisible(btn)) return;
        const text = ((btn as any).textContent || "").trim();
        if (!text || text.length < 1 || text.length > 30) return;
        if (submitRe.test(text)) return;

        const parent = btn.parentElement;
        let groupLabel = "";
        if (parent) {
          const prevSib = parent.previousElementSibling as HTMLElement | null;
          if (prevSib) {
            const t = (prevSib.textContent || "").trim();
            if (t.length >= 2 && t.length <= 60) groupLabel = t;
          }
        }

        const isRequired = /\*|задължително|required/i.test(groupLabel);
        const cleanLabel = groupLabel.replace(/\s*\*\s*$/, "").trim();

        // Avoid duplicate
        if (btns.some((b) => b.selector === getSelector(btn))) return;

        btns.push({
          text,
          selector: getSelector(btn),
          groupLabel: cleanLabel || "button_choice",
          required: isRequired,
        });
      });

      // ✅ NEW: Detect real <input type="radio"> groups (often hidden, with visible parent containers)
      const radiosByName = new Map<string, Element[]>();
      document.querySelectorAll('input[type="radio"]').forEach((radio) => {
        const name = (radio as any).name || "";
        if (!name) return;
        if (!radiosByName.has(name)) radiosByName.set(name, []);
        radiosByName.get(name)!.push(radio);
      });

      for (const [rName, radios] of radiosByName) {
        if (radios.length < 2) continue;
        const radioOptions: Array<{ text: string; selector: string }> = [];

        for (const radio of radios) {
          // Find the nearest visible clickable ancestor (radio itself may be hidden/tiny)
          let clickTarget: Element | null = radio;
          for (let d = 0; d < 6; d++) {
            if (!clickTarget) break;
            if (isVisible(clickTarget)) {
              const r = (clickTarget as any).getBoundingClientRect?.();
              if (r && r.width > 30 && r.height > 20) break;
            }
            clickTarget = clickTarget.parentElement;
          }
          if (!clickTarget || !isVisible(clickTarget)) continue;
          const text = (clickTarget.textContent || "").trim();
          if (!text || text.length < 1 || text.length > 80 || submitRe.test(text)) continue;
          const sel = getSelector(clickTarget);
          if (btns.some((b) => b.selector === sel)) continue;
          radioOptions.push({ text, selector: sel });
        }

        if (radioOptions.length < 2) continue;

        // Find group label
        let groupLabel = "";
        let groupContainer = radios[0].parentElement;
        for (let d = 0; d < 5; d++) {
          if (!groupContainer) break;
          if (radios.every((r) => groupContainer!.contains(r))) break;
          groupContainer = groupContainer.parentElement;
        }
        if (groupContainer) {
          // Check preceding sibling of the container
          const prevSib = groupContainer.previousElementSibling as HTMLElement | null;
          if (prevSib) {
            const t = (prevSib.textContent || "").trim();
            if (t.length >= 2 && t.length <= 80 && !/@|^https?:/.test(t)) groupLabel = t;
          }
          // Try children of parent that come before the group container
          if (!groupLabel && groupContainer.parentElement) {
            for (const child of Array.from(groupContainer.parentElement.children)) {
              if (child === groupContainer) break;
              const t = (child.textContent || "").trim();
              if (t.length >= 2 && t.length <= 80 && !/@|^https?:/.test(t)) groupLabel = t;
            }
          }
        }

        const isReq = /\*|задължително|required/i.test(groupLabel);
        const cleanLbl = groupLabel.replace(/\s*\*\s*$/, "").trim();
        for (const opt of radioOptions) {
          btns.push({ text: opt.text, selector: opt.selector, groupLabel: cleanLbl || ("radio_" + rName), required: isReq });
        }
      }

      // ✅ NEW: Detect styled div choice groups (clickable divs with border/rounded styling)
      // Common pattern: question label → container with 2-6 sibling divs, each short text, styled as choices
      const seenDivGroups = new Set<Element>();

      // Helper: find choice-like sibling groups starting from any styled div
      const findGroupLabel = (container: Element): { label: string; required: boolean } => {
        let groupLabel = "";
        const prevSib = container.previousElementSibling as HTMLElement | null;
        if (prevSib) {
          const t = (prevSib.textContent || "").trim();
          if (t.length >= 2 && t.length <= 80 && !/@|^https?:|^\+?\d[\d\s()-]{6,}$/.test(t)) groupLabel = t;
        }
        if (!groupLabel && container.parentElement) {
          for (const child of Array.from(container.parentElement.children)) {
            if (child === container) break;
            const t = (child.textContent || "").trim();
            if (t.length >= 2 && t.length <= 80 && !/@|^https?:/.test(t)) groupLabel = t;
          }
        }
        const isReq = /\*|задължително|required/i.test(groupLabel);
        const cleanLbl = groupLabel.replace(/\s*\*\s*$/, "").trim();
        return { label: cleanLbl, required: isReq };
      };

      // Strategy: scan all visible elements that have border+rounded or cursor-pointer styling
      // and check if they have 2+ similar siblings
      document.querySelectorAll("div, label, li, span, a").forEach((el) => {
        if (!isVisible(el)) return;
        const parent = el.parentElement;
        if (!parent || seenDivGroups.has(parent)) return;
        if (parent.closest("nav, header, [role='navigation'], form > div:only-child")) return;

        // Check if this element looks like a choice option (has border or specific styling)
        const cls = ((el as any).className || "").toString();
        const style = window.getComputedStyle(el);
        const hasBorder = (cls.includes("border") || cls.includes("rounded") ||
          (style.borderWidth && parseFloat(style.borderWidth) >= 1) ||
          cls.includes("cursor-pointer") || cls.includes("hover:") ||
          style.cursor === "pointer");
        if (!hasBorder) return;

        // Find similar siblings
        const siblings = Array.from(parent.children).filter((child) => {
          if (!isVisible(child)) return false;
          if (child.tagName.toLowerCase() === "button") return false; // already handled
          const cCls = ((child as any).className || "").toString();
          const cStyle = window.getComputedStyle(child);
          return (cCls.includes("border") || cCls.includes("rounded") ||
            (cStyle.borderWidth && parseFloat(cStyle.borderWidth) >= 1) ||
            cCls.includes("cursor-pointer") || cStyle.cursor === "pointer");
        });

        if (siblings.length < 2 || siblings.length > 10) return;

        // All should have short text
        const allShort = siblings.every((s) => {
          const t = (s.textContent || "").trim();
          return t.length >= 1 && t.length <= 80;
        });
        if (!allShort) return;

        // Filter out submit-like
        const validOpts = siblings.filter((s) => {
          const t = (s.textContent || "").trim();
          return !submitRe.test(t);
        });
        if (validOpts.length < 2) return;

        // Skip lang switchers
        if (isLangSwitcher(validOpts)) return;

        seenDivGroups.add(parent);

        const { label: gLabel, required: gReq } = findGroupLabel(parent);

        for (const opt of validOpts) {
          const text = (opt.textContent || "").trim();
          const sel = getSelector(opt);
          if (btns.some((b) => b.selector === sel)) continue;
          btns.push({ text, selector: sel, groupLabel: gLabel || "div_choice", required: gReq });
        }
      });

      // Group buttons by groupLabel
      const choiceGroups: Array<{
        name: string;
        label: string;
        required: boolean;
        type: "button_group";
        options: Array<{ text: string; selector: string }>;
      }> = [];

      const groupMap = new Map<string, typeof btns>();
      for (const b of btns) {
        const key = b.groupLabel;
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key)!.push(b);
      }

      for (const [name, items] of groupMap) {
        choiceGroups.push({
          name,
          label: name,
          required: items.some((i) => i.required),
          type: "button_group",
          options: items.map((i) => ({ text: i.text, selector: i.selector })),
        });
      }

      return { fields, choices: btns, choiceGroups };
    });
  }

  private async getWizardDomSignature(page: Page): Promise<string> {
    try {
      return await page.evaluate(() => {
        const title = document.title || "";
        const h1 = (document.querySelector("h1")?.textContent || "").trim();
        const step = (document.querySelector("[aria-current='step']")?.textContent || "").trim();
        const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
          .filter((el: any) => {
            const r = (el as any).getBoundingClientRect?.();
            if (!r) return false;
            const style = window.getComputedStyle(el as any);
            if (style.display === "none" || style.visibility === "hidden") return false;
            return r.width > 0 && r.height > 0;
          })
          .slice(0, 25)
          .map((el: any) => `${(el.tagName || "").toLowerCase()}:${(el.type || "").toLowerCase()}:${el.name || ""}:${el.id || ""}`)
          .join("|");
        return `${location.pathname}||${title}||${h1}||${step}||${inputs}`;
      });
    } catch {
      return `sig:${Date.now()}`;
    }
  }

  private async waitForWizardStepChange(page: Page, beforeSig: string): Promise<void> {
    try {
      await page.waitForFunction(
        (sig: string) => {
          const title = document.title || "";
          const h1 = (document.querySelector("h1")?.textContent || "").trim();
          const step = (document.querySelector("[aria-current='step']")?.textContent || "").trim();
          const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
            .filter((el: any) => {
              const r = (el as any).getBoundingClientRect?.();
              if (!r) return false;
              const style = window.getComputedStyle(el as any);
              if (style.display === "none" || style.visibility === "hidden") return false;
              return r.width > 0 && r.height > 0;
            })
            .slice(0, 25)
            .map((el: any) => `${(el.tagName || "").toLowerCase()}:${(el.type || "").toLowerCase()}:${el.name || ""}:${el.id || ""}`)
            .join("|");
          const cur = `${location.pathname}||${title}||${h1}||${step}||${inputs}`;
          return cur !== sig;
        },
        beforeSig,
        { timeout: 9000 }
      );
    } catch {
      await page.waitForTimeout(900).catch(() => {});
    }
  }

  // ✅ Count visible UNFILLED elements in the DOM: empty inputs AND unselected button groups
  // Used after clicking Next to detect new wizard steps — if anything needs interaction, it's NOT success
  private async countUnfilledVisibleFields(page: Page): Promise<{ count: number; labels: string[] }> {
    try {
      return await page.evaluate(() => {
        const isVisible = (el: Element) => {
          const style = window.getComputedStyle(el as any);
          if (!style) return false;
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          const r = (el as any).getBoundingClientRect?.();
          return !!r && r.width > 0 && r.height > 0;
        };

        const getLabel = (el: Element) => {
          const any = el as any;
          const id = any.id ? String(any.id) : "";
          if (id) {
            const lab = document.querySelector(`label[for="${id}"]`) as HTMLElement | null;
            if (lab && lab.textContent) return lab.textContent.trim();
          }
          let p: Element | null = el;
          for (let i = 0; i < 3; i++) {
            if (!p) break;
            p = p.parentElement;
            if (p) {
              const lab = p.querySelector?.("label") as HTMLElement | null;
              if (lab && lab.textContent) return lab.textContent.trim();
            }
          }
          return any.placeholder || any.name || any.type || "field";
        };

        const pending: string[] = [];

        // 1) Empty input / textarea / select fields
        document.querySelectorAll("input, textarea, select").forEach((el: any) => {
          if (!isVisible(el)) return;
          const type = (el.type || "").toLowerCase();
          if (["hidden", "submit", "button", "image", "reset", "file", "checkbox", "radio"].includes(type)) return;
          if (el.disabled) return;
          if (el.getAttribute?.("aria-hidden") === "true") return;
          const val = (el.value || "").toString().trim();
          if (!val) pending.push(getLabel(el));
        });

        // 2) Unselected button choice groups
        const submitRe = /напред|назад|next|back|prev|submit|изпрати|запази|book|reserve|close|затвори|отказ|cancel|продължи|следва|finish|готово|завърши|потвърди/i;
        const langCodes = new Set(["bg", "en", "de", "fr", "es", "it", "ru", "tr", "nl", "pl", "ro", "cs", "el", "pt", "ar", "zh", "ja", "ko"]);
        const seenContainers = new Set<Element>();

        document.querySelectorAll("button, [role='button']").forEach((btn) => {
          if (!isVisible(btn)) return;
          const parent = btn.parentElement;
          if (!parent || seenContainers.has(parent)) return;

          // Skip buttons inside nav/header
          if (parent.closest("nav, header, [role='navigation']")) return;

          // Find sibling buttons
          const siblings = Array.from(parent.querySelectorAll(":scope > button, :scope > * > button"))
            .filter((b) => isVisible(b));
          if (siblings.length < 2) return;

          // Filter out nav/submit
          const optBtns = siblings.filter((b) => {
            const t = ((b as any).textContent || "").trim();
            return t.length >= 1 && t.length <= 30 && !submitRe.test(t);
          });
          if (optBtns.length < 2) return;

          // Skip language switchers (BG/EN, etc.)
          const allLang = optBtns.every((b) => {
            const t = ((b as any).textContent || "").trim().toLowerCase();
            return t.length <= 3 && (langCodes.has(t) || /^[a-z]{2}(-[a-z]{2})?$/.test(t));
          });
          if (allLang) return;

          seenContainers.add(parent);

          // Check if any button in this group is already selected
          const hasSelected = optBtns.some((b: any) => {
            // Common selection indicators
            if (b.getAttribute("aria-pressed") === "true") return true;
            if (b.getAttribute("aria-checked") === "true") return true;
            if (b.getAttribute("data-state") === "on" || b.getAttribute("data-state") === "active") return true;
            const cls = (b.className || "").toLowerCase();
            if (/\bactive\b|\bselected\b|\bchosen\b|\bchecked\b/.test(cls)) return true;
            // Check computed style difference — selected buttons often have different bg
            const style = window.getComputedStyle(b);
            const bgColor = style.backgroundColor || "";
            // If button has a non-white/non-transparent bg, it might be selected
            // But we can't be sure, so also check border/outline
            if (b.getAttribute("data-selected") === "true") return true;
            return false;
          });

          if (!hasSelected) {
            // Find group label
            let groupLabel = "";
            const prevSib = parent.previousElementSibling as HTMLElement | null;
            if (prevSib) {
              const t = (prevSib.textContent || "").trim();
              const looksLikeData = /@/.test(t) || /^https?:/.test(t) || /^\+?\d[\d\s()-]{6,}$/.test(t);
              if (t.length >= 2 && t.length <= 60 && !looksLikeData) groupLabel = t;
            }
            const optTexts = optBtns.map((b: any) => ((b as any).textContent || "").trim()).join("/");
            pending.push(groupLabel ? `${groupLabel} (${optTexts})` : `Избор: ${optTexts}`);
          }
        });

        // 3) Unselected real <input type="radio"> groups
        const radiosByName2 = new Map<string, Element[]>();
        document.querySelectorAll('input[type="radio"]').forEach((radio) => {
          const name = (radio as any).name || "";
          if (!name) return;
          if (!radiosByName2.has(name)) radiosByName2.set(name, []);
          radiosByName2.get(name)!.push(radio);
        });
        for (const [, radios] of radiosByName2) {
          if (radios.length < 2) continue;
          if (radios.some((r: any) => r.checked)) continue;
          let groupLabel = "";
          let gc = radios[0].parentElement;
          for (let i = 0; i < 5 && gc; i++) {
            if (radios.every((r) => gc!.contains(r))) break;
            gc = gc.parentElement;
          }
          if (gc?.previousElementSibling) {
            const t = (gc.previousElementSibling.textContent || "").trim();
            if (t.length >= 2 && t.length <= 80) groupLabel = t;
          }
          const optTexts = radios.map((r) => {
            let el: Element | null = r;
            for (let i = 0; i < 4; i++) { if (!el) break; if (isVisible(el) && (el as any).getBoundingClientRect().width > 30) break; el = el.parentElement; }
            return (el?.textContent || "").trim();
          }).filter(Boolean).join("/");
          pending.push(groupLabel ? `${groupLabel} (${optTexts})` : `Избор: ${optTexts}`);
        }

        // 4) Unselected styled div choice groups
        const seenDivGrp = new Set<Element>();
        document.querySelectorAll("div, label, li, span").forEach((el) => {
          if (!isVisible(el)) return;
          const parent = el.parentElement;
          if (!parent || seenDivGrp.has(parent) || seenContainers.has(parent)) return;
          if (parent.closest("nav, header, [role='navigation']")) return;
          const cls = ((el as any).className || "").toString();
          const style = window.getComputedStyle(el);
          const hasBorder = cls.includes("border") || cls.includes("rounded") ||
            (style.borderWidth && parseFloat(style.borderWidth) >= 1) || style.cursor === "pointer";
          if (!hasBorder) return;
          const siblings = Array.from(parent.children).filter((c) => {
            if (!isVisible(c)) return false;
            if (c.tagName.toLowerCase() === "button") return false;
            const cc = ((c as any).className || "").toString();
            const cs = window.getComputedStyle(c);
            return cc.includes("border") || cc.includes("rounded") ||
              (cs.borderWidth && parseFloat(cs.borderWidth) >= 1) || cs.cursor === "pointer";
          });
          if (siblings.length < 2 || siblings.length > 10) return;
          if (!siblings.every((s) => (s.textContent || "").trim().length <= 80)) return;
          const valid = siblings.filter((s) => !submitRe.test((s.textContent || "").trim()));
          if (valid.length < 2) return;
          seenDivGrp.add(parent);
          // Check if any is selected
          const hasSelected = valid.some((o: any) => {
            if (o.getAttribute("aria-pressed") === "true" || o.getAttribute("aria-checked") === "true") return true;
            if (o.getAttribute("data-state") === "on" || o.getAttribute("data-state") === "active") return true;
            const c = (o.className || "").toLowerCase();
            if (/\bactive\b|\bselected\b|\bchosen\b|\bchecked\b/.test(c)) return true;
            if (o.getAttribute("data-selected") === "true") return true;
            const radio = o.querySelector('input[type="radio"]');
            if (radio && (radio as any).checked) return true;
            return false;
          });
          if (hasSelected) return;
          let gLabel = "";
          if (parent.previousElementSibling) {
            const t = (parent.previousElementSibling.textContent || "").trim();
            if (t.length >= 2 && t.length <= 80) gLabel = t;
          }
          const optTexts = valid.map((o: any) => (o.textContent || "").trim()).join("/");
          pending.push(gLabel ? `${gLabel} (${optTexts})` : `Избор: ${optTexts}`);
        });

        return { count: pending.length, labels: pending.slice(0, 15) };
      });
    } catch {
      return { count: 0, labels: [] };
    }
  }

  private async inferCurrentBookingStepNeeds(page: Page): Promise<{
    missing_required: string[];
    current_step: string;
    payment_required: boolean;
    can_continue: boolean;
  }> {
    try {
      const unfilled = await this.countUnfilledVisibleFields(page);
      const scanned = await this.scanWizardStep(page).catch(() => ({
        fields: [],
        choices: [],
        choiceGroups: [],
      }));

      const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
      const currentUrl = page.url().toLowerCase();

      const paymentRequired =
        /card|credit card|cvv|expiry|payment|pay now|checkout|stripe|плащ|плащане|карта/.test(bodyText) ||
        /payment|checkout|stripe|pay/.test(currentUrl);

      const out: string[] = [];
      const seen = new Set<string>();

      const push = (labelRaw: string) => {
        const label = String(labelRaw || "").trim();
        if (!label) return;
        const key = label.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(label);
      };

      for (const lbl of unfilled.labels || []) push(lbl);

      for (const f of scanned.fields || []) {
        if (!f?.required) continue;
        const label =
          String(f.label || f.aria_label || f.placeholder || f.name || f.id || "").trim();
        if (!label) continue;
        push(label);
      }

      for (const group of scanned.choiceGroups || []) {
        if (!group?.required) continue;
        const groupLabel =
          String(group.label || group.name || "").trim() ||
          (Array.isArray(group.options) ? group.options.map((o: any) => o.text).filter(Boolean).join(" / ") : "");
        if (!groupLabel) continue;
        push(groupLabel);
      }

      console.log(
        `[RESERVATION][STEP-NEEDS] url=${page.url()} payment=${paymentRequired} missing=${out.join(" | ") || "none"}`
      );

      return {
        missing_required: out.slice(0, 20),
        current_step: paymentRequired ? "payment" : "reserve",
        payment_required: paymentRequired,
        can_continue: out.length === 0,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[RESERVATION][STEP-NEEDS][ERROR] ${msg}`);
      return {
        missing_required: [],
        current_step: "reserve",
        payment_required: false,
        can_continue: true,
      };
    }
  }

  // ✅ stricter success: require success keywords AND no visible inputs/selects/textarea OR URL indicates thanks
  private async detectWizardSuccess(page: Page): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        const url = (location.href || "").toLowerCase();
        const urlSuccess = ["thank", "thanks", "success", "submitted", "thank-you", "blagodar", "благодар"].some((x) => url.includes(x));

        const txt = (document.body?.innerText || "").toLowerCase();
        const hits = ["благодар", "успеш", "изпрат", "thank you", "success", "submitted"];
        const textSuccess = hits.some((h) => txt.includes(h));

        const isVisible = (el: Element) => {
          const style = window.getComputedStyle(el as any);
          if (!style) return false;
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          const r = (el as any).getBoundingClientRect?.();
          return !!r && r.width > 0 && r.height > 0;
        };

        const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
          .filter((el: any) => {
            if (!isVisible(el)) return false;
            const tag = (el.tagName || "").toLowerCase();
            if (tag === "input") {
              const type = (el.type || "").toLowerCase();
              if (["hidden", "submit", "button", "image", "reset"].includes(type)) return false;
            }
            if (el.disabled) return false;
            if (el.getAttribute?.("aria-hidden") === "true") return false;
            return true;
          });

        // If there are still visible form fields, don't call it success unless URL is clearly a thank-you page
        if (inputs.length > 0 && !urlSuccess) return false;

        return Boolean(urlSuccess || textSuccess);
      });
    } catch {
      return false;
    }
  }

  private async fillSingleField(page: Page, f: FormSchemaField, value: string, strictSelect: boolean): Promise<string | null> {
    const selectors = [
      ...(f.selector_candidates || []),
      f.name ? `[name="${f.name}"]` : "",
      f.name ? `#${f.name}` : "",
    ].filter(Boolean);

    const valSummary = summarizeValue(f.name || f.type, value);
    console.log(`[FILL] target="${f.label || f.name}" value=${valSummary} candidates=${selectors.length}`);

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (!el) {
          console.log(`[FILL][MISS] ${sel}`);
          continue;
        }

        const visible = await el.isVisible().catch(() => false);
        if (!visible && f.tag !== "select" && f.type !== "select") {
          console.log(`[FILL][HIDDEN] ${sel}`);
          continue;
        }

        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 1200 }).catch(() => {});

        if (f.tag === "select" || f.type === "select") {
          const ok = await this.smartSelectOption(page, sel, String(value), strictSelect);
          console.log(`[FILL][SELECT] ${sel} ok=${ok}`);
          if (ok) return sel;
          continue;
        }

        if (f.type === "file") continue;

        await page.fill(sel, String(value), { timeout: 3000 });
        await page.keyboard.press("Tab").catch(() => {});
        await page.waitForTimeout(100).catch(() => {});
        console.log(`[FILL][OK] ${sel}`);
        return sel;
      } catch (e) {
        console.log(`[FILL][FAIL] ${sel}`, e);
      }
    }

    console.log(`[FILL][GIVEUP] target="${f.label || f.name}"`);
    return null;
  }

  private async smartSelectOption(page: Page, selectSelector: string, desired: string, strictSelect: boolean): Promise<boolean> {
    const desiredRaw = String(desired || "").trim();
    const wanted = normSelectText(desiredRaw);

    const options = await page.evaluate<
      { value: string; label: string }[],
      { sel: string }
    >(({ sel }: { sel: string }) => {
      const el = document.querySelector(sel) as HTMLSelectElement | null;
      if (!el) return [];
      return Array.from(el.options).map((o: HTMLOptionElement) => ({
        value: (o.value || "").toString(),
        label: (o.textContent || "").trim()
      }));
    }, { sel: selectSelector });

    console.log(`[SELECT] selector=${selectSelector} desired="${desiredRaw}" options=${options.length} strict=${strictSelect}`);
    for (const o of options.slice(0, 20)) {
      console.log(`[SELECT][OPT] value="${o.value}" label="${o.label}"`);
    }

    const nonEmpty = options.filter((o) => (o.value || "").trim() !== "");

    if (/^\d+$/.test(wanted)) {
      const idx = Math.max(1, parseInt(wanted, 10));
      const candidate = nonEmpty[idx - 1];
      if (candidate) {
        const ok = await page.evaluate<boolean, { sel: string; v: string }>(
          ({ sel, v }) => {
            const el = document.querySelector(sel) as HTMLSelectElement | null;
            if (!el) return false;
            el.value = v;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          },
          { sel: selectSelector, v: candidate.value }
        );
        console.log(`[SELECT] picked(numeric) value="${candidate.value}" label="${candidate.label}" ok=${ok}`);
        return ok;
      }
    }

    let picked =
      options.find((o) => normSelectText(o.value) === wanted) ||
      options.find((o) => normSelectText(o.label) === wanted) ||
      (wanted ? options.find((o) => normSelectText(o.label).includes(wanted)) : undefined) ||
      (wanted ? options.find((o) => normSelectText(o.value).includes(wanted)) : undefined);

    if (!picked) {
      const intent = pickPlanIntent(desiredRaw);
      if (intent) {
        let best: { opt: { value: string; label: string }; score: number } | null = null;
        for (const o of nonEmpty) {
          const score = planOptionScore(o, intent);
          if (!best || score > best.score) best = { opt: o, score };
        }
        if (best && best.score >= 80) picked = best.opt;
      }
    }

    if (!picked && strictSelect) {
      console.log(`[SELECT] strict_select=ON -> no match, returning false`);
      return false;
    }

    if (!picked) {
      picked = nonEmpty[0];
    }

    if (!picked || !String(picked.value || "").trim()) return false;

    const ok = await page.evaluate<boolean, { sel: string; v: string }>(
      ({ sel, v }) => {
        const el = document.querySelector(sel) as HTMLSelectElement | null;
        if (!el) return false;
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      { sel: selectSelector, v: picked.value }
    );

    console.log(`[SELECT] picked value="${picked.value}" label="${picked.label}" ok=${ok}`);
    return ok;
  }

  private async uploadFile(
    page: Page,
    fields: FormSchemaField[],
    file: NonNullable<FillFormRequest["file"]>
  ): Promise<boolean> {
    const fs = await import("fs");
    const tmpPath = `/tmp/upload_${Date.now()}_${file.filename}`;

    try {
      const buffer = Buffer.from(file.base64, "base64");
      fs.writeFileSync(tmpPath, buffer);

      const fileFields = fields.filter(f => f.type === "file" || f.tag === "input");
      const target = fileFields.find(f => f.name === file.field_name) || fileFields[0];

      const selectors: string[] = [];
      if (target) {
        selectors.push(...(target.selector_candidates || []));
        if (target.name) selectors.push(`input[name="${target.name}"]`);
      }
      selectors.push('input[type="file"]');

      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          await (el as any).setInputFiles(tmpPath);
          try { fs.unlinkSync(tmpPath); } catch {}
          return true;
        } catch {}
      }

      try { fs.unlinkSync(tmpPath); } catch {}
      return false;
    } catch {
      try { fs.unlinkSync(tmpPath); } catch {}
      return false;
    }
  }

  private async clickBySelectors(page: Page, selectors: string[], debug: string[]): Promise<boolean> {
    for (const sel of selectors) {
      if (!sel) continue;
      try {
        const el = await page.$(sel);
        if (!el) { debug.push(`miss:${sel}`); continue; }
        const visible = await el.isVisible().catch(() => false);
        if (!visible) { debug.push(`hidden:${sel}`); continue; }
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 3000, force: true });
        debug.push(`clicked:${sel}`);
        return true;
      } catch {
        debug.push(`fail:${sel}`);
      }
    }
    return false;
  }

  private async clickByTextHeuristic(page: Page, text: string, debug: string[]): Promise<boolean> {
    const t = (text || "").trim();
    if (!t) return false;

    const candidates = [
      `button:has-text("${t}")`,
      `a:has-text("${t}")`,
      `input[type="submit"][value*="${t}"]`,
      `text="${t}"`,
    ];

    for (const sel of candidates) {
      try {
        await page.click(sel, { timeout: 2500, force: true });
        debug.push(`clicked_text:${sel}`);
        return true;
      } catch {
        debug.push(`fail_text:${sel}`);
      }
    }
    return false;
  }

  private async clickSubmitWithinClosestForm(page: Page, anchorSelector: string, debug: string[]): Promise<boolean> {
    const ok = await page.evaluate<boolean, { sel: string }>(
      ({ sel }) => {
        const anchor = document.querySelector(sel) as HTMLElement | null;
        if (!anchor) return false;
        const form = anchor.closest("form") as HTMLFormElement | null;
        if (!form) return false;

        const btn =
          (form.querySelector('button[type="submit"]') as HTMLElement | null) ||
          (form.querySelector('input[type="submit"]') as HTMLElement | null);

        if (btn) { btn.click(); return true; }

        const anyForm: any = form as any;
        if (typeof anyForm.requestSubmit === "function") {
          anyForm.requestSubmit();
          return true;
        }
        form.submit();
        return true;
      },
      { sel: anchorSelector }
    );

    debug.push(ok ? `closest_form:ok:${anchorSelector}` : `closest_form:miss:${anchorSelector}`);
    return ok;
  }

  private async getInvalidFields(page: Page): Promise<string[]> {
    const invalid = await page
      .evaluate<string[]>(() => {
        const els = Array.from(document.querySelectorAll("input:invalid, textarea:invalid, select:invalid")) as any[];
        return els.slice(0, 20).map(el => el.name || el.id || el.getAttribute("aria-label") || el.tagName.toLowerCase());
      })
      .catch(() => []);
    return Array.isArray(invalid) ? invalid : [];
  }

  private async trySubmitUniversal(
    page: Page,
    schema?: FormSchemaRow,
    filledSelectors: string[] = []
  ): Promise<{ attempted: boolean; clicked: boolean; method: string; debug: string[] }> {
    const debug: string[] = [];
    const attempted = true;

    for (const a of filledSelectors.slice(0, 3)) {
      const ok = await this.clickSubmitWithinClosestForm(page, a, debug);
      if (ok) {
        await page.waitForTimeout(700).catch(() => {});
        return { attempted, clicked: true, method: "closest_form", debug };
      }
    }

    const schemaSelectors = schema?.schema.submit?.selector_candidates || [];
    if (schemaSelectors.length) {
      const ok = await this.clickBySelectors(page, schemaSelectors, debug);
      if (ok) {
        await page.waitForTimeout(700).catch(() => {});
        return { attempted, clicked: true, method: "schema.selector_candidates", debug };
      }
    }

    const submitText = (schema?.schema.submit?.text || "").trim();
    if (submitText) {
      const ok = await this.clickByTextHeuristic(page, submitText, debug);
      if (ok) {
        await page.waitForTimeout(700).catch(() => {});
        return { attempted, clicked: true, method: "schema.text", debug };
      }
    }

    const universalSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Изпрати")',
      'button:has-text("Submit")',
      'button:has-text("Send")',
    ];
    {
      const ok = await this.clickBySelectors(page, universalSelectors, debug);
      if (ok) {
        await page.waitForTimeout(700).catch(() => {});
        return { attempted, clicked: true, method: "universal_selectors", debug };
      }
    }

    try {
      const ok = await page.evaluate<boolean>(() => {
        const form = document.querySelector("form") as any;
        if (!form) return false;
        if (typeof form.requestSubmit === "function") { form.requestSubmit(); return true; }
        form.submit(); return true;
      });

      if (ok) {
        debug.push("requestSubmit()");
        await page.waitForTimeout(700).catch(() => {});
        return { attempted, clicked: true, method: "requestSubmit", debug };
      }
    } catch {
      debug.push("fail_requestSubmit()");
    }

    return { attempted, clicked: false, method: "none", debug };
  }

  private async quickObserve(page: Page): Promise<JsonObj> {
    try {
      return await page.evaluate(() => {
        const text = (document.body?.innerText || "").slice(0, 1200);
        return {
          url: window.location.href,
          title: document.title,
          snippet: text.slice(0, 300).replace(/\s+/g, " "),
        };
      });
    } catch {
      return { url: "", title: "", snippet: "" };
    }
  }

  async loadSchemasForApi(sessionId: string): Promise<FormSchemaRow[]> {
    return this.loadFormSchemas(sessionId);
  }

   getSessionByDbSessionId(dbSessionId: string): HotSession | null {
    for (const [, s] of this.sessions) {
      if (s.sessionId === dbSessionId) return s;
    }
    return null;
  }

  private pickBestAvailabilitySchema(schemas: FormSchemaRow[]): FormSchemaRow | undefined {
    const rows = Array.isArray(schemas) ? schemas : [];

    const score = (s: FormSchemaRow): number => {
      let points = 0;

      const kind = String(s?.kind || "").toLowerCase();
      const url = String(s?.url || "").toLowerCase();
      const uiType = String((s?.schema as any)?.ui_type || "").toLowerCase();
      const vendor = String((s?.schema as any)?.booking_vendor || (s?.schema as any)?.vendor || "").toLowerCase();
      const iframeSrc = String((s?.schema as any)?.iframe_src || (s?.schema as any)?.src || "");
      const dateInputs = Array.isArray((s?.schema as any)?.date_inputs) ? (s?.schema as any)?.date_inputs : [];
      const guestFields = Array.isArray((s?.schema as any)?.guest_fields) ? (s?.schema as any)?.guest_fields : [];
      const actionButtons = Array.isArray((s?.schema as any)?.action_buttons) ? (s?.schema as any)?.action_buttons : [];
      const fields = Array.isArray((s?.schema as any)?.fields) ? (s?.schema as any)?.fields : [];

      if (kind === "availability") points += 100;
      if (kind === "booking_widget") points += 120;

      if (uiType.includes("iframe_booking_widget")) points += 220;
      if (vendor.includes("quendoo")) points += 160;
      if (iframeSrc.includes("quendoo")) points += 160;

      if (url.includes("/accommodation")) points += 120;
      if (url.includes("/room/")) points += 80;
      if (url === "https://jasminhotel.com/" || url.endsWith("//")) points -= 20;
      if (url.includes("/contact")) points -= 200;

      points += Math.min(dateInputs.length * 10, 40);
      points += Math.min(guestFields.length * 10, 30);
      points += Math.min(actionButtons.length * 8, 24);
      points += Math.min(fields.length * 2, 20);

      return points;
    };

    const candidates = rows
      .filter((s) => ["availability", "booking_widget", "form", "wizard"].includes(String(s?.kind || "").toLowerCase()))
      .map((s) => ({ s, score: score(s) }))
      .sort((a, b) => b.score - a.score);

    if (candidates.length) {
      console.log(
        "[RESERVATION][SCHEMA-RANKING]",
        JSON.stringify(
          candidates.slice(0, 8).map((x) => ({
            url: x.s.url,
            kind: x.s.kind,
            ui_type: (x.s.schema as any)?.ui_type || "",
            booking_vendor: (x.s.schema as any)?.booking_vendor || (x.s.schema as any)?.vendor || "",
            score: x.score,
          })),
          null,
          2
        )
      );
    }

    return candidates[0]?.s;
  }

  // ─────────────────────────────────────────────────────────
  // checkAvailability — universal hotel availability check
  // Fills date fields, clicks search, waits, returns screenshot
  // ─────────────────────────────────────────────────────────

  async checkAvailability(
    page: Page,
    schema: FormSchemaRow,
    data: Record<string, unknown>
  ): Promise<{ ok: boolean; message: string; observation?: JsonObj }> {
    const t0 = Date.now();
    console.log(`[AVAIL] Starting availability check for ${schema.url}`);

    try {
      // ── 1. Extract dates and guests from data ──────────────────
      const checkin  = this.resolveAvailDate(data, ["check_in","checkin","check-in","arrival","date_from","from","от","дата_от","пристигане"]);
      const checkout = this.resolveAvailDate(data, ["check_out","checkout","check-out","departure","date_to","to","до","дата_до","заминаване"]);
      const guests   = String(data["guests"] || data["adults"] || data["гости"] || data["възрастни"] || "2");
      const rooms    = String(data["rooms"] || data["стаи"] || "1");

      console.log(`[AVAIL] check_in=${checkin} check_out=${checkout} guests=${guests} rooms=${rooms}`);

           if (!checkin || !checkout) {
        return { ok: false, message: "Липсват дати за проверка на наличност" };
      }

      const schemaAny: any = schema?.schema || {};
      const uiType = String(schemaAny?.ui_type || "").toLowerCase();
      const iframeSrc = String(schemaAny?.iframe_src || schemaAny?.src || "");
      const vendor = String(schemaAny?.booking_vendor || schemaAny?.vendor || "unknown");

      const isIframeAvailability =
        uiType.includes("iframe_booking_widget") ||
        !!iframeSrc ||
        String(vendor).toLowerCase().includes("quendoo");

      // ── 2. Schema-first iframe availability flow ───────────────
      if (isIframeAvailability) {
        console.log(`[AVAIL] iframe schema detected ui_type=${uiType} vendor=${vendor} url=${schema.url}`);

        await this.ensureOnSchemaUrl(page, schema.url);
        await page.waitForTimeout(1200);

        const iframeResult = await this.fillIframeBookingWidget(
          page,
          iframeSrc,
          vendor,
          checkin,
          checkout,
          guests,
          rooms
        );

        return {
          ok: iframeResult.ok,
          message: iframeResult.message,
          observation: {
            type: "availability_check",
            check_in: checkin,
            check_out: checkout,
            guests,
            rooms,
            screenshot_base64: iframeResult.screenshot_base64,
            url: page.url(),
            iframe_src: iframeSrc,
            vendor,
            fill_result: {
              checkin: true,
              checkout: true,
              guests: true,
            },
            search_clicked: true,
          },
        };
      }

      // ── 3. Navigate to availability URL ───────────────────────
      await this.ensureOnSchemaUrl(page, schema.url);
      await page.waitForTimeout(1200);

      // ── 4. Try to fill date fields universally ─────────────────
      const filled = await this.fillAvailabilityDates(page, schema as any, checkin, checkout, guests, rooms);
      console.log(`[AVAIL] fillDates=${JSON.stringify(filled)}`);

      const schemaGuestFields = Array.isArray(schemaAny?.guest_fields) ? schemaAny.guest_fields : [];
      const schemaRequiresGuests =
        schemaGuestFields.length > 0 ||
        !!schemaAny?.detected_fields?.guests;

      // ── 4. Click Search / Check button ────────────────────────
      const requiredFilled =
        filled.checkin &&
        filled.checkout &&
        (!schemaRequiresGuests || filled.guests);

      if (!requiredFilled) {
        console.log(
          `[AVAIL] abort: required availability fields not filled checkin=${filled.checkin} checkout=${filled.checkout} guests=${filled.guests} schemaRequiresGuests=${schemaRequiresGuests}`
        );
        return {
          ok: false,
          message: "availability_fields_not_filled",
          observation: {
            type: "availability_check",
            check_in: checkin,
            check_out: checkout,
            guests,
            rooms,
            url: page.url(),
            fill_result: filled,
            schema_requires_guests: schemaRequiresGuests,
          },
        };
      }
      const clicked = await this.clickAvailabilitySearch(page);
      console.log(`[AVAIL] clickSearch=${clicked}`);

      if (!clicked) {
        // If we can't click search, still take screenshot — maybe page already shows results
        console.log("[AVAIL] Could not click search button, proceeding to screenshot anyway");
      }

      // ── 5. Wait for results to load ────────────────────────────
      await this.waitForAvailabilityResults(page);

      // ── 6. Take full-page screenshot ───────────────────────────
      const screenshotBase64 = await this.takeAvailabilityScreenshot(page);

      const timing = Date.now() - t0;
      console.log(`[AVAIL] Done in ${timing}ms, screenshot=${screenshotBase64.length} chars`);

      return {
        ok: true,
        message: "availability_screenshot_ready",
        observation: {
          type: "availability_check",
          check_in: checkin,
          check_out: checkout,
          guests,
          rooms,
          screenshot_base64: screenshotBase64,
          url: page.url(),
          timing_ms: timing,
          fill_result: filled,
          search_clicked: clicked,
        },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[AVAIL] Error: ${msg}`);
      // Still try to take screenshot for partial results
      try {
        const screenshotBase64 = await this.takeAvailabilityScreenshot(page);
        return {
          ok: true,
          message: "availability_screenshot_partial",
          observation: {
            type: "availability_check",
            screenshot_base64: screenshotBase64,
            error: msg,
            url: page.url(),
          },
        };
      } catch {
        return { ok: false, message: `Availability check failed: ${msg}` };
      }
    }
  }

  private resolveAvailDate(data: Record<string, unknown>, keys: string[]): string {
    for (const k of keys) {
      const v = String(data[k] || "").trim();
      if (v) return v;
    }
    // Also check case-insensitive
    const lower = Object.fromEntries(Object.entries(data).map(([k, v]) => [k.toLowerCase(), v]));
    for (const k of keys) {
      const v = String(lower[k.toLowerCase()] || "").trim();
      if (v) return v;
    }
    return "";
  }

    private async fillAvailabilityDates(
    page: Page,
    schema: FormSchemaRow,
    checkin: string,
    checkout: string,
    guests: string,
    rooms: string
  ): Promise<{ checkin: boolean; checkout: boolean; guests: boolean }> {
      const result = { checkin: false, checkout: false, guests: false };

    const schemaAny: any = schema?.schema || {};
    const schemaFields = Array.isArray(schemaAny?.fields) ? schemaAny.fields : [];
    const schemaDateInputs = Array.isArray(schemaAny?.date_inputs) ? schemaAny.date_inputs : [];
    const schemaGuestFields = Array.isArray(schemaAny?.guest_fields) ? schemaAny.guest_fields : [];

    const collectSelectors = (items: any[]): string[] => {
      const out: string[] = [];
      for (const item of items) {
        for (const sel of Array.isArray(item?.selector_candidates) ? item.selector_candidates : []) {
          const s = String(sel || "").trim();
          if (s && !out.includes(s)) out.push(s);
        }
      }
      return out;
    };

    const pickSchemaSelectors = (keywords: string[]): string[] => {
      const out: string[] = [];

      for (const f of schemaFields) {
        const hay = [
          f?.name || "",
          f?.label || "",
          f?.placeholder || "",
          f?.aria_label || "",
          f?.type || "",
          f?.autocomplete || "",
        ].join(" ").toLowerCase();

        if (!keywords.some((k) => hay.includes(k))) continue;

        for (const sel of Array.isArray(f?.selector_candidates) ? f.selector_candidates : []) {
          const s = String(sel || "").trim();
          if (s && !out.includes(s)) out.push(s);
        }
      }

      return out;
    };

    const schemaCheckinSelectors = [
      ...collectSelectors(
        schemaDateInputs.filter((f: any) => {
          const hay = `${f?.name || ""} ${f?.label || ""} ${f?.text || ""}`.toLowerCase();
          return ["check_in", "checkin", "check-in", "arrival", "from", "date_from", "пристигане", "от"].some((k) => hay.includes(k));
        })
      ),
      ...pickSchemaSelectors([
        "check_in", "checkin", "check-in", "arrival", "from", "date_from", "пристигане", "от"
      ]),
    ];

    const schemaCheckoutSelectors = [
      ...collectSelectors(
        schemaDateInputs.filter((f: any) => {
          const hay = `${f?.name || ""} ${f?.label || ""} ${f?.text || ""}`.toLowerCase();
          return ["check_out", "checkout", "check-out", "departure", "to", "date_to", "заминаване", "до"].some((k) => hay.includes(k));
        })
      ),
      ...pickSchemaSelectors([
        "check_out", "checkout", "check-out", "departure", "to", "date_to", "заминаване", "до"
      ]),
    ];

    const schemaGuestSelectors = [
      ...collectSelectors(schemaGuestFields),
      ...pickSchemaSelectors([
        "guest", "guests", "adult", "adults", "person", "pax", "възрастни", "гости"
      ]),
    ];

    const schemaRequiresGuests =
      schemaGuestFields.length > 0 ||
      schemaGuestSelectors.length > 0 ||
      !!schemaAny?.detected_fields?.guests;

    console.log("[AVAIL][SCHEMA] url=", schema?.url || "");
    console.log("[AVAIL][SCHEMA] checkin selectors=", JSON.stringify(schemaCheckinSelectors));
    console.log("[AVAIL][SCHEMA] checkout selectors=", JSON.stringify(schemaCheckoutSelectors));
    console.log("[AVAIL][SCHEMA] guest selectors=", JSON.stringify(schemaGuestSelectors));
    console.log("[AVAIL][SCHEMA] requiresGuests=", schemaRequiresGuests);

    // ── Date input selectors (schema first, then generic fallback) ──────────
    const checkinSelectors = [
      ...schemaCheckinSelectors,
      'input[name*="check_in"]', 'input[name*="checkin"]', 'input[name*="check-in"]',
      'input[name*="arrival"]', 'input[name*="from"]', 'input[name*="date_from"]',
      'input[name*="start"]', 'input[id*="check_in"]', 'input[id*="checkin"]',
      'input[id*="arrival"]', 'input[id*="from"]', 'input[id*="dateFrom"]',
      'input[placeholder*="Check-in"]', 'input[placeholder*="Arrival"]',
      'input[placeholder*="Пристигане"]', 'input[placeholder*="От"]',
      '[data-testid*="checkin"]', '[data-testid*="check-in"]', '[data-testid*="arrival"]',
    ];
    const checkoutSelectors = [
      ...schemaCheckoutSelectors,
      'input[name*="check_out"]', 'input[name*="checkout"]', 'input[name*="check-out"]',
      'input[name*="departure"]', 'input[name*="to"]', 'input[name*="date_to"]',
      'input[name*="end"]', 'input[id*="check_out"]', 'input[id*="checkout"]',
      'input[id*="departure"]', 'input[id*="to"]', 'input[id*="dateTo"]',
      'input[placeholder*="Check-out"]', 'input[placeholder*="Departure"]',
      'input[placeholder*="Заминаване"]', 'input[placeholder*="До"]',
      '[data-testid*="checkout"]', '[data-testid*="check-out"]', '[data-testid*="departure"]',
    ];
    const guestSelectors = schemaRequiresGuests
      ? [
          ...schemaGuestSelectors,
          'input[name*="guest"]', 'input[name*="adult"]', 'input[name*="person"]',
          'input[name*="pax"]', 'input[id*="guest"]', 'input[id*="adult"]',
          'select[name*="guest"]', 'select[name*="adult"]', 'select[id*="guest"]',
          'input[placeholder*="Guests"]', 'input[placeholder*="Adults"]',
          'input[placeholder*="Гости"]', 'input[placeholder*="Възрастни"]',
        ]
      : [];
    // Helper: try to fill a date input
    const tryFillDate = async (selectors: string[], value: string): Promise<boolean> => {
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const isVisible = await el.isVisible().catch(() => false);
          if (!isVisible) continue;

          // Clear and fill
          await el.click({ clickCount: 3 });
          await page.waitForTimeout(80);
          await el.fill(value);
          await page.waitForTimeout(100);

          // Some pickers need Tab or Enter to confirm
          await page.keyboard.press("Tab");
          await page.waitForTimeout(150);

          // Verify value was accepted
          const filled = await el.inputValue().catch(() => "");
          if (filled && filled !== "") {
            console.log(`[AVAIL] Filled ${sel} = ${filled}`);
            return true;
          }

          // Try type instead of fill (for masked inputs)
          await el.click({ clickCount: 3 });
          await page.keyboard.type(value, { delay: 30 });
          await page.keyboard.press("Tab");
          await page.waitForTimeout(150);
          const filled2 = await el.inputValue().catch(() => "");
          if (filled2 && filled2 !== "") {
            console.log(`[AVAIL] Typed ${sel} = ${filled2}`);
            return true;
          }
        } catch {}
      }
      return false;
    };

    result.checkin  = await tryFillDate(checkinSelectors, checkin);
    await page.waitForTimeout(200);

    // ✅ NEW: If standard fill failed, try custom datepicker
    if (!result.checkin) {
      const dpCheckinSelectors = [
        '.flatpickr-input[placeholder*="Check"]', '.flatpickr-input[placeholder*="Пристигане"]',
        '[class*="checkin"] .flatpickr-input', '[class*="arrival"] .flatpickr-input',
        'input.hasDatepicker[name*="check"]', 'input.hasDatepicker[name*="arrival"]',
        '[id*="checkin_date"]', '[id*="arrival_date"]',
      ];
      for (const sel of dpCheckinSelectors) {
        try {
          const el = await page.$(sel);
          if (!el || !(await el.isVisible().catch(() => false))) continue;
          result.checkin = await this.fillCustomDatepicker(page, sel, checkin);
          if (result.checkin) break;
        } catch {}
      }
    }

    result.checkout = await tryFillDate(checkoutSelectors, checkout);
    await page.waitForTimeout(200);

    // ✅ NEW: If standard fill failed, try custom datepicker for checkout
    if (!result.checkout) {
      const dpCheckoutSelectors = [
        '.flatpickr-input[placeholder*="Check-out"]', '.flatpickr-input[placeholder*="Заминаване"]',
        '[class*="checkout"] .flatpickr-input', '[class*="departure"] .flatpickr-input',
        'input.hasDatepicker[name*="check_out"]', 'input.hasDatepicker[name*="departure"]',
        '[id*="checkout_date"]', '[id*="departure_date"]',
      ];
      for (const sel of dpCheckoutSelectors) {
        try {
          const el = await page.$(sel);
          if (!el || !(await el.isVisible().catch(() => false))) continue;
          result.checkout = await this.fillCustomDatepicker(page, sel, checkout);
          if (result.checkout) break;
        } catch {}
      }
    }

    // Guests (optional — don't block if fails)
    for (const sel of guestSelectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const isVisible = await el.isVisible().catch(() => false);
        if (!isVisible) continue;
        const tag = await el.evaluate((e: any) => e.tagName.toLowerCase());
        if (tag === "select") {
          await el.selectOption(guests).catch(() => {});
        } else {
          await el.click({ clickCount: 3 });
          await el.fill(guests);
        }
        await page.waitForTimeout(100);
        result.guests = true;
        break;
      } catch {}
    }

    return result;
  }

  private async clickAvailabilitySearch(page: Page): Promise<boolean> {
    const searchSelectors = [
      // Specific search/check buttons
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Search")',
      'button:has-text("Check")',
      'button:has-text("Check availability")',
      'button:has-text("Book")',
      'button:has-text("Търси")',
      'button:has-text("Провери")',
      'button:has-text("Провери наличност")',
      'button:has-text("Провери свободните стаи")',
      'button:has-text("Резервирай")',
      'button:has-text("Покажи")',
      '[data-testid*="search"]',
      '[data-testid*="submit"]',
      '.search-btn', '.check-btn', '.availability-btn',
      '#search-btn', '#check-availability',
    ];

    for (const sel of searchSelectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const isVisible = await el.isVisible().catch(() => false);
        if (!isVisible) continue;
        await el.click();
        await page.waitForTimeout(300);
        return true;
      } catch {}
    }

    // Fallback: find button near date inputs via evaluate
    try {
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, input[type=submit], [role=button]")) as HTMLElement[];
        const keywords = ["search","check","book","търси","провери","резервирай","покажи","наличност"];
        for (const btn of btns) {
          const t = (btn.textContent || btn.getAttribute("value") || btn.getAttribute("aria-label") || "").toLowerCase();
          if (keywords.some(k => t.includes(k))) {
            (btn as any).click();
            return true;
          }
        }
        return false;
      });
      if (clicked) return true;
    } catch {}

    return false;
  }

  private async waitForAvailabilityResults(page: Page): Promise<void> {
    // Wait for network to settle
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      // networkidle timeout is OK — page may still have results
    }

    // Also wait for any loading spinners to disappear
    try {
      await page.waitForFunction(() => {
        const spinners = document.querySelectorAll(
          '.loading, .spinner, [class*="loading"], [class*="spinner"], [aria-busy="true"]'
        );
        return spinners.length === 0 ||
          Array.from(spinners).every(el => (el as HTMLElement).offsetParent === null);
      }, { timeout: 6000 });
    } catch {}

    // Extra buffer for DOM to paint
    await page.waitForTimeout(1500);
  }

  private async takeAvailabilityScreenshot(page: Page): Promise<string> {
    // Try full-page first, fallback to viewport
    try {
      const buf = await page.screenshot({ fullPage: true, type: "png" });
      return Buffer.from(buf).toString("base64");
    } catch {
      const buf = await page.screenshot({ fullPage: false, type: "png" });
      return Buffer.from(buf).toString("base64");
    }
  }

  // ─────────────────────────────────────────────────────────
  // fillIframeBookingWidget — interact inside booking iframes
  // Supports: Cloudbeds, Beds24, Mews, Synxis, SabeApp, LittleHotelier, HotelRunner, Bookero, Amelia
  // ─────────────────────────────────────────────────────────

  private async fillIframeBookingWidget(
    page: Page,
    iframeSrc: string,
    vendor: string,
    checkin: string,
    checkout: string,
    guests: string,
    rooms: string
  ): Promise<{ ok: boolean; message: string; screenshot_base64?: string }> {
    try {
      console.log(`[IFRAME] vendor=${vendor} src=${iframeSrc.slice(0, 80)}`);

      // Locate the iframe
      let frameLocator: any = null;
             const iframeSelectors = [
        iframeSrc ? `iframe[src*="${iframeSrc.slice(0, 40)}"]` : "",
        `iframe[src*="${vendor !== "unknown" ? vendor : "booking"}"]`,
        "iframe",
      ].filter(Boolean) as string[];
      for (const sel of iframeSelectors) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;
          frameLocator = page.frameLocator(sel);
          break;
        } catch {}
      }
      if (!frameLocator) {
        console.log("[IFRAME] Could not locate iframe, falling back to main page");
        // Fall back to main page availability check
        await this.fillAvailabilityDates(
          page,
          {
            id: "",
            session_id: "",
            url: page.url(),
            domain: "",
            kind: "availability",
            fingerprint: "",
            schema: {},
            dom_snapshot: null,
          } as FormSchemaRow,
          checkin,
          checkout,
          guests,
          rooms
        );
        const clicked = await this.clickAvailabilitySearch(page);
        await this.waitForAvailabilityResults(page);
        const screenshot_base64 = await this.takeAvailabilityScreenshot(page);
        return { ok: true, message: "iframe_fallback_main_page", screenshot_base64 };
      }

      // ── Vendor-specific date selectors ────────────────────
      const vendorDateSelectors: Record<string, { checkin: string[]; checkout: string[]; guests: string[]; search: string[] }> = {
        cloudbeds: {
          checkin: ['input[name="checkin"]', '.cb-checkin input', '#checkin', 'input[placeholder*="Check-in"]'],
          checkout: ['input[name="checkout"]', '.cb-checkout input', '#checkout', 'input[placeholder*="Check-out"]'],
          guests: ['select[name="adults"]', '#adults', 'input[name="adults"]'],
          search: ['button[type="submit"]', '.cb-search-btn', 'button:has-text("Search")'],
        },
        beds24: {
          checkin: ['input[name="firstday"]', '#firstday', 'input[name="arrival"]'],
          checkout: ['input[name="lastday"]', '#lastday', 'input[name="departure"]'],
          guests: ['select[name="numadult"]', '#numadult'],
          search: ['input[type="submit"]', 'button[type="submit"]'],
        },
        mews: {
          checkin: ['input[data-testid*="start"]', '.mews-start input', 'input[name*="start"]'],
          checkout: ['input[data-testid*="end"]', '.mews-end input', 'input[name*="end"]'],
          guests: ['input[data-testid*="adult"]', 'select[data-testid*="adult"]'],
          search: ['button[data-testid*="search"]', 'button[data-testid*="submit"]', 'button:has-text("Search")'],
        },
        sabeeapp: {
          checkin: ['input[name="checkin"]', '#checkin_date'],
          checkout: ['input[name="checkout"]', '#checkout_date'],
          guests: ['select[name="adults"]', '#adults_count'],
          search: ['button[type="submit"]', '.sabee-search'],
        },
        littlehotelier: {
          checkin: ['input[name="StartDate"]', '#StartDate', 'input[data-field="start"]'],
          checkout: ['input[name="EndDate"]', '#EndDate', 'input[data-field="end"]'],
          guests: ['select[name="Adults"]', '#Adults'],
          search: ['button[type="submit"]', '.be-submit'],
        },
        hotelrunner: {
          checkin: ['input[name="checkin"]', '.hr-checkin input'],
          checkout: ['input[name="checkout"]', '.hr-checkout input'],
          guests: ['select[name="adult"]', '#adult_count'],
          search: ['button[type="submit"]', '.hr-search-button'],
        },
        bookero: {
          checkin: ['input[name="dateFrom"]', '#dateFrom'],
          checkout: ['input[name="dateTo"]', '#dateTo'],
          guests: ['select[name="persons"]', '#persons'],
          search: ['button[type="submit"]', '.bookero-submit'],
        },
        amelia: {
          checkin: ['.amelia-date-input', 'input[name="date"]', '#ameliaBookingDate'],
          checkout: ['input[name="endDate"]', '.amelia-end-date'],
          guests: ['select[name="guests"]', '.amelia-guests select'],
          search: ['.amelia-step-btn', 'button.amelia-continue', 'button:has-text("Continue")'],
        },
      };

      // Generic fallback selectors (used when vendor not in map or vendor-specific fails)
      const genericSelectors = {
        checkin: [
          'input[name*="checkin"]', 'input[name*="check_in"]', 'input[name*="arrival"]',
          'input[name*="from"]', 'input[name*="start"]', 'input[id*="checkin"]',
          'input[placeholder*="Check-in"]', 'input[placeholder*="Arrival"]',
          '[data-testid*="checkin"]', '[data-testid*="arrival"]',
        ],
        checkout: [
          'input[name*="checkout"]', 'input[name*="check_out"]', 'input[name*="departure"]',
          'input[name*="to"]', 'input[name*="end"]', 'input[id*="checkout"]',
          'input[placeholder*="Check-out"]', 'input[placeholder*="Departure"]',
          '[data-testid*="checkout"]', '[data-testid*="departure"]',
        ],
        guests: [
          'select[name*="adult"]', 'input[name*="adult"]', 'select[name*="guest"]',
          'input[name*="guest"]', '[data-testid*="adult"]',
        ],
        search: [
          'button[type="submit"]', 'input[type="submit"]',
          'button:has-text("Search")', 'button:has-text("Book")',
          'button:has-text("Check")', 'button:has-text("Търси")',
        ],
      };

      const selMap = vendorDateSelectors[vendor] || genericSelectors;

      // Helper: try to fill an element inside the iframe
      const iframeFill = async (selectors: string[], value: string): Promise<boolean> => {
        const allSels = [...selectors, ...genericSelectors.checkin.slice(0, 3)];
        for (const sel of selectors) {
          try {
            const loc = frameLocator.locator(sel).first();
            const count = await loc.count().catch(() => 0);
            if (count === 0) continue;
            const visible = await loc.isVisible().catch(() => false);
            if (!visible) continue;

            // Try fill first
            await loc.click({ timeout: 2000 }).catch(() => {});
            await loc.fill(value, { timeout: 2000 }).catch(() => {});
            await page.keyboard.press("Tab");
            await page.waitForTimeout(200);

            // Verify
            const filled = await loc.inputValue().catch(() => "");
            if (filled && filled !== "") {
              console.log(`[IFRAME][FILL] ${sel} = ${filled}`);
              return true;
            }

            // Try custom datepicker approach
            const filledDP = await this.fillCustomDatepickerInFrame(frameLocator, sel, value);
            if (filledDP) {
              console.log(`[IFRAME][DATEPICKER] ${sel} = ${value}`);
              return true;
            }
          } catch {}
        }
        return false;
      };

      const checkinOk = await iframeFill(selMap.checkin, checkin);
      await page.waitForTimeout(300);
      const checkoutOk = await iframeFill(selMap.checkout, checkout);
      await page.waitForTimeout(300);

      // Guests (optional)
      try {
        for (const sel of selMap.guests) {
          const loc = frameLocator.locator(sel).first();
          const count = await loc.count().catch(() => 0);
          if (count === 0) continue;
          const tag = await loc.evaluate((el: any) => el.tagName?.toLowerCase()).catch(() => "");
          if (tag === "select") {
            await loc.selectOption(guests).catch(() => {});
          } else {
            await loc.fill(guests).catch(() => {});
          }
          await page.waitForTimeout(200);
          break;
        }
      } catch {}

      // Click search inside iframe
      let searchClicked = false;
      for (const sel of selMap.search) {
        try {
          const loc = frameLocator.locator(sel).first();
          const count = await loc.count().catch(() => 0);
          if (count === 0) continue;
          const visible = await loc.isVisible().catch(() => false);
          if (!visible) continue;
          await loc.click({ timeout: 3000 });
          searchClicked = true;
          console.log(`[IFRAME][SEARCH] clicked ${sel}`);
          break;
        } catch {}
      }

      await this.waitForAvailabilityResults(page);
      const screenshot_base64 = await this.takeAvailabilityScreenshot(page);

      return {
        ok: true,
        message: searchClicked ? "iframe_availability_ready" : "iframe_availability_partial",
        screenshot_base64,
      };
    
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[IFRAME] Error: ${msg}`);
      // Fallback screenshot
      try {
        const screenshot_base64 = await this.takeAvailabilityScreenshot(page);
        return { ok: true, message: "iframe_error_screenshot", screenshot_base64 };
      } catch {
        return { ok: false, message: `Iframe error: ${msg}` };
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // fillCustomDatepicker — handles non-native date pickers
  // Flatpickr, Pikaday, React DatePicker, AirDatepicker, jQuery UI
  // ─────────────────────────────────────────────────────────

  private async fillCustomDatepicker(page: Page, selector: string, dateStr: string): Promise<boolean> {
    // dateStr expected: "2025-12-20" (ISO) or "20.12.2025" (BG)
    return await this.fillCustomDatepickerInFrame(page, selector, dateStr);
  }

  private async fillCustomDatepickerInFrame(frame: any, selector: string, dateStr: string): Promise<boolean> {
    try {
      // Parse date
      let year: number, month: number, day: number;
      const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const bgMatch = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (isoMatch) {
        year = parseInt(isoMatch[1]); month = parseInt(isoMatch[2]); day = parseInt(isoMatch[3]);
      } else if (bgMatch) {
        day = parseInt(bgMatch[1]); month = parseInt(bgMatch[2]); year = parseInt(bgMatch[3]);
      } else {
        return false;
      }

      // Strategy 1: Try clicking the input to open the calendar, then click the day
      const el = frame.locator(selector).first();
      const count = await el.count().catch(() => 0);
      if (count === 0) return false;

      await el.click({ timeout: 2000 }).catch(() => {});
      await frame.waitForTimeout?.(400) || await new Promise(r => setTimeout(r, 400));

      // Look for calendar popup/grid
      const calendarSelectors = [
        '.flatpickr-calendar', '.pika-single', '.react-datepicker',
        '.air-datepicker', '.ui-datepicker', '[class*="calendar"][class*="popup"]',
        '[class*="datepicker"][class*="open"]', '[role="dialog"][aria-label*="calendar"]',
        '.DayPicker', '.rdrCalendarWrapper', '.daterangepicker',
      ];

      let calendarFound = false;
      for (const calSel of calendarSelectors) {
        try {
          const calEl = frame.locator(calSel).first();
          const visible = await calEl.isVisible({ timeout: 800 }).catch(() => false);
          if (!visible) continue;

          // Navigate to the right month if needed
          await this.navigateCalendarToMonth(frame, calEl, year, month);

          // Click the day
          const dayClicked = await this.clickCalendarDay(frame, calEl, day, month, year);
          if (dayClicked) {
            console.log(`[DATEPICKER] Clicked day ${day}/${month}/${year} in ${calSel}`);
            calendarFound = true;
            break;
          }
        } catch {}
      }

      if (calendarFound) return true;

      // Strategy 2: Keyboard navigation — type date directly into input
      await el.click({ clickCount: 3, timeout: 2000 }).catch(() => {});
      // Try multiple formats
      const formats = [
        `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`,
        `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`,
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`,
      ];

      for (const fmt of formats) {
        try {
          await el.fill(fmt, { timeout: 1500 }).catch(() => {});
          await frame.keyboard?.press("Tab") || await frame.page?.().keyboard.press("Tab");
          await new Promise(r => setTimeout(r, 200));
          const val = await el.inputValue().catch(() => "");
          if (val && val !== "") {
            console.log(`[DATEPICKER][FORMAT] ${selector} = ${val}`);
            return true;
          }
        } catch {}
      }

      // Strategy 3: Direct DOM value injection (for React-controlled inputs)
      try {
        const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const ok = await el.evaluate((el: any, d: string) => {
          if (!el) return false;
          // React synthetic events approach
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, d);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            // Flatpickr specific
            if (el._flatpickr) {
              el._flatpickr.setDate(d, true);
            }
            return el.value === d;
          }
          return false;
        }, isoDate).catch(() => false);
        if (ok) {
          console.log(`[DATEPICKER][DOM] ${selector} = ${isoDate}`);
          return true;
        }
      } catch {}

      return false;
    } catch {
      return false;
    }
  }

  private async navigateCalendarToMonth(frame: any, calEl: any, year: number, month: number): Promise<void> {
    try {
      // Try to read current month from calendar header
      for (let attempts = 0; attempts < 12; attempts++) {
        const headerText = await calEl.locator('[class*="month"], [class*="title"], .flatpickr-monthDropdown-months, .pika-title').first().textContent().catch(() => "");
        if (!headerText) break;

        // Check if already at the right month
        const monthNames: Record<number, string[]> = {
          1: ["jan", "january", "яну"],  2: ["feb", "february", "фев"],
          3: ["mar", "march", "мар"],    4: ["apr", "april", "апр"],
          5: ["may", "май"],             6: ["jun", "june", "юни"],
          7: ["jul", "july", "юли"],     8: ["aug", "august", "авг"],
          9: ["sep", "september", "сеп"],10: ["oct", "october", "окт"],
          11: ["nov", "november", "ное"],12: ["dec", "december", "дек"],
        };
        const lower = headerText.toLowerCase();
        const yearMatch = lower.includes(String(year));
        const monthMatch = (monthNames[month] || []).some(m => lower.includes(m));

        if (yearMatch && monthMatch) break;

        // Click next month button
        const nextBtn = calEl.locator('[class*="next"], [aria-label*="next"], [aria-label*="следващ"], .flatpickr-next-month, .pika-next').first();
        const hasPrev = lower < `${year}-${month}` ? false : true;
        const btnSel = hasPrev ? nextBtn : calEl.locator('[class*="prev"], [aria-label*="prev"], .flatpickr-prev-month, .pika-prev').first();
        await btnSel.click({ timeout: 1500 }).catch(() => {});
        await new Promise(r => setTimeout(r, 300));
      }
    } catch {}
  }

  private async clickCalendarDay(frame: any, calEl: any, day: number, month: number, year: number): Promise<boolean> {
    const daySelectors = [
      // Flatpickr
      `.flatpickr-day[aria-label*="${day}"]`,
      `.flatpickr-day:not(.disabled):not(.prevMonthDay):not(.nextMonthDay)`,
      // Pikaday
      `td[data-day="${day}"]`,
      // React DatePicker
      `.react-datepicker__day:not(.react-datepicker__day--disabled)`,
      // Generic
      `td[class*="day"]:not([class*="disabled"])`,
      `[role="gridcell"]:not([aria-disabled="true"])`,
      `[class*="day-${day}"]`, `[data-date*="-${String(day).padStart(2,"0")}"]`,
    ];

    for (const sel of daySelectors) {
      try {
        const dayEls = await calEl.locator(sel).all();
        for (const dayEl of dayEls) {
          const txt = (await dayEl.textContent().catch(() => "")).trim();
          if (txt === String(day)) {
            const visible = await dayEl.isVisible().catch(() => false);
            if (!visible) continue;
            await dayEl.click({ timeout: 2000 });
            await new Promise(r => setTimeout(r, 200));
            return true;
          }
        }
      } catch {}
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────
  // fillStyledChoiceGroups — fill div/label/li choice groups in any context
  // Used for form schemas that have choice fields (not just wizards)
  // ─────────────────────────────────────────────────────────

  private async fillStyledChoiceGroups(
    page: Page,
    choices: Array<{ name: string; label: string; required: boolean; type: string; options: Array<{ value: string; label: string; selector_candidates?: string[] }> }>,
    data: Record<string, unknown>
  ): Promise<string[]> {
    const actions: string[] = [];

    for (const group of choices) {
      const groupNameNorm = normLabel(group.name);
      let desiredValue = "";

      // Find matching value in data
      for (const k of Object.keys(data)) {
        const kNorm = normLabel(k);
        if (kNorm === groupNameNorm || labelSoftIncludes(k, group.name) || labelSoftIncludes(k, group.label)) {
          desiredValue = String((data as any)[k] ?? "").trim();
          break;
        }
      }

      if (!desiredValue) {
        // Try value-based match
        for (const k of Object.keys(data)) {
          const v = String((data as any)[k] ?? "").trim();
          if (!v || v.includes("@") || v.length > 40 || /^\+?\d{7,}$/.test(v.replace(/[\s()-]/g, ""))) continue;
          const vNorm = normLabel(v);
          if (!vNorm || vNorm.length < 2) continue;
          const optMatch = group.options.some((o) => normLabel(o.label) === vNorm || normLabel(o.value) === vNorm);
          if (optMatch) { desiredValue = v; break; }
        }
      }

      if (!desiredValue) continue;

      const wantedNorm = normLabel(desiredValue);
      const pick =
        group.options.find((o) => normLabel(o.label) === wantedNorm) ||
        group.options.find((o) => normLabel(o.value) === wantedNorm) ||
        group.options.find((o) => {
          const oNorm = normLabel(o.label);
          if (oNorm.length < 3 || wantedNorm.length < 3) return false;
          return oNorm.includes(wantedNorm) || wantedNorm.includes(oNorm);
        });

      if (!pick) continue;

      // Try selector_candidates from the option
      const selectors = pick.selector_candidates || [];
      let clicked = false;
      for (const sel of selectors) {
        if (!sel) continue;
        try {
          const el = await page.$(sel);
          if (!el) continue;
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click({ timeout: 2500, force: true });
          clicked = true;
          break;
        } catch {}
      }

      // Fallback: search by text
      if (!clicked) {
        const labelText = pick.label || pick.value;
        const candidates = [
          `button:has-text("${labelText}")`,
          `[role="radio"]:has-text("${labelText}")`,
          `label:has-text("${labelText}")`,
          `li:has-text("${labelText}")`,
        ];
        for (const sel of candidates) {
          try {
            const el = await page.$(sel);
            if (!el) continue;
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            await el.scrollIntoViewIfNeeded().catch(() => {});
            await el.click({ timeout: 2000, force: true });
            clicked = true;
            break;
          } catch {}
        }
      }

      if (clicked) {
        actions.push(`${group.label || group.name}: ${pick.label || pick.value}`);
        console.log(`[CHOICES] Clicked "${group.label}" → "${pick.label}"`);
      }
    }

    return actions;
  }

  // ─────────────────────────────────────────────────────────
  // makeReservation — full hotel booking workflow
  // Phase "check": fills dates, gets screenshot with prices
  // Phase "reserve": fills guest details, stops before payment, returns URL
  // ─────────────────────────────────────────────────────────

  async makeReservation(req: MakeReservationRequest): Promise<{
    ok: boolean;
    phase: string;
    message: string;
    screenshot_base64?: string;
    booking_url?: string;
    prices_found?: string;
    observation?: JsonObj;
  }> {
    const session = this.sessions.get(req.site_id);
    if (!session) return { ok: false, phase: req.phase, message: "Няма активна сесия" };

    session.lastActivity = Date.now();

    const checkin  = String(req.check_in || "").trim();
    const checkout = String(req.check_out || "").trim();
    const guests   = String(req.guests || "2");
    const rooms    = String(req.rooms || "1");
    const page     = session.page;

    console.log(`[RESERVATION] phase=${req.phase} check_in=${checkin} check_out=${checkout} guests=${guests}`);

    if (req.phase === "check") {
      // ── PHASE 1: Availability check ──────────────────────────
      try {
        // Find availability schema
        let availSchema = session.formSchemas.find(s => s.kind === "availability");
        if (!availSchema) availSchema = session.formSchemas.find(s => s.kind === "booking_widget");
        if (!availSchema) availSchema = session.formSchemas.find(s => s.kind === "form" || s.kind === "wizard");

        const data: Record<string, unknown> = {
         check_in: checkin,
check_out: checkout,
guests: guests,
adults: guests,
rooms: rooms,
        };

        const schemaAny: any = availSchema?.schema || {};
        const uiType = String(schemaAny?.ui_type || "").toLowerCase();
        const iframeSrc = String(schemaAny?.iframe_src || schemaAny?.src || "");
        const vendor = String(schemaAny?.booking_vendor || schemaAny?.vendor || "unknown");

        const isIframeAvailability =
          uiType.includes("iframe_booking_widget") ||
          !!iframeSrc ||
          String(vendor).toLowerCase().includes("quendoo");

        // Schema-first iframe flow
        if (availSchema && isIframeAvailability) {
          console.log(
            `[RESERVATION] Using availability iframe schema ui_type=${uiType} vendor=${vendor} url=${availSchema.url}`
          );

          await this.ensureOnSchemaUrl(page, availSchema.url);
          await page.waitForTimeout(1000);

          const result = await this.fillIframeBookingWidget(
            page,
            iframeSrc,
            vendor,
            checkin,
            checkout,
            guests,
            rooms
          );

          return {
            ok: result.ok,
            phase: "check",
            message: result.message,
            screenshot_base64: result.screenshot_base64,
            observation: {
              type: "availability_iframe_check",
              check_in: checkin,
              check_out: checkout,
              guests,
              rooms,
              url: page.url(),
              iframe_src: iframeSrc,
              vendor,
            },
          };
        }

        // Standard availability check
        if (availSchema) {
          const result = await this.checkAvailability(page, availSchema, data);
          return {
            ok: result.ok,
            phase: "check",
            message: result.message,
            screenshot_base64: result.observation?.screenshot_base64 as string | undefined,
            observation: result.observation,
          };
        }

        // No schema found — try generic availability on current page
        console.log("[RESERVATION] No availability schema — trying generic");
        await page.waitForTimeout(800);
        const filled = await this.fillAvailabilityDates(
          page,
          availSchema || ({
            id: "",
            session_id: "",
            url: page.url(),
            domain: "",
            kind: "availability",
            fingerprint: "",
            schema: {},
            dom_snapshot: null,
          } as FormSchemaRow),
          checkin,
          checkout,
          guests,
          rooms
        );

        // Also try custom datepickers if standard fill failed
        if (!filled.checkin || !filled.checkout) {
          const dpSelectors = [
            '[class*="checkin"] input', '[class*="arrival"] input',
            '[id*="checkin"]', '[id*="datepicker"]',
            '.flatpickr-input', '.hasDatepicker',
          ];
          for (const sel of dpSelectors) {
            try {
              const el = await page.$(sel);
              if (!el || !(await el.isVisible().catch(() => false))) continue;
              if (!filled.checkin) {
                filled.checkin = await this.fillCustomDatepicker(page, sel, checkin);
                if (filled.checkin) continue;
              }
            } catch {}
          }
        }

        const clicked = await this.clickAvailabilitySearch(page);
        await this.waitForAvailabilityResults(page);
        const screenshot_base64 = await this.takeAvailabilityScreenshot(page);

        return {
          ok: true,
          phase: "check",
          message: clicked ? "availability_ready" : "availability_partial",
          screenshot_base64,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[RESERVATION][CHECK] Error: ${msg}`);
        try {
          const screenshot_base64 = await this.takeAvailabilityScreenshot(page);
          return { ok: true, phase: "check", message: "check_error_screenshot", screenshot_base64 };
        } catch {
          return { ok: false, phase: "check", message: `Check error: ${msg}` };
        }
      }
    }

    if (req.phase === "reserve") {
      // ── PHASE 2: continue booking step-by-step ────
      try {
        console.log(
          `[RESERVATION] Starting reserve phase: name=${req.guest_name} email=${req.guest_email} room_type=${req.room_type || ""}`
        );

        const guestData: Record<string, unknown> = {
          name: req.guest_name || "",
          full_name: req.guest_name || "",
          email: req.guest_email || "",
          phone: req.guest_phone || "",
          message: req.guest_message || "",
          note: req.guest_message || "",
          check_in: checkin,
          check_out: checkout,
          guests: guests,
          adults: guests,
          rooms: rooms,
          room_type: req.room_type || "",
        };

        const beforeUrl = page.url();
        console.log(`[RESERVATION][RESERVE] staying on current booking step url=${beforeUrl}`);
        await page.waitForTimeout(800);

        // STEP 1: first select the chosen room on the CURRENT booking page
        let roomSelectionAttempted = false;
        let roomSelectionSucceeded = false;

        if (req.room_type) {
          roomSelectionAttempted = true;

          const roomPatterns = [
            `button:has-text("${req.room_type}")`,
            `[role="button"]:has-text("${req.room_type}")`,
            `a:has-text("${req.room_type}")`,
            `label:has-text("${req.room_type}")`,
            `div:has-text("${req.room_type}")`,
            `li:has-text("${req.room_type}")`,
          ];

          for (const sel of roomPatterns) {
            try {
              const loc = page.locator(sel).first();
              const count = await page.locator(sel).count().catch(() => 0);
              if (!count) continue;

              await loc.scrollIntoViewIfNeeded().catch(() => {});
              await loc.click({ timeout: 1500 }).catch(async () => {
                await loc.dispatchEvent("click").catch(() => {});
              });

              await page.waitForTimeout(1200);

              const afterUrl = page.url();
              const pageText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();

              if (
                afterUrl !== beforeUrl ||
                pageText.includes("име") ||
                pageText.includes("email") ||
                pageText.includes("имейл") ||
                pageText.includes("телефон") ||
                pageText.includes("card") ||
                pageText.includes("плащ")
              ) {
                roomSelectionSucceeded = true;
                console.log(`[RESERVATION][ROOM] selected via ${sel}`);
                break;
              }
            } catch {}
          }

          if (!roomSelectionSucceeded) {
            console.log("[RESERVATION][ROOM] direct room click not confirmed from DOM/url change");
          }
        }

        const currentUrlAfterRoom = page.url();
        const screenshotAfterRoom = await this.takeAvailabilityScreenshot(page);
        const stepNeedsAfterRoom = await this.inferCurrentBookingStepNeeds(page);

        // STEP 2: after room selection, return the REAL missing fields from the current booking step
        const hasGuestIdentity =
          !!String(req.guest_name || "").trim() &&
          !!String(req.guest_email || "").trim() &&
          !!String(req.guest_phone || "").trim();

        if (req.room_type && !hasGuestIdentity) {
          return {
            ok: true,
            phase: "reserve",
            message: "reserve_current_step_needs_input",
            booking_url: stepNeedsAfterRoom.payment_required ? currentUrlAfterRoom : "",
            screenshot_base64: screenshotAfterRoom,
            observation: {
              url: currentUrlAfterRoom,
              before_url: beforeUrl,
              room_type: req.room_type || "",
              room_selection_attempted: roomSelectionAttempted,
              room_selection_succeeded: roomSelectionSucceeded,
              current_step: stepNeedsAfterRoom.current_step,
              missing_required: stepNeedsAfterRoom.missing_required,
              can_continue: stepNeedsAfterRoom.can_continue,
              payment_required: stepNeedsAfterRoom.payment_required,
              finalized: false,
            },
          };
        }

        // STEP 3: only now try to fill personal data on the CURRENT page/state
        const formSchema = session.formSchemas.find(
          (s) => s.kind === "form" || s.kind === "wizard"
        );

               if (formSchema) {
          if (formSchema.schema.choices?.length) {
            const choiceActions = await this.fillStyledChoiceGroups(
              page,
              formSchema.schema.choices,
              guestData
            );
            choiceActions.forEach((a) => console.log(`[RESERVATION][CHOICE][CURRENT] ${a}`));
          }

          const fillResult =
            formSchema.kind === "wizard"
              ? await this.fillWizard(page, formSchema, guestData, false, false)
              : await this.fillFormSchema(page, formSchema, guestData, undefined, false, false);

          const currentUrl = page.url();
          const screenshot_base64 = await this.takeAvailabilityScreenshot(page);

          const noMatchOnCurrentPage =
            !fillResult?.ok &&
            String(fillResult?.message || "").toLowerCase().includes("no_match");

          const stepNeedsAfterFill = await this.inferCurrentBookingStepNeeds(page);

          if (noMatchOnCurrentPage) {
            console.log(
              `[RESERVATION][RESERVE] no matched fields on current step — missing=${stepNeedsAfterFill.missing_required.join(" | ") || "none"}`
            );

            return {
              ok: false,
              phase: "reserve",
              message: "reserve_current_step_needs_input",
              booking_url: stepNeedsAfterFill.payment_required ? currentUrl : "",
              screenshot_base64,
              observation: {
                url: currentUrl,
                before_url: beforeUrl,
                fill_message: fillResult.message,
                confirmed_price: req.confirmed_price || "",
                room_type: req.room_type || "",
                current_step: stepNeedsAfterFill.current_step,
                missing_required: stepNeedsAfterFill.missing_required,
                can_continue: stepNeedsAfterFill.can_continue,
                payment_required: stepNeedsAfterFill.payment_required,
                finalized: false,
              },
            };
          }

          if (stepNeedsAfterFill.missing_required.length > 0) {
            console.log(
              `[RESERVATION][RESERVE] after fill still missing=${stepNeedsAfterFill.missing_required.join(" | ")}`
            );

            return {
              ok: true,
              phase: "reserve",
              message: "reserve_current_step_needs_input",
              booking_url: stepNeedsAfterFill.payment_required ? currentUrl : "",
              screenshot_base64,
              observation: {
                url: currentUrl,
                before_url: beforeUrl,
                fill_message: fillResult.message,
                confirmed_price: req.confirmed_price || "",
                room_type: req.room_type || "",
                current_step: stepNeedsAfterFill.current_step,
                missing_required: stepNeedsAfterFill.missing_required,
                can_continue: stepNeedsAfterFill.can_continue,
                payment_required: stepNeedsAfterFill.payment_required,
                finalized: false,
              },
            };
          }

          return {
            ok: !!fillResult?.ok,
            phase: "reserve",
            message: fillResult.message,
            booking_url: currentUrl,
            screenshot_base64,
            observation: {
              url: currentUrl,
              before_url: beforeUrl,
              fill_message: fillResult.message,
              confirmed_price: req.confirmed_price || "",
              room_type: req.room_type || "",
              current_step: stepNeedsAfterFill.current_step,
              missing_required: [],
              can_continue: true,
              payment_required: stepNeedsAfterFill.payment_required,
              finalized: false,
            },
          };
        }

        // No form schema — keep current booking step and return continuation state
        await page.waitForTimeout(800);

        const obs = await this.quickObserve(page);
        const currentUrl = page.url();
        const screenshot_base64 = await this.takeAvailabilityScreenshot(page);

               return {
          ok: true,
          phase: "reserve",
          message: "no_form_schema_found_current_step_preserved",
          booking_url: currentUrl,
          screenshot_base64,
          observation: {
            ...(obs || {}),
            url: currentUrl,
            confirmed_price: req.confirmed_price || "",
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[RESERVATION][RESERVE] Error: ${msg}`);
        try {
          const screenshot_base64 = await this.takeAvailabilityScreenshot(page);
          return {
            ok: true,
            phase: "reserve",
            message: `reserve_error_screenshot: ${msg}`,
            booking_url: page.url(),
            screenshot_base64,
          };
        } catch {
          return {
            ok: false,
            phase: "reserve",
            message: `Reserve error: ${msg}`,
          };
        }
      }
    }

    return { ok: false, phase: req.phase, message: `Unknown phase: ${req.phase}` };
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
    if (token !== WORKER_SECRET) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
  });

  app.get("/", (_, res) => {
    res.json({
      name: "NEO Worker",
      version: "7.0.0-booking",
      build: "neo-worker_v7_make_reservation",
      mode: "schema-first",
      has_make_reservation: true
    });
  });

   app.get("/health", (_, res) => {
    res.json({
      status: "ok",
      version: "7.0.0-booking",
      build: "neo-worker_v7_make_reservation",
      has_make_reservation: true,
      ...manager.getStatus()
    });
  });

  app.get("/__routes", (_, res) => {
    res.json({
      success: true,
      version: "7.0.0-booking",
      build: "neo-worker_v7_make_reservation",
      routes: [
        "GET /",
        "GET /health",
        "GET /__routes",
        "POST /prepare-session",
        "POST /fill-form",
        "POST /check-availability",
        "POST /make-reservation",
        "POST /execute",
        "GET /forms/:sessionId",
        "POST /refresh-forms",
        "POST /close-session"
      ]
    });
  });

  app.post("/prepare-session", async (req: Request, res: Response) => {
    const { site_id, site_map, session_id } = req.body || {};
    if (!site_id || !site_map) return res.json({ success: false, error: "Missing site_id/site_map" });

    const ok = await manager.prepareSession(String(site_id), site_map as SiteMap, session_id ? String(session_id) : undefined);
    res.json({ success: ok, session_ready: ok });
  });

  app.post("/fill-form", async (req: Request, res: Response) => {
    const body = req.body as FillFormRequest;
    if (!body?.site_id || !body?.data) {
      return res.json({ success: false, message: "Missing site_id/data" });
    }

    const dataKeys = safeKeys(body.data);
    const confKeys = safeKeys(body.confirmed);
    console.log(`[HTTP][/fill-form] site_id=${body.site_id} session_id=${body.session_id || ""} form_id=${body.form_id || ""} fingerprint=${(body.fingerprint || "").slice(0, 12)} kind=${body.kind || ""} auto_submit=${body.auto_submit !== false} strict_select=${body.strict_select === true}`);
    console.log(`[HTTP][/fill-form] data_keys=${dataKeys.join(",")} confirmed_keys=${confKeys.join(",")}`);

    const r = await manager.executeFillForm(body);
    res.json(r);
  });

  app.post("/check-availability", async (req: Request, res: Response) => {
    const { site_id, session_id, form_id, fingerprint, data } = req.body || {};
    if (!site_id || !data) {
      return res.json({ success: false, message: "Missing site_id/data" });
    }
    console.log(`[HTTP][/check-availability] site_id=${site_id} session_id=${session_id || ""}`);

    // Delegate through executeFillForm with kind=availability
    const r = await manager.executeFillForm({
      site_id: String(site_id),
      session_id: session_id ? String(session_id) : undefined,
      form_id: form_id ? String(form_id) : undefined,
      fingerprint: fingerprint ? String(fingerprint) : undefined,
      kind: "availability",
      data: data as Record<string, unknown>,
      auto_submit: false,
    });
    res.json(r);
  });

  // ── /make-reservation: full hotel booking workflow ─────────────────
  app.post("/make-reservation", async (req: Request, res: Response) => {
    const body = req.body as MakeReservationRequest;
    if (!body?.site_id || !body?.phase) {
      return res.json({ success: false, message: "Missing site_id/phase" });
    }
    if (body.phase === "check" && (!body.check_in || !body.check_out)) {
      return res.json({ success: false, message: "Missing check_in/check_out for phase=check" });
    }

           console.log(`[HTTP][/make-reservation] HIT site_id=${body.site_id} phase=${body.phase} check_in=${body.check_in || ""} check_out=${body.check_out || ""} guests=${body.guests || ""} session_id=${body.session_id || ""}`);
    const r = await manager.makeReservation(body);
    res.json(r);
  });

  app.post("/execute", async (req: Request, res: Response) => {
    const { site_id, session_id, keywords, data } = req.body || {};
    if (!site_id || !Array.isArray(keywords)) return res.json({ success: false, message: "Invalid request" });

    const r = await manager.execute({
      site_id: String(site_id),
      session_id: session_id ? String(session_id) : undefined,
      keywords,
      data: (data || undefined) as any,
    });
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

  app.listen(PORT, () => {
    console.log(`🚀 NEO Worker v7.0.0-booking listening on :${PORT}`);
    console.log(`[BOOT] build=neo-worker_v7_make_reservation port=${PORT}`);
    console.log(`[BOOT] routes=GET /, GET /health, GET /__routes, POST /prepare-session, POST /fill-form, POST /check-availability, POST /make-reservation, POST /execute, GET /forms/:sessionId, POST /refresh-forms, POST /close-session`);
  });

  await manager.start();

  process.on("SIGTERM", async () => {
    console.log("[SIGTERM] closing...");
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    console.log("[SIGINT] closing...");
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
