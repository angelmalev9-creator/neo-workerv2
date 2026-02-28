/**
 * NEO WORKER v6.0 — Universal, deterministic, schema-first (NO KEYWORDS)
 *
 * Goals:
 * - Use DB form_schemas as source of truth.
 * - Fill fields deterministically by schema.
 * - Always attempt submit after filling (schema submit candidates + universal fallbacks).
 * - Accept Gemini "confirmed" sensitive data (preferred over raw STT).
 *
 * Endpoints:
 * - GET  /                 info
 * - GET  /health           status
 * - POST /prepare-session  hot session
 * - POST /fill-form        deterministic fill by form_id/fingerprint/kind
 * - POST /execute          legacy compatible (data-driven schema pick)
 * - GET  /forms/:sessionId list schemas (cache/db)
 * - POST /refresh-forms    refresh schema cache
 * - POST /close-session    close hot session
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
  data: Record<string, string>;
  confirmed?: {
    name?: string;
    email?: string;
    phone?: string;
    message?: string;
    [k: string]: string | undefined;
  };
  file?: {
    field_name: string;
    base64: string;
    filename: string;
    mime_type: string;
  };
  auto_submit?: boolean;
}

interface ExecuteRequest {
  site_id: string;
  session_id?: string;
  keywords: string[]; // legacy; ignored for decisions
  data?: Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────
// Supabase helper
// ───────────────────────────────────────────────────────────────

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

  // common STT artifacts
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

  // normalize conventional keys
  if (merged.email) merged.email = normalizeEmail(merged.email);
  if (merged.phone) merged.phone = normalizePhone(merged.phone);

  // aliases (harmless)
  if (!merged.email && (merged as any).e_mail) merged.email = normalizeEmail((merged as any).e_mail);
  if (!merged.phone && (merged as any).telephone) merged.phone = normalizePhone((merged as any).telephone);

  return merged;
}

// ───────────────────────────────────────────────────────────────
// Generic field semantics (NO site-specific keywords)
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
function isDateField(f: FormSchemaField): boolean {
  const t = fieldText(f);
  return f.type === "date" || /date|дата|check.?in|check.?out|arrival|departure|настан|напуск/.test(t);
}
function isGuestsField(f: FormSchemaField): boolean {
  const t = fieldText(f);
  return f.type === "number" || /guests|adults|persons|people|гост|душ|човек|брой/.test(t);
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
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
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
    if (oldest) this.closeSession(oldest.id);
  }

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > this.SESSION_TIMEOUT) this.closeSession(id);
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
  // /fill-form (main deterministic path)
  // ─────────────────────────────────────────────────────────

  async executeFillForm(request: FillFormRequest): Promise<{ success: boolean; message: string; observation?: JsonObj }> {
    const { site_id, session_id, form_id, fingerprint, kind, data, confirmed, file } = request;
    const autoSubmit = request.auto_submit !== false;

    const session = this.sessions.get(site_id);
    if (!session) return { success: false, message: "Няма активна сесия" };

    session.lastActivity = Date.now();

    // Make sure schemas are loaded
    if (session.formSchemas.length === 0 && (session_id || session.sessionId)) {
      session.formSchemas = await this.loadFormSchemas(session_id || session.sessionId || site_id);
    }

    // Select schema
    let schema: FormSchemaRow | undefined;
    if (form_id) schema = session.formSchemas.find(s => s.id === form_id);
    else if (fingerprint) schema = session.formSchemas.find(s => s.fingerprint === fingerprint);
    else if (kind) schema = session.formSchemas.find(s => s.kind === kind);
    else schema = session.formSchemas.find(s => s.kind === "form" || s.kind === "wizard");

    if (!schema) {
      return { success: false, message: `Не намерих форма (schemas=${session.formSchemas.length})` };
    }

    console.log(`[FILL-FORM] kind=${schema.kind} fingerprint=${schema.fingerprint.slice(0, 12)}… fields=${schema.schema.fields?.length || 0}`);

    // Prefer Gemini confirmed > raw
    const merged = mergeConfirmedData(data || {}, confirmed as any);

    // Navigate if schema.url is different
    await this.ensureOnSchemaUrl(session.page, schema.url);

    // Fill
    let result: { message: string; observation?: JsonObj };
    if (schema.kind === "wizard") {
      result = await this.fillWizard(session.page, schema, merged, autoSubmit);
    } else {
      result = await this.fillFormSchema(session.page, schema, merged, file, autoSubmit);
    }

    return { success: true, ...result };
  }

  // ─────────────────────────────────────────────────────────
  // /execute (legacy compatible, NO KEYWORDS decisions)
  // ─────────────────────────────────────────────────────────

  async execute(req: ExecuteRequest): Promise<{ success: boolean; message: string; observation?: JsonObj; form_schemas?: FormSchemaRow[] }> {
    const { site_id, session_id, data } = req;
    let session = this.sessions.get(site_id);
    if (!session) return { success: false, message: "Няма активна сесия. Моля, изчакайте зареждане." };

    session.lastActivity = Date.now();

    if (session_id && session.sessionId !== session_id && session.formSchemas.length === 0) {
      session.sessionId = session_id;
      session.formSchemas = await this.loadFormSchemas(session_id);
    }

    // If data provided: pick best schema by field coverage
    if (data && Object.keys(data).length > 0 && session.formSchemas.length > 0) {
      const best = this.pickBestSchema(session.formSchemas, data);
      if (best) {
        await this.ensureOnSchemaUrl(session.page, best.url);
        if (best.kind === "wizard") {
          const r = await this.fillWizard(session.page, best, data, true);
          return { success: true, ...r };
        }
        const r = await this.fillFormSchema(session.page, best, data, undefined, true);
        return { success: true, ...r };
      }
    }

    // If no data: return forms list if any
    if (session.formSchemas.length > 0) {
      return { success: true, message: this.describeSchemas(session.formSchemas), form_schemas: session.formSchemas };
    }

    // Otherwise observe
    const obs = await this.quickObserve(session.page);
    return { success: true, message: `Страница: "${String(obs.title || "")}"`, observation: obs };
  }

  private pickBestSchema(schemas: FormSchemaRow[], data: Record<string, unknown>): FormSchemaRow | null {
    const keys = new Set(Object.keys(data).map(k => k.toLowerCase()));
    let best: { s: FormSchemaRow; score: number } | null = null;

    for (const s of schemas) {
      if (s.kind !== "form" && s.kind !== "wizard") continue;
      const fields = s.schema.fields || [];
      if (fields.length === 0) continue;

      let score = 0;

      for (const f of fields) {
        if (f.name && keys.has(f.name.toLowerCase())) score += 3;
        if (isEmailField(f) && (keys.has("email") || /@/.test(String((data as any).email || "")))) score += 4;
        if (isPhoneField(f) && (keys.has("phone") || keys.has("telephone"))) score += 3;
        if (isNameField(f) && (keys.has("name") || keys.has("full_name") || keys.has("first_name"))) score += 2;
        if (isMessageField(f) && (keys.has("message") || keys.has("note") || keys.has("comment"))) score += 2;
        if (isDateField(f) && (keys.has("check_in") || keys.has("check_out"))) score += 2;
        if (isGuestsField(f) && keys.has("guests")) score += 1;
        if (f.required) score += 0.1;
      }

      if (s.schema.submit) score += 0.5;

      if (!best || score > best.score) best = { s, score };
    }

    return best ? best.s : null;
  }

  private describeSchemas(schemas: FormSchemaRow[]): string {
    const lines = schemas.slice(0, 20).map((s, i) => {
      const fields = (s.schema.fields || []).map(f => f.label || f.name || f.placeholder || f.type).filter(Boolean).slice(0, 6);
      const submit = s.schema.submit?.text ? ` submit="${s.schema.submit?.text}"` : "";
      return `${i + 1}. kind=${s.kind}${submit} fields=[${fields.join(", ")}] url=${s.url}`;
    });
    return `Налични форми (${schemas.length}):\n${lines.join("\n")}`;
  }

  private async ensureOnSchemaUrl(page: Page, schemaUrl?: string) {
    if (!schemaUrl) return;
    try {
      const cur = new URL(page.url());
      const target = new URL(schemaUrl);
      if (cur.pathname === target.pathname) return;
    } catch {
      // ignore
    }

    try {
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
    // exact by name
    if (field.name && data[field.name] !== undefined) return String(data[field.name]);

    // semantic mapping
    if (isEmailField(field) && (data as any).email) return String((data as any).email);
    if (isPhoneField(field) && ((data as any).phone || (data as any).telephone)) return String((data as any).phone || (data as any).telephone);
    if (isNameField(field) && ((data as any).name || (data as any).full_name || (data as any).first_name)) return String((data as any).name || (data as any).full_name || (data as any).first_name);
    if (isMessageField(field) && ((data as any).message || (data as any).note || (data as any).comment)) return String((data as any).message || (data as any).note || (data as any).comment);

    if (isDateField(field) && ((data as any).check_in || (data as any).check_out)) {
      const t = fieldText(field);
      if (/out|departure|напуск|заминав/.test(t) && (data as any).check_out) return String((data as any).check_out);
      if ((data as any).check_in) return String((data as any).check_in);
      if ((data as any).check_out) return String((data as any).check_out);
    }

    if (isGuestsField(field) && (data as any).guests !== undefined) return String((data as any).guests);

    return undefined;
  }

  private async fillFormSchema(
    page: Page,
    schema: FormSchemaRow,
    data: Record<string, unknown>,
    file?: FillFormRequest["file"],
    autoSubmit = true
  ): Promise<{ message: string; observation?: JsonObj }> {
    const fields = schema.schema.fields || [];
    const actions: string[] = [];
    const filledCount: number[] = [0];

    for (const f of fields) {
      const v = this.matchFieldValue(f, data);
      if (!v) continue;

      const ok = await this.fillSingleField(page, f, v);
      if (ok) {
        filledCount[0] += 1;
        actions.push(`${f.label || f.name || f.placeholder || f.type}: ${v}`);
      }
    }

    if (file) {
      const up = await this.uploadFile(page, fields, file);
      if (up) actions.push(`Файл: ${file.filename}`);
    }

    const submitInfo: JsonObj = {};
    if (autoSubmit) {
      const submit = await this.trySubmitUniversal(page, schema);
      submitInfo.submit_attempted = submit.attempted;
      submitInfo.submit_method = submit.method;
      submitInfo.submit_clicked = submit.clicked;
      submitInfo.submit_debug = submit.debug;

      if (submit.clicked) actions.push("Кликнах Изпрати");
      else actions.push("Не намерих submit бутон за клик");
    }

    const obs = await this.quickObserve(page);
    obs.submit = submitInfo;

    return {
      message: actions.length ? `Попълних: ${actions.join(", ")}` : "Не успях да попълня полета",
      observation: obs,
    };
  }

  private async fillWizard(
    page: Page,
    schema: FormSchemaRow,
    data: Record<string, unknown>,
    autoSubmit = true
  ): Promise<{ message: string; observation?: JsonObj }> {
    const fields = schema.schema.fields || [];
    const actions: string[] = [];
    const maxSteps = 8;

    for (let step = 0; step < maxSteps; step++) {
      // fill visible fields only
      for (const f of fields) {
        const v = this.matchFieldValue(f, data);
        if (!v) continue;
        const visible = await this.isFieldVisible(page, f);
        if (!visible) continue;

        const ok = await this.fillSingleField(page, f, v);
        if (ok) actions.push(`${f.label || f.name || f.type}: ${v}`);
      }

      const nextClicked = await this.clickNextStepUniversal(page);
      if (!nextClicked) break;
      await page.waitForTimeout(700);
    }

    const submitInfo: JsonObj = {};
    if (autoSubmit) {
      const submit = await this.trySubmitUniversal(page, schema);
      submitInfo.submit_attempted = submit.attempted;
      submitInfo.submit_method = submit.method;
      submitInfo.submit_clicked = submit.clicked;
      submitInfo.submit_debug = submit.debug;
      if (submit.clicked) actions.push("Кликнах Изпрати");
      else actions.push("Не намерих submit бутон за клик");
    }

    const obs = await this.quickObserve(page);
    obs.submit = submitInfo;

    return {
      message: actions.length ? `Wizard: ${actions.join(", ")}` : "Wizard: не намерих полета/бутони",
      observation: obs,
    };
  }

  private async isFieldVisible(page: Page, f: FormSchemaField): Promise<boolean> {
    const selectors = [...(f.selector_candidates || [])];
    if (f.name) selectors.push(`[name="${f.name}"]`);
    if (f.name) selectors.push(`#${f.name}`);

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (visible) return true;
      } catch {}
    }
    return false;
  }

  private async fillSingleField(page: Page, f: FormSchemaField, value: string): Promise<boolean> {
  const selectors = [
    ...(f.selector_candidates || []),
    f.name ? `[name="${f.name}"]` : "",
    f.name ? `#${f.name}` : "",
  ].filter(Boolean);

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;

      const visible = await el.isVisible().catch(() => false);
      if (!visible && f.tag !== "select") continue;

      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 1200 }).catch(() => {});

      // SMART SELECT
      if (f.tag === "select" || f.type === "select") {
        const ok = await this.smartSelectOption(page, sel, value);
        return ok;
      }

      if (f.type === "file") continue;

      await page.fill(sel, value, { timeout: 3000 });
      await page.keyboard.press("Tab").catch(() => {});
      await page.waitForTimeout(100).catch(() => {});
      return true;

    } catch {}
  }

  return false;
}
        // select
        if (f.tag === "select" || f.type === "select") {
          await page.selectOption(sel, value, { timeout: 2500 });
          await page.waitForTimeout(150).catch(() => {});
          return true;
        }

        // file is handled separately
        if (f.type === "file") continue;

        await page.fill(sel, value, { timeout: 3000 });

        // blur
        await page.keyboard.press("Tab").catch(() => {});
        await page.waitForTimeout(100).catch(() => {});
        return true;
      } catch {}
    }

    return false;
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

      // choose best file field
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
    } catch (e) {
      console.error("[UPLOAD] error:", e);
      try { fs.unlinkSync(tmpPath); } catch {}
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────
  // Universal NEXT and SUBMIT clicks
  // ─────────────────────────────────────────────────────────

  private async clickNextStepUniversal(page: Page): Promise<boolean> {
    const selectors = [
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Продължи")',
      'button:has-text("Напред")',
      'button:has-text("Следваща")',
      'a:has-text("Next")',
      'a:has-text("Continue")',
      'a:has-text("Продължи")',
      "[class*='next'] button",
      "[class*='next']",
    ];

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 2000, force: true });
        return true;
      } catch {}
    }
    return false;
  }

  private async clickBySelectors(
    page: Page,
    selectors: string[],
    debug: string[]
  ): Promise<boolean> {
    for (const sel of selectors) {
      if (!sel) continue;
      try {
        const el = await page.$(sel);
        if (!el) continue;

        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;

        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 3000, force: true });
        debug.push(`clicked:${sel}`);
        return true;
      } catch (e) {
        debug.push(`fail:${sel}`);
      }
    }
    return false;
  }

  private async clickByTextHeuristic(
    page: Page,
    text: string,
    debug: string[]
  ): Promise<boolean> {
    const t = (text || "").trim();
    if (!t) return false;

    // Try strict-ish strategies
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

  private async clickBestSubmitInDOM(page: Page, debug: string[]): Promise<boolean> {
    // Last resort: choose the most "submit-like" button/input visible
    try {
      const ok = await page.evaluate(() => {
        const isVisible = (el: Element) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          const style = window.getComputedStyle(el as HTMLElement);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };

        const score = (el: Element) => {
          const tag = el.tagName.toLowerCase();
          const type = (el as any).type ? String((el as any).type).toLowerCase() : "";
          const text = ((el as any).value || el.textContent || "").toString().trim().toLowerCase();
          let s = 0;

          // strongest: explicit submit
          if (tag === "button" && type === "submit") s += 50;
          if (tag === "input" && type === "submit") s += 50;

          // generic submit-ish text
          const words = ["изпрати", "изпрат", "прати", "submit", "send", "request", "заяви", "оферта", "запитване"];
          if (words.some(w => text.includes(w))) s += 20;

          // forms: prefer inside form
          if (el.closest("form")) s += 10;

          // disabled penalty
          const disabled = (el as any).disabled === true || el.getAttribute("aria-disabled") === "true";
          if (disabled) s -= 100;

          return s;
        };

        const nodes = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button'], a[role='button'], [role='button']"))
          .filter(isVisible);

        if (nodes.length === 0) return false;

        nodes.sort((a, b) => score(b) - score(a));
        const best = nodes[0] as HTMLElement;
        best.click();
        return true;
      });

      if (ok) {
        debug.push("clicked_dom_best_submit");
        return true;
      }
    } catch {
      debug.push("fail_dom_best_submit");
    }

    return false;
  }

  private async trySubmitUniversal(
    page: Page,
    schema?: FormSchemaRow
  ): Promise<{ attempted: boolean; clicked: boolean; method: string; debug: string[] }> {
    const debug: string[] = [];
    const attempted = true;

    // 1) schema submit selectors
    const schemaSelectors = schema?.schema.submit?.selector_candidates || [];
    if (schemaSelectors.length) {
      const ok = await this.clickBySelectors(page, schemaSelectors, debug);
      if (ok) {
        await page.waitForTimeout(700).catch(() => {});
        return { attempted, clicked: true, method: "schema.selector_candidates", debug };
      }
    }

    // 2) schema submit text
    const submitText = (schema?.schema.submit?.text || "").trim();
    if (submitText) {
      const ok = await this.clickByTextHeuristic(page, submitText, debug);
      if (ok) {
        await page.waitForTimeout(700).catch(() => {});
        return { attempted, clicked: true, method: "schema.text", debug };
      }
    }

    // 3) universal submit selectors
    const universalSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Изпрати")',
      'button:has-text("Изпрат")',
      'button:has-text("Прати")',
      'button:has-text("Submit")',
      'button:has-text("Send")',
      'input[type="button"][value*="Изпрати"]',
      'input[type="button"][value*="Submit"]',
    ];

    {
      const ok = await this.clickBySelectors(page, universalSelectors, debug);
      if (ok) {
        await page.waitForTimeout(700).catch(() => {});
        return { attempted, clicked: true, method: "universal_selectors", debug };
      }
    }

    // 4) last resort: find best submit element in DOM and click it
    {
      const ok = await this.clickBestSubmitInDOM(page, debug);
      if (ok) {
        await page.waitForTimeout(700).catch(() => {});
        return { attempted, clicked: true, method: "dom_best_submit", debug };
      }
    }

    // 5) final fallback: requestSubmit()
    try {
      const ok = await page.evaluate(() => {
        const form = document.querySelector("form") as any;
        if (!form) return false;
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
          return true;
        }
        form.submit();
        return true;
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

  // ─────────────────────────────────────────────────────────
  // Observation
  // ─────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────
  // API helper for /forms/:sessionId
  // ─────────────────────────────────────────────────────────

  async loadSchemasForApi(sessionId: string): Promise<FormSchemaRow[]> {
    return this.loadFormSchemas(sessionId);
  }

  // expose sessions for API check
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

  // Auth middleware
  app.use((req, res, next) => {
    if (req.path === "/" || req.path === "/health") return next();
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (token !== WORKER_SECRET) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
  });

  app.get("/", (_, res) => {
    res.json({ name: "NEO Worker", version: "6.0.0", mode: "schema-first", keywords: "disabled" });
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
    const r = await manager.executeFillForm(body);
    res.json(r);
  });

  // legacy compatible: data-driven (NO keywords decisions)
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

    // try cache
    const cached = manager.getSessionByDbSessionId(sessionId);
    if (cached) return res.json({ success: true, source: "cache", forms: cached.formSchemas });

    // fallback db
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
    console.log(`🚀 NEO Worker v6.0 listening on :${PORT}`);
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
