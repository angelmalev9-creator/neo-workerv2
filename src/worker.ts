/**
 * NEO WORKER v6.0.2-logs — Universal, deterministic, schema-first
 *
 * Patch v6.0.3-wizard-labelmatch:
 * - Wizard: robust label-key matching (normalize "*" / punctuation / spacing)
 * - Wizard: selector_candidates + fill via locator-first
 * - Does NOT change kind=form flow
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
  selector: string; // best-effort unique-ish CSS selector
  selector_candidates: string[]; // NEW: candidates similar to schema-first
  options?: { value: string; label: string }[]; // for <select>
};

type WizardChoiceButton = {
  text: string;
  selector: string;
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
// Wizard label normalization (NEW)
// ───────────────────────────────────────────────────────────────

function normLabel(s: unknown): string {
  const t = String(s ?? "")
    .toLowerCase()
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
    const { site_id, session_id, form_id, fingerprint, kind, data, confirmed, file } = request;
    const autoSubmit = request.auto_submit !== false;

    const session = this.sessions.get(site_id);
    if (!session) return { success: false, message: "Няма активна сесия" };

    session.lastActivity = Date.now();

    if (session.formSchemas.length === 0 && (session_id || session.sessionId)) {
      session.formSchemas = await this.loadFormSchemas(session_id || session.sessionId || site_id);
    }

    let schema: FormSchemaRow | undefined;
    if (form_id) schema = session.formSchemas.find(s => s.id === form_id);
    else if (fingerprint) schema = session.formSchemas.find(s => s.fingerprint === fingerprint);
    else if (kind) schema = session.formSchemas.find(s => s.kind === kind);
    else schema = session.formSchemas.find(s => s.kind === "form" || s.kind === "wizard");

    if (!schema) {
      return { success: false, message: `Не намерих форма (schemas=${session.formSchemas.length})` };
    }

    console.log(`[FILL-FORM] kind=${schema.kind} form_id=${schema.id} fingerprint=${schema.fingerprint.slice(0, 12)}… fields=${schema.schema.fields?.length || 0}`);

    const merged = mergeConfirmedData(data || {}, confirmed as any);

    // PII-safe payload summary
    const mergedKeys = Object.keys(merged);
    const mergedPreview = mergedKeys.slice(0, 12).map(k => `${k}=${summarizeValue(k, (merged as any)[k])}`);
    console.log(`[FILL-FORM][PAYLOAD] keys=${mergedKeys.join(",")} preview=${mergedPreview.join(" | ")}`);

    await this.ensureOnSchemaUrl(session.page, schema.url);

    let result: { ok: boolean; message: string; observation?: JsonObj };
    if (schema.kind === "wizard") {
      result = await this.fillWizard(session.page, schema, merged, autoSubmit);
    } else {
      result = await this.fillFormSchema(session.page, schema, merged, file, autoSubmit);
    }

    return { success: !!result.ok, message: result.message, observation: result.observation };
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
        const r = await this.fillFormSchema(session.page, best, data, undefined, true);
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
    autoSubmit = true
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

      const usedSel = await this.fillSingleField(page, f, String(v));
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
    autoSubmit = true
  ): Promise<{ ok: boolean; message: string; observation?: JsonObj }> {
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
        const ok = await this.fillWizardField(page, f, String(v));
        if (ok) {
          filled++;
          actions.push(`${f.label || f.name || f.placeholder || f.type}: ${summarizeValue(f.name || f.type, v)}`);
        }
      }
      if (filled > 0) didInteract = true;

      // 2) Handle choice buttons
      const gender = String((data as any).gender || (data as any).sex || (data as any).pol || "").trim();
      if (gender && scanned.choices.length) {
        const wanted = gender.toLowerCase();
        const pick =
          scanned.choices.find((c) => c.text.toLowerCase() === wanted) ||
          scanned.choices.find((c) => c.text.toLowerCase().includes(wanted));
        if (pick) {
          const clicked = await this.safeClick(page, pick.selector);
          console.log(`[WIZARD][CHOICE] gender="${gender}" picked="${pick.text}" clicked=${clicked}`);
          if (clicked) {
            actions.push(`Пол: ${pick.text}`);
            didInteract = true;
          }
        }
      }

      const needNow = this.buildWizardNeedPayload(scanned, data);
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
        await this.waitForWizardStepChange(page, beforeSig);

        if (await this.detectWizardSuccess(page)) {
          const obs = await this.quickObserve(page);
          console.log(`[WIZARD] success detected after click at step=${step}`);
          return { ok: true, message: actions.length ? `Wizard: ${actions.join(", ")}` : "Wizard: изпълнено", observation: obs };
        }

        const afterSig = await this.getWizardDomSignature(page);
        const nextScanned = await this.scanWizardStep(page);
        const nextNeed = this.buildWizardNeedPayload(nextScanned, data);

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
  }

  // ─────────────────────────────────────────────────────────
  // Wizard helpers
  // ─────────────────────────────────────────────────────────

  private wizardFieldText(f: WizardScannedField): string {
    return `${f.name || ""} ${f.id || ""} ${f.label || ""} ${f.placeholder || ""} ${f.aria_label || ""}`.toLowerCase();
  }

  private buildWizardNeedPayload(scanned: { fields: WizardScannedField[]; choices: WizardChoiceButton[] }, data: Record<string, unknown>) {
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

    return { missing_required, fields, choices: scanned.choices };
  }

  private matchWizardDataForField(f: WizardScannedField, data: Record<string, unknown>): { key: string; value: string } | null {
    // keep existing logic but add label-key fallback
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

    // NEW: label-key match for label-based payload keys
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
    // 1) direct by name/id
    if (field.name && data[field.name] !== undefined) return String(data[field.name]);
    if (field.id && data[field.id] !== undefined) return String(data[field.id]);

    const t = this.wizardFieldText(field);

    // 2) common semantics
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

    // NEW: robust label-key match for payload keys like "Три имена *"
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

    // 3) fallback: old deterministic "includes"
    for (const k of Object.keys(data || {})) {
      if (!k) continue;
      const kk = k.toLowerCase();
      if (kk.length < 3) continue;
      if (t.includes(kk) && (data as any)[k] !== undefined) return String((data as any)[k]);
    }

    return undefined;
  }

  private async fillWizardField(page: Page, f: WizardScannedField, value: string): Promise<boolean> {
    const valSummary = summarizeValue(f.name || f.type, value);

    // NEW: try selector_candidates first (stable), then fallback to f.selector
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
          const ok = await this.smartSelectOption(page, sel, String(value));
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

  private async scanWizardStep(page: Page): Promise<{ fields: WizardScannedField[]; choices: WizardChoiceButton[] }> {
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

        // type-based (not unique but good fallback with .first())
        if (tag === "input" && type) out.push(`input[type="${type}"]`);
        if (tag === "textarea") out.push("textarea");
        if (tag === "select") out.push("select");

        // best-effort unique-ish selector as last
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

      const btns = Array.from(document.querySelectorAll("button, [role='button']"))
        .filter((el) => isVisible(el))
        .map((el) => {
          const t = (el.textContent || "").trim();
          return { text: t, selector: getSelector(el) };
        })
        .filter((b) => ["мъж", "жена"].includes((b.text || "").trim().toLowerCase()))
        .slice(0, 6);

      return { fields, choices: btns };
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

  private async detectWizardSuccess(page: Page): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        const txt = (document.body?.innerText || "").toLowerCase();
        const hits = ["благодар", "успеш", "изпрат", "thank you", "success", "submitted"];
        return hits.some((h) => txt.includes(h));
      });
    } catch {
      return false;
    }
  }

  private async fillSingleField(page: Page, f: FormSchemaField, value: string): Promise<string | null> {
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
          const ok = await this.smartSelectOption(page, sel, String(value));
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

  private async smartSelectOption(page: Page, selectSelector: string, desired: string): Promise<boolean> {
    const wanted = (desired || "").trim().toLowerCase();

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

    console.log(`[SELECT] selector=${selectSelector} desired="${desired}" options=${options.length}`);
    for (const o of options.slice(0, 20)) {
      console.log(`[SELECT][OPT] value="${o.value}" label="${o.label}"`);
    }

    let picked =
      options.find((o) => o.value.trim().toLowerCase() === wanted) ||
      options.find((o) => o.label.trim().toLowerCase() === wanted) ||
      (wanted ? options.find((o) => o.label.trim().toLowerCase().includes(wanted)) : undefined) ||
      options.find((o) => (o.value || "").trim() !== "");

    if (!picked) return false;

    const ok = await page.evaluate<boolean, { sel: string; v: string }>(
      ({ sel, v }) => {
        const el = document.querySelector(sel) as HTMLSelectElement | null;
        if (!el) return false;
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      { sel: selectSelector, v: picked!.value }
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
    res.json({ name: "NEO Worker", version: "6.0.3-wizard-labelmatch", mode: "schema-first" });
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
    console.log(`[HTTP][/fill-form] site_id=${body.site_id} session_id=${body.session_id || ""} form_id=${body.form_id || ""} fingerprint=${(body.fingerprint || "").slice(0, 12)} kind=${body.kind || ""} auto_submit=${body.auto_submit !== false}`);
    console.log(`[HTTP][/fill-form] data_keys=${dataKeys.join(",")} confirmed_keys=${confKeys.join(",")}`);

    const r = await manager.executeFillForm(body);
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
    console.log(`🚀 NEO Worker v6.0.3-wizard-labelmatch listening on :${PORT}`);
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
