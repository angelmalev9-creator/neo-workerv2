/**
 * NEO WORKER v6.2.0-availability — Universal, deterministic, schema-first
 *
 * Patch v6.2.0-availability:
 * - checkAvailability(): universal hotel availability check
 *     fills check-in/check-out dates universally across any hotel site
 *     clicks search button, waits for results, takes screenshot
 *     returns screenshot_base64 for Gemini Vision parsing in proxy
 * - /check-availability endpoint added
 * - executeFillForm: new branch for kind=availability
 * - All existing form/wizard logic unchanged
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

      // ── 2. Navigate to availability URL ───────────────────────
      await this.ensureOnSchemaUrl(page, schema.url);
      await page.waitForTimeout(1200);

      // ── 3. Try to fill date fields universally ─────────────────
      const filled = await this.fillAvailabilityDates(page, checkin, checkout, guests, rooms);
      console.log(`[AVAIL] fillDates=${JSON.stringify(filled)}`);

      // ── 4. Click Search / Check button ────────────────────────
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
    checkin: string,
    checkout: string,
    guests: string,
    rooms: string
  ): Promise<{ checkin: boolean; checkout: boolean; guests: boolean }> {
    const result = { checkin: false, checkout: false, guests: false };

    // ── Date input selectors (ordered by specificity) ──────────
    const checkinSelectors = [
      'input[name*="check_in"]', 'input[name*="checkin"]', 'input[name*="check-in"]',
      'input[name*="arrival"]', 'input[name*="from"]', 'input[name*="date_from"]',
      'input[name*="start"]', 'input[id*="check_in"]', 'input[id*="checkin"]',
      'input[id*="arrival"]', 'input[id*="from"]', 'input[id*="dateFrom"]',
      'input[placeholder*="Check-in"]', 'input[placeholder*="Arrival"]',
      'input[placeholder*="Пристигане"]', 'input[placeholder*="От"]',
      '[data-testid*="checkin"]', '[data-testid*="check-in"]', '[data-testid*="arrival"]',
    ];
    const checkoutSelectors = [
      'input[name*="check_out"]', 'input[name*="checkout"]', 'input[name*="check-out"]',
      'input[name*="departure"]', 'input[name*="to"]', 'input[name*="date_to"]',
      'input[name*="end"]', 'input[id*="check_out"]', 'input[id*="checkout"]',
      'input[id*="departure"]', 'input[id*="to"]', 'input[id*="dateTo"]',
      'input[placeholder*="Check-out"]', 'input[placeholder*="Departure"]',
      'input[placeholder*="Заминаване"]', 'input[placeholder*="До"]',
      '[data-testid*="checkout"]', '[data-testid*="check-out"]', '[data-testid*="departure"]',
    ];
    const guestSelectors = [
      'input[name*="guest"]', 'input[name*="adult"]', 'input[name*="person"]',
      'input[name*="pax"]', 'input[id*="guest"]', 'input[id*="adult"]',
      'select[name*="guest"]', 'select[name*="adult"]', 'select[id*="guest"]',
      'input[placeholder*="Guests"]', 'input[placeholder*="Adults"]',
      'input[placeholder*="Гости"]', 'input[placeholder*="Възрастни"]',
    ];

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
    result.checkout = await tryFillDate(checkoutSelectors, checkout);
    await page.waitForTimeout(200);

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
    res.json({ name: "NEO Worker", version: "6.1.0-universal-choices", mode: "schema-first" });
  });

  app.get("/health", (_, res) => {
    res.json({ status: "ok", ...manager.getStatus() });
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
    console.log(`🚀 NEO Worker v6.1.0-universal-choices listening on :${PORT}`);
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
