/**
 * NEO WORKER v5.1 - Deterministic Form Actions (DB form_schemas first)
 *
 * ВАЖНО:
 * - /fill-form е главният deterministic flow (form_schema -> fill -> submit).
 * - /execute е оставен за backward compatibility, но НЕ разчита на site-specific keywords.
 *   Ако има data -> опитва да попълни най-подходящата форма по schema scoring.
 *
 * ENDPOINTS:
 * - GET  /                 — info
 * - GET  /health           — status
 * - POST /prepare-session  — подготвя hot session (от crawler)
 * - POST /execute          — legacy compatible (data-driven, not keyword-driven)
 * - POST /interact         — legacy endpoint
 * - POST /close-session    — затваря session
 * - POST /close            — legacy close
 * - POST /fill-form        — NEW: deterministic fill конкретна form_schema по id/fingerprint
 * - GET  /forms/:sessionId — NEW: връща form_schemas за session
 * - POST /refresh-forms    — refresh schema cache
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import express, { Request, Response } from "express";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const PORT = parseInt(process.env.PORT || "3000");
const WORKER_SECRET = process.env.NEO_WORKER_SECRET || "change-me-in-production";

// Supabase (optional — worker degrades gracefully if missing)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY =
  process.env.NEO_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";

// ───────────────────────────────────────────────────────────────
// TYPES
// ───────────────────────────────────────────────────────────────

interface SiteMapButton {
  text: string;
  selector: string;
  keywords: string[];
  action_type: "booking" | "contact" | "navigation" | "submit" | "other";
}

interface SiteMapField {
  name: string;
  selector: string;
  type: "date" | "number" | "text" | "select";
  keywords: string[];
}

interface SiteMapForm {
  selector: string;
  fields: SiteMapField[];
  submit_button: string;
}

interface SiteMap {
  site_id: string;
  url: string;
  buttons: SiteMapButton[];
  forms: SiteMapForm[];
  prices: Array<{ text: string; context: string }>;
}

// ── DB form_schemas row ──

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
    date_inputs?: Array<{
      name: string;
      label: string;
      selector_candidates: string[];
      required?: boolean;
    }>;
    calendar_containers?: Array<{
      selector_candidates: string[];
      text_hint: string;
    }>;
  };
  dom_snapshot: string | null;
}

interface HotSession {
  page: Page;
  context: BrowserContext;
  siteMap: SiteMap;
  sessionId: string | null; // DB session_id (may differ from site_id)
  formSchemas: FormSchemaRow[]; // loaded from DB
  lastActivity: number;
  currentUrl: string;
}

interface ExecuteRequest {
  site_id: string;
  session_id?: string; // optional DB session_id for form_schemas lookup
  keywords: string[]; // legacy, но вече не се ползва за решения
  data?: Record<string, unknown>;
}

interface FillFormRequest {
  site_id: string;
  session_id?: string;
  form_id?: string; // form_schemas.id (uuid)
  fingerprint?: string; // form_schemas.fingerprint
  kind?: string; // filter by kind
  data: Record<string, string>; // field_name → value

  // ✅ Gemini confirmed / cleaned sensitive data (preferred over raw STT)
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

  auto_submit?: boolean; // default true
}

// Legacy interface
interface InteractRequest {
  site_url: string;
  user_message: string;
  session_id: string;
  conversation_history: Array<{ role: string; content: string }>;
  booking_data?: {
    check_in?: string;
    check_out?: string;
    guests?: number;
  };
}

// ───────────────────────────────────────────────────────────────
// SUPABASE HELPER
// ───────────────────────────────────────────────────────────────

function createSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.log("[DB] Supabase not configured — running without DB");
    return null;
  }
  try {
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  } catch (err) {
    console.error("[DB] Failed to create Supabase client:", err);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────
// NORMALIZATION + CONFIRMED MERGE (Gemini > raw STT)
// ───────────────────────────────────────────────────────────────

function normalizeEmail(input: unknown): string {
  const s = (typeof input === "string" ? input : "").trim().toLowerCase();
  if (!s) return "";
  let out = s
    .replace(/\s+/g, "")
    .replace(/\(at\)|\[at\]/g, "@")
    .replace(/\(dot\)|\[dot\]/g, ".")
    .replace(/。/g, ".")
    .replace(/[;,]+$/g, "");

  // common speech-to-text artifacts
  out = out.replace(/( at | at)/g, "@").replace(/( dot | dot)/g, ".");
  out = out.replace(/,/g, "."); // some STT returns comma

  const parts = out.split("@");
  if (parts.length > 2) out = parts[0] + "@" + parts.slice(1).join("");
  return out;
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
  if (!confirmed || typeof confirmed !== "object") {
    const out = { ...data };
    if ((out as any).email) (out as any).email = normalizeEmail((out as any).email);
    if ((out as any).phone) (out as any).phone = normalizePhone((out as any).phone);
    return out;
  }

  const merged: Record<string, unknown> = { ...data, ...confirmed };

  // normalize common keys
  if ((merged as any).email) (merged as any).email = normalizeEmail((merged as any).email);
  if ((merged as any).phone) (merged as any).phone = normalizePhone((merged as any).phone);

  // alias keys (optional)
  if (!(merged as any).email && (merged as any).e_mail)
    (merged as any).email = normalizeEmail((merged as any).e_mail);

  if (!(merged as any).phone && (merged as any).telephone)
    (merged as any).phone = normalizePhone((merged as any).telephone);

  return merged;
}

// ───────────────────────────────────────────────────────────────
// FIELD SEMANTIC MATCHING (NO site-specific keyword lists)
// ───────────────────────────────────────────────────────────────

function fieldText(field: FormSchemaField): string {
  return `${field.name || ""} ${field.label || ""} ${field.placeholder || ""} ${field.autocomplete || ""} ${field.aria_label || ""}`.toLowerCase();
}

function looksLikeEmailField(field: FormSchemaField): boolean {
  const t = fieldText(field);
  return field.type === "email" || /e-?mail|email|имейл|поща/.test(t);
}

function looksLikePhoneField(field: FormSchemaField): boolean {
  const t = fieldText(field);
  return field.type === "tel" || /phone|tel|телефон|мобил|gsm/.test(t);
}

function looksLikeNameField(field: FormSchemaField): boolean {
  const t = fieldText(field);
  return /name|име|first|last|fullname|фамил/.test(t);
}

function looksLikeMessageField(field: FormSchemaField): boolean {
  const t = fieldText(field);
  return field.tag === "textarea" || /message|съобщ|забел|note|comment|описание/.test(t);
}

function looksLikeDateField(field: FormSchemaField): boolean {
  const t = fieldText(field);
  return field.type === "date" || /date|дата|check.?in|check.?out|arrival|departure|настан|напуск/.test(t);
}

function looksLikeGuestsField(field: FormSchemaField): boolean {
  const t = fieldText(field);
  return /guests|adults|persons|people|гост|душ|човек|брой/.test(t) || field.type === "number";
}

// ───────────────────────────────────────────────────────────────
// HOT SESSION MANAGER
// ───────────────────────────────────────────────────────────────

class HotSessionManager {
  private browser: Browser | null = null;
  private sessions: Map<string, HotSession> = new Map();
  private isReady = false;
  private supabase: SupabaseClient | null = null;

  // Config
  private readonly MAX_SESSIONS = 50;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  async start(): Promise<void> {
    console.log("[WORKER] Starting browser...");

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

    console.log("[WORKER] ✓ Ready!");
    console.log(`[WORKER] DB: ${this.supabase ? "connected" : "not configured"}`);
  }

  // ─────────────────────────────────────────────────────────
  // DB: LOAD form_schemas for a session
  // ─────────────────────────────────────────────────────────

  private async loadFormSchemas(sessionId: string): Promise<FormSchemaRow[]> {
    if (!this.supabase || !sessionId) return [];

    try {
      const { data, error } = await this.supabase
        .from("form_schemas")
        .select("*")
        .eq("session_id", sessionId)
        .limit(30);

      if (error) {
        console.error(`[DB] form_schemas query error:`, error.message);
        return [];
      }

      const rows = (data || []) as FormSchemaRow[];
      console.log(`[DB] Loaded ${rows.length} form_schemas for session ${sessionId.slice(0, 8)}…`);
      return rows;
    } catch (err) {
      console.error("[DB] loadFormSchemas error:", err);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────
  // PREPARE SESSION
  // ─────────────────────────────────────────────────────────

  async prepareSession(siteId: string, siteMap: SiteMap, sessionId?: string): Promise<boolean> {
    if (!this.isReady || !this.browser) {
      console.error("[PREPARE] Browser not ready");
      return false;
    }

    const startTime = Date.now();
    console.log(`[PREPARE] Site: ${siteId}`);
    console.log(`[PREPARE] URL: ${siteMap.url}`);
    console.log(`[PREPARE] Buttons: ${siteMap.buttons?.length || 0}, Forms: ${siteMap.forms?.length || 0}, Prices: ${siteMap.prices?.length || 0}`);

    try {
      await this.closeSession(siteId);

      if (this.sessions.size >= this.MAX_SESSIONS) {
        this.evictOldestSession();
      }

      const context = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        locale: "bg-BG",
        timezoneId: "Europe/Sofia",
        ignoreHTTPSErrors: true,
      });

      const page = await context.newPage();

      let url = siteMap.url;
      if (!url.startsWith("http")) url = "https://" + url;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500);

      const dbSessionId = sessionId || siteId;
      const formSchemas = await this.loadFormSchemas(dbSessionId);

      this.sessions.set(siteId, {
        page,
        context,
        siteMap,
        sessionId: dbSessionId,
        formSchemas,
        lastActivity: Date.now(),
        currentUrl: page.url(),
      });

      const elapsed = Date.now() - startTime;
      console.log(`[PREPARE] ✓ Session ready in ${elapsed}ms (${formSchemas.length} form schemas)`);
      return true;
    } catch (error) {
      console.error(`[PREPARE] ✗ Failed:`, error);
      return false;
    }
  }

  async refreshFormSchemas(siteId: string): Promise<FormSchemaRow[]> {
    const session = this.sessions.get(siteId);
    if (!session) return [];

    const dbSessionId = session.sessionId || siteId;
    const schemas = await this.loadFormSchemas(dbSessionId);
    session.formSchemas = schemas;
    return schemas;
  }

  // ─────────────────────────────────────────────────────────
  // EXECUTE (legacy compatible, NOT keyword-driven)
  // ─────────────────────────────────────────────────────────

  async execute(
    request: ExecuteRequest
  ): Promise<{
    success: boolean;
    message: string;
    observation?: Record<string, unknown>;
    form_schemas?: FormSchemaRow[];
  }> {
    const { site_id, session_id, data } = request;
    let session = this.sessions.get(site_id);

    if (!session) {
      console.log(`[EXECUTE] No session for ${site_id}`);
      return { success: false, message: "Няма активна сесия. Моля, изчакайте зареждане." };
    }

    if (session_id && session.sessionId !== session_id && session.formSchemas.length === 0) {
      session.sessionId = session_id;
      session.formSchemas = await this.loadFormSchemas(session_id);
    }

    const startTime = Date.now();
    session.lastActivity = Date.now();

    console.log(`[EXECUTE] Site: ${site_id}`);
    console.log(`[EXECUTE] FormSchemas: ${session.formSchemas.length}`);
    if (data) console.log(`[EXECUTE] Data keys:`, Object.keys(data));

    try {
      try {
        await session.page.evaluate(() => true);
      } catch {
        console.log(`[EXECUTE] Page closed, recreating...`);
        await this.prepareSession(site_id, session.siteMap, session.sessionId || undefined);
        session = this.sessions.get(site_id)!;
        if (!session) return { success: false, message: "Грешка при възстановяване на сесията" };
      }

      // ✅ Data-driven behavior:
      // - If data exists and schemas exist -> fill best schema
      // - Else -> return forms if available
      // - Else -> observe
      if (data && Object.keys(data).length > 0 && session.formSchemas.length > 0) {
        const best = this.pickBestSchema(session.formSchemas, data);
        if (best) {
          if (best.kind === "wizard") {
            const r = await this.fillWizard(session.page, best, data);
            const elapsed = Date.now() - startTime;
            console.log(`[EXECUTE] ✓ Done in ${elapsed}ms: ${r.message.slice(0, 60)}`);
            return { success: true, ...r };
          }
          const r = await this.fillFormSchema(session.page, best, data, undefined, true);
          const elapsed = Date.now() - startTime;
          console.log(`[EXECUTE] ✓ Done in ${elapsed}ms: ${r.message.slice(0, 60)}`);
          return { success: true, ...r };
        }
      }

      if (session.formSchemas.length > 0) {
        return {
          success: true,
          message: this.describeFormSchemas(session.formSchemas),
          form_schemas: session.formSchemas,
        };
      }

      const obs = await this.observeCurrentState(session.page);
      const elapsed = Date.now() - startTime;
      console.log(`[EXECUTE] ✓ Done in ${elapsed}ms: ${obs.message.slice(0, 60)}`);
      return { success: true, ...obs };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[EXECUTE] ✗ Error:`, errMsg);
      return { success: false, message: "Грешка при изпълнение" };
    }
  }

  // Score schema by how well it can accept provided data (no PATTERNS)
  private pickBestSchema(schemas: FormSchemaRow[], data: Record<string, unknown>): FormSchemaRow | null {
    const keys = new Set(Object.keys(data).map((k) => k.toLowerCase()));
    let best: { schema: FormSchemaRow; score: number } | null = null;

    for (const s of schemas) {
      if (s.kind !== "form" && s.kind !== "wizard") continue;
      const fields = s.schema.fields || [];
      if (!fields.length) continue;

      let score = 0;

      for (const f of fields) {
        const t = fieldText(f);

        // direct key match
        if (f.name && keys.has(f.name.toLowerCase())) score += 3;

        // semantic match
        if (looksLikeEmailField(f) && (keys.has("email") || /@/.test(String((data as any).email || "")))) score += 4;
        if (looksLikePhoneField(f) && (keys.has("phone") || keys.has("telephone"))) score += 3;
        if (looksLikeNameField(f) && (keys.has("name") || keys.has("full_name") || keys.has("first_name"))) score += 2;
        if (looksLikeMessageField(f) && (keys.has("message") || keys.has("note") || keys.has("comment"))) score += 2;

        if (looksLikeDateField(f) && (keys.has("check_in") || keys.has("check_out"))) score += 3;
        if (looksLikeGuestsField(f) && keys.has("guests")) score += 2;

        // required fields boost (schema completeness)
        if (f.required && t.length) score += 0.2;
      }

      // slight preference for schemas with submit present (but not required)
      if (s.schema.submit) score += 0.5;

      if (!best || score > best.score) best = { schema: s, score };
    }

    return best ? best.schema : null;
  }

  // ─────────────────────────────────────────────────────────
  // /fill-form (deterministic) by id/fingerprint
  // ─────────────────────────────────────────────────────────

  async executeFillForm(
    request: FillFormRequest
  ): Promise<{ success: boolean; message: string; observation?: Record<string, unknown> }> {
    const { site_id, session_id, form_id, fingerprint, kind, data, file, auto_submit, confirmed } = request;

    const session = this.sessions.get(site_id);
    if (!session) return { success: false, message: "Няма активна сесия" };

    // ✅ prefer Gemini-confirmed sensitive data over raw STT
    const mergedData = mergeConfirmedData(data || {}, confirmed as any);

    if (session.formSchemas.length === 0 && (session_id || session.sessionId)) {
      session.formSchemas = await this.loadFormSchemas(session_id || session.sessionId || site_id);
    }

    let schema: FormSchemaRow | undefined;

    if (form_id) schema = session.formSchemas.find((s) => s.id === form_id);
    else if (fingerprint) schema = session.formSchemas.find((s) => s.fingerprint === fingerprint);
    else if (kind) schema = session.formSchemas.find((s) => s.kind === kind);
    else schema = session.formSchemas.find((s) => s.kind === "form" || s.kind === "wizard");

    if (!schema) {
      return {
        success: false,
        message: `Не намерих форма (schemas: ${session.formSchemas.length}, filter: ${form_id || fingerprint || kind || "default"})`,
      };
    }

    console.log(`[FILL-FORM] kind=${schema.kind} fingerprint=${schema.fingerprint.slice(0, 12)}… fields=${schema.schema.fields?.length || 0}`);
    session.lastActivity = Date.now();

    try {
      try {
        await session.page.evaluate(() => true);
      } catch {
        await this.prepareSession(site_id, session.siteMap, session.sessionId || undefined);
        const newSession = this.sessions.get(site_id);
        if (!newSession) return { success: false, message: "Грешка при възстановяване" };
      }

      const currentSession = this.sessions.get(site_id)!;

      const formUrl = schema.url;
      if (formUrl) {
        try {
          const current = new URL(currentSession.page.url());
          const target = new URL(formUrl);
          if (current.pathname !== target.pathname) {
            console.log(`[FILL-FORM] Navigating to form URL: ${formUrl}`);
            await currentSession.page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
            await currentSession.page.waitForTimeout(1000);
          }
        } catch {
          console.log(`[FILL-FORM] Navigating to form URL (fallback): ${formUrl}`);
          await currentSession.page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
          await currentSession.page.waitForTimeout(1000);
        }
      }

      let result: { message: string; observation?: Record<string, unknown> };

      if (schema.kind === "wizard") {
        result = await this.fillWizard(currentSession.page, schema, mergedData);
      } else {
        result = await this.fillFormSchema(currentSession.page, schema, mergedData, file, auto_submit !== false);
      }

      return { success: true, ...result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[FILL-FORM] Error:", msg);
      return { success: false, message: `Грешка: ${msg}` };
    }
  }

  // ─────────────────────────────────────────────────────────
  // FILL FORM SCHEMA — robust submit even when schema.submit missing
  // ─────────────────────────────────────────────────────────

  private async fillFormSchema(
    page: Page,
    schema: FormSchemaRow,
    data: Record<string, unknown>,
    file?: FillFormRequest["file"],
    autoSubmit = true
  ): Promise<{ message: string; observation?: Record<string, unknown> }> {
    const fields = schema.schema.fields || [];
    const actions: string[] = [];

    if (fields.length === 0) return { message: "Формата няма полета" };

    for (const field of fields) {
      const value = this.matchFieldValue(field, data);
      if (!value) continue;

      const filled = await this.fillSingleField(page, field, value);
      if (filled) {
        const label = field.label || field.name || field.placeholder || field.type;
        actions.push(`${label}: ${value}`);
      }
    }

    if (file) {
      const uploaded = await this.uploadFile(page, fields, file);
      if (uploaded) actions.push(`Файл: ${file.filename}`);
    }

    if (autoSubmit && actions.length > 0) {
      const submitted = await this.trySubmit(page, schema);
      if (submitted) {
        actions.push("Изпратено");
        await page.waitForTimeout(1500);
      }
    }

    const observation = await this.quickObserve(page);

    return {
      message: actions.length > 0 ? `Попълних: ${actions.join(", ")}` : "Не успях да попълня формата — не намерих съвпадащи полета",
      observation,
    };
  }

  private async trySubmit(page: Page, schema?: FormSchemaRow): Promise<boolean> {
    // 1) schema submit candidates
    if (schema?.schema.submit) {
      const ok = await this.clickBySelector(page, schema.schema.submit.selector_candidates, schema.schema.submit.text);
      if (ok) return true;
    }

    // 2) common submit buttons
    const fallbackSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Изпрати")',
      'button:has-text("Изпрат")',
      'button:has-text("Прати")',
      'button:has-text("Submit")',
      'button:has-text("Send")',
    ];

    for (const sel of fallbackSelectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        await el.click({ timeout: 3000 });
        return true;
      } catch {}
    }

    // 3) requestSubmit()
    try {
      const ok = await page.evaluate(() => {
        const form = document.querySelector("form");
        if (!form) return false;
        const anyForm: any = form as any;
        if (typeof anyForm.requestSubmit === "function") {
          anyForm.requestSubmit();
          return true;
        }
        (form as HTMLFormElement).submit();
        return true;
      });
      if (ok) return true;
    } catch {}

    // 4) Enter on first visible field (last resort)
    try {
      const first = await page.$("input:not([type='hidden']):not([disabled]), textarea, select");
      if (first) {
        await first.click({ timeout: 1000 }).catch(() => {});
        await page.keyboard.press("Enter").catch(() => {});
        return true;
      }
    } catch {}

    return false;
  }

  // ─────────────────────────────────────────────────────────
  // FILL WIZARD — multi-step + final submit attempt
  // ─────────────────────────────────────────────────────────

  private async fillWizard(
    page: Page,
    schema: FormSchemaRow,
    data: Record<string, unknown>
  ): Promise<{ message: string; observation?: Record<string, unknown> }> {
    const fields = schema.schema.fields || [];
    const actions: string[] = [];
    const maxSteps = 8;
    let stepsCompleted = 0;

    for (let step = 0; step < maxSteps; step++) {
      const visibleFields = await this.getVisibleFormFields(page);

      if (visibleFields.length === 0 && step > 0) break;

      for (const field of fields) {
        const value = this.matchFieldValue(field, data);
        if (!value) continue;

        const isVisible = await this.isFieldVisible(page, field);
        if (!isVisible) continue;

        const filled = await this.fillSingleField(page, field, value);
        if (filled) {
          const label = field.label || field.name || field.type;
          actions.push(`${label}: ${value}`);
        }
      }

      // also try discovered fields
      for (const vf of visibleFields) {
        const matchedValue = this.matchVisibleFieldToData(vf, data);
        if (matchedValue && !actions.some((a) => a.includes(matchedValue))) {
          const filled = await this.fillSingleField(page, vf, matchedValue);
          if (filled) actions.push(`${vf.label || vf.name}: ${matchedValue}`);
        }
      }

      stepsCompleted++;

      // Next step
      const nextClicked = await this.clickNextStep(page);
      if (!nextClicked) break;

      await page.waitForTimeout(800);
    }

    // Final submit attempt (important for wizards)
    const submitted = await this.trySubmit(page, schema);
    if (submitted) actions.push("Изпратено");

    const observation = await this.quickObserve(page);

    return {
      message: actions.length > 0
        ? `Wizard (${stepsCompleted} стъпки): ${actions.join(", ")}`
        : `Wizard: преминах ${stepsCompleted} стъпки, но не намерих полета за попълване`,
      observation,
    };
  }

  // ─────────────────────────────────────────────────────────
  // NAVIGATE + FILL
  // ─────────────────────────────────────────────────────────

  private async navigateAndFillSchema(
    page: Page,
    schema: FormSchemaRow,
    data: Record<string, unknown>
  ): Promise<{ message: string; observation?: Record<string, unknown> }> {
    const formUrl = schema.url;

    if (formUrl) {
      const currentUrl = page.url();
      try {
        const currentPath = new URL(currentUrl).pathname;
        const targetPath = new URL(formUrl).pathname;
        if (currentPath !== targetPath) {
          console.log(`[NAV] ${currentPath} → ${targetPath}`);
          await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
          await page.waitForTimeout(1000);
        }
      } catch {
        await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForTimeout(1000);
      }
    }

    if (schema.kind === "wizard") return this.fillWizard(page, schema, data);
    return this.fillFormSchema(page, schema, data);
  }

  // ─────────────────────────────────────────────────────────
  // FIELD HELPERS
  // ─────────────────────────────────────────────────────────

  private matchFieldValue(field: FormSchemaField, data: Record<string, unknown>): string | undefined {
    // direct match by exact field name
    if (field.name && data[field.name] !== undefined) return String(data[field.name]);

    // semantic mapping (generic, NOT site-specific)
    if (looksLikeEmailField(field) && (data as any).email) return String((data as any).email);
    if (looksLikePhoneField(field) && ((data as any).phone || (data as any).telephone))
      return String((data as any).phone || (data as any).telephone);

    if (looksLikeNameField(field) && ((data as any).name || (data as any).full_name || (data as any).first_name))
      return String((data as any).name || (data as any).full_name || (data as any).first_name);

    if (looksLikeMessageField(field) && ((data as any).message || (data as any).note || (data as any).comment))
      return String((data as any).message || (data as any).note || (data as any).comment);

    // booking-ish fields (still generic)
    if (looksLikeDateField(field) && ((data as any).check_in || (data as any).check_out)) {
      // if the field text hints "out"/departure choose check_out else check_in
      const t = fieldText(field);
      if (/out|departure|напуск|заминав/.test(t) && (data as any).check_out) return String((data as any).check_out);
      if ((data as any).check_in) return String((data as any).check_in);
      if ((data as any).check_out) return String((data as any).check_out);
    }

    if (looksLikeGuestsField(field) && (data as any).guests !== undefined) return String((data as any).guests);

    return undefined;
  }

  private matchVisibleFieldToData(field: FormSchemaField, data: Record<string, unknown>): string | undefined {
    return this.matchFieldValue(field, data);
  }

  private async fillSingleField(page: Page, field: FormSchemaField, value: string): Promise<boolean> {
    const selectors = [
      ...(field.selector_candidates || []),
      field.name ? `[name="${field.name}"]` : "",
      field.name ? `#${field.name}` : "",
    ].filter(Boolean);

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;

        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;

        if (field.type === "select" || field.tag === "select") {
          await page.selectOption(sel, value, { timeout: 2000 });
          return true;
        }

        if (field.type === "file") continue;

        await el.click({ timeout: 1000 }).catch(() => {});
        await page.fill(sel, value, { timeout: 2000 });

        // blur (some sites validate on blur)
        await page.keyboard.press("Tab").catch(() => {});
        return true;
      } catch {}
    }

    return false;
  }

  private async isFieldVisible(page: Page, field: FormSchemaField): Promise<boolean> {
    const selectors = [
      ...(field.selector_candidates || []),
      field.name ? `[name="${field.name}"]` : "",
    ].filter(Boolean);

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) return true;
        }
      } catch {}
    }
    return false;
  }

  private async getVisibleFormFields(page: Page): Promise<FormSchemaField[]> {
    try {
      return await page.evaluate(() => {
        const fields: any[] = [];
        const inputs = document.querySelectorAll(
          "input:not([type='hidden']):not([type='submit']), select, textarea"
        );

        inputs.forEach((input) => {
          const el = input as HTMLInputElement;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") return;

          const name = el.name || el.id || "";
          const label = (() => {
            if (el.id) {
              const lbl = document.querySelector(`label[for="${el.id}"]`);
              if (lbl) return lbl.textContent?.trim() || "";
            }
            const parent = el.closest("label");
            if (parent) return parent.textContent?.trim() || "";
            return el.getAttribute("aria-label") || "";
          })();

          fields.push({
            tag: el.tagName.toLowerCase(),
            type: (el as any).type || el.tagName.toLowerCase(),
            name,
            label,
            placeholder: (el as any).placeholder || "",
            required: (el as any).required || false,
            autocomplete: (el as any).autocomplete || "",
            selector_candidates: [
              el.id ? `#${el.id}` : "",
              name ? `[name="${name}"]` : "",
            ].filter(Boolean),
          });
        });

        return fields;
      });
    } catch {
      return [];
    }
  }

  private async clickNextStep(page: Page): Promise<boolean> {
    const nextSelectors = [
      'button:has-text("Напред")',
      'button:has-text("Следваща")',
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Продължи")',
      'a:has-text("Напред")',
      'a:has-text("Next")',
      "[class*='next']",
      "[class*='step'] button",
      "text=/напред/i",
      "text=/следваща/i",
      "text=/next/i",
      "text=/continue/i",
      "text=/продълж/i",
    ];

    for (const sel of nextSelectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        await el.click({ timeout: 2000 });
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
    const fileFields = fields.filter((f) => f.type === "file");
    const targetField = fileFields.find((f) => f.name === file.field_name) || fileFields[0];

    const tmpPath = `/tmp/upload_${Date.now()}_${file.filename}`;

    try {
      const buffer = Buffer.from(file.base64, "base64");
      const fs = await import("fs");
      fs.writeFileSync(tmpPath, buffer);

      let selectors: string[] = [];
      if (targetField) {
        selectors = [...(targetField.selector_candidates || [])];
        if (targetField.name) selectors.push(`input[name="${targetField.name}"]`);
      }
      selectors.push('input[type="file"]');

      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await (el as any).setInputFiles(tmpPath);
            console.log(`[UPLOAD] ✓ File set via ${sel}`);
            try { fs.unlinkSync(tmpPath); } catch {}
            return true;
          }
        } catch {}
      }

      try { (await import("fs")).unlinkSync(tmpPath); } catch {}
      return false;
    } catch (err) {
      console.error("[UPLOAD] Error:", err);
      try { (await import("fs")).unlinkSync(tmpPath); } catch {}
      return false;
    }
  }

  private async clickBySelector(page: Page, candidates: string[], text?: string): Promise<boolean> {
    for (const sel of candidates || []) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        await el.click({ timeout: 3000 });
        return true;
      } catch {}
    }

    if (text) {
      const textStrategies = [
        `text="${text}"`,
        `button:has-text("${text}")`,
        `[type="submit"]:has-text("${text}")`,
        `a:has-text("${text}")`,
      ];
      for (const sel of textStrategies) {
        try {
          await page.click(sel, { timeout: 2000 });
          return true;
        } catch {}
      }
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────
  // DESCRIBE FORMS
  // ─────────────────────────────────────────────────────────

  private describeFormSchemas(schemas: FormSchemaRow[]): string {
    if (!schemas.length) return "Не намерих форми на сайта.";

    const parts = schemas.map((s, i) => {
      const fields = s.schema.fields || [];
      const fieldNames = fields
        .map((f) => f.label || f.name || f.placeholder || f.type)
        .filter(Boolean)
        .slice(0, 6);

      const kindLabel: Record<string, string> = {
        form: "Форма",
        wizard: "Wizard (multi-step)",
        booking_widget: "Booking Widget",
        availability: "Availability",
      };

      let desc = `${i + 1}. ${kindLabel[s.kind] || s.kind}`;
      if (s.url) desc += ` @ ${s.url}`;
      if (fieldNames.length) desc += ` — полета: ${fieldNames.join(", ")}`;
      if (s.schema.submit?.text) desc += ` [${s.schema.submit.text}]`;
      return desc;
    });

    return `Налични форми (${schemas.length}):\n${parts.join("\n")}`;
  }

  // ─────────────────────────────────────────────────────────
  // EXISTING ACTIONS (kept, no breaking)
  // ─────────────────────────────────────────────────────────

  private async fillForm(
    page: Page,
    form: SiteMapForm,
    data: Record<string, unknown>
  ): Promise<{ message: string; observation?: Record<string, unknown> }> {
    const actions: string[] = [];
    if (!form.fields) return { message: "Формата няма полета" };

    for (const field of form.fields) {
      let value: string | undefined;

      // legacy fallback: try direct by name keys
      if ((data as any)[field.name] !== undefined) value = String((data as any)[field.name]);

      if (!value) continue;

      try {
        const selectors = [field.selector, `[name="${field.name}"]`, `#${field.name}`].filter(Boolean);

        let filled = false;
        for (const sel of selectors) {
          try {
            const el = await page.$(sel);
            if (!el) continue;
            if (field.type === "select") await page.selectOption(sel, value, { timeout: 2000 });
            else await page.fill(sel, value, { timeout: 2000 });
            filled = true;
            break;
          } catch {}
        }

        if (filled) {
          const fieldLabel = field.name.replace(/[-_]/g, " ");
          actions.push(`${fieldLabel}: ${value}`);
        }
      } catch (e) {
        console.log(`[FILL] Could not fill ${field.name}:`, e);
      }
    }

    if (form.submit_button && actions.length > 0) {
      try {
        await page.click(form.submit_button, { timeout: 3000 });
        await page.waitForTimeout(1500);
        actions.push("Изпратено");
      } catch (e) {
        console.log(`[FILL] Could not click submit:`, e);
      }
    }

    const observation = await this.quickObserve(page);

    return {
      message: actions.length > 0 ? `Попълних: ${actions.join(", ")}` : "Не успях да попълня формата",
      observation,
    };
  }

  private async clickButton(
    page: Page,
    selector: string,
    buttonText?: string
  ): Promise<{ message: string; observation?: Record<string, unknown> }> {
    try {
      const strategies = [
        async () => await page.click(selector, { timeout: 2000 }),
        async () => buttonText && (await page.click(`text="${buttonText}"`, { timeout: 2000 })),
        async () => buttonText && (await page.click(`button:has-text("${buttonText}")`, { timeout: 2000 })),
        async () => buttonText && (await page.click(`a:has-text("${buttonText}")`, { timeout: 2000 })),
      ];

      for (const strategy of strategies) {
        try {
          await strategy();
          await page.waitForTimeout(1000);
          const observation = await this.quickObserve(page);
          return { message: buttonText ? `Кликнах "${buttonText}"` : "Кликнах", observation };
        } catch {}
      }

      return { message: "Не успях да кликна" };
    } catch {
      return { message: "Не успях да кликна" };
    }
  }

  private formatPrices(prices: SiteMap["prices"]): string {
    if (!prices || prices.length === 0) return "Не намерих цени на сайта";
    const formatted = prices.slice(0, 5).map((p) => (p.context ? `${p.context}: ${p.text}` : p.text)).join("; ");
    return `Цени: ${formatted}`;
  }

  private async getContactInfo(page: Page): Promise<{ message: string }> {
    try {
      const contact = await page.evaluate(() => {
        const text = document.body.innerText;

        const phonePatterns = [
          /(\+359|0)[\s-]?\d{2,3}[\s-]?\d{3}[\s-]?\d{3}/g,
          /(\+359|0)\d{9}/g,
        ];

        let phone = null;
        for (const pattern of phonePatterns) {
          const match = text.match(pattern);
          if (match) {
            phone = match[0];
            break;
          }
        }

        const email = text.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0];
        return { phone, email };
      });

      const parts: string[] = [];
      if (contact.phone) parts.push(`Телефон: ${contact.phone}`);
      if (contact.email) parts.push(`Email: ${contact.email}`);

      return {
        message: parts.length > 0 ? parts.join(". ") : "Не намерих контактна информация на тази страница",
      };
    } catch {
      return { message: "Не успях да извлека контактите" };
    }
  }

  private async navigateTo(page: Page, url: string): Promise<{ message: string; observation?: Record<string, unknown> }> {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
      await page.waitForTimeout(1000);
      const observation = await this.quickObserve(page);
      return { message: `Отворих ${url}`, observation };
    } catch {
      return { message: "Не успях да отворя страницата" };
    }
  }

  private async observeCurrentState(page: Page): Promise<{ message: string; observation?: Record<string, unknown> }> {
    const observation = await this.quickObserve(page);
    let message = `Страница: "${observation.title}"`;

    if (observation.hasAvailability) message += ". Виждам информация за наличност.";
    if (observation.prices && (observation.prices as string[]).length > 0) {
      message += `. Цени: ${(observation.prices as string[]).slice(0, 3).join(", ")}`;
    }

    return { message, observation };
  }

  private async quickObserve(page: Page): Promise<Record<string, unknown>> {
    try {
      return await page.evaluate(() => {
        const text = document.body.innerText.slice(0, 1000);

        const priceMatches = [...text.matchAll(/(\d+[\s,.]?\d*)\s*(лв\.?|BGN|EUR|€)/gi)];
        const prices = priceMatches.map((m) => m[0]).slice(0, 5);

        const hasAvailability = /налични|свободни|available|в наличност/i.test(text);
        const noAvailability = /няма налични|sold out|unavailable|заети/i.test(text);

        return {
          url: window.location.href,
          title: document.title,
          prices,
          hasAvailability,
          noAvailability,
          textSnippet: text.slice(0, 300).replace(/\s+/g, " "),
        };
      });
    } catch {
      return { url: "", title: "", prices: [] };
    }
  }

  private async observeDOM(page: Page): Promise<{ buttons: Array<{ text: string; selector: string }>; prices: string[] }> {
    try {
      return await page.evaluate(() => {
        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };

        const getSelector = (el: Element, idx: number): string => {
          if ((el as any).id) return `#${(el as any).id}`;
          const cls = (el as any).className && typeof (el as any).className === "string"
            ? (el as any).className.trim().split(/\s+/)[0]
            : "";
          if (cls && !cls.includes(":")) return `.${cls}`;
          return `${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
        };

        const buttons = Array.from(
          document.querySelectorAll("button, a[href], [role='button'], input[type='submit'], .btn")
        )
          .filter(isVisible)
          .slice(0, 25)
          .map((el, i) => ({
            text: ((el.textContent?.trim() || (el as HTMLInputElement).value || "") as string).slice(0, 80),
            selector: getSelector(el, i),
          }))
          .filter((b) => b.text.length > 0);

        const priceRegex = /(\d+[\s,.]?\d*)\s*(лв\.?|BGN|EUR|€|\$)/gi;
        const bodyText = document.body.innerText;
        const prices = [...bodyText.matchAll(priceRegex)].map((m) => m[0]).slice(0, 10);

        return { buttons, prices };
      });
    } catch {
      return { buttons: [], prices: [] };
    }
  }

  private detectButtonType(text: string): SiteMapButton["action_type"] {
    const lower = text.toLowerCase();
    if (/резерв|book|запази|reserve/i.test(lower)) return "booking";
    if (/контакт|contact|свържи/i.test(lower)) return "contact";
    if (/търси|search|провери|check|submit|изпрати/i.test(lower)) return "submit";
    return "other";
  }

  // ─────────────────────────────────────────────────────────
  // SESSION MANAGEMENT
  // ─────────────────────────────────────────────────────────

  async closeSession(siteId: string): Promise<void> {
    const session = this.sessions.get(siteId);
    if (session) {
      try {
        await session.page.close();
        await session.context.close();
      } catch {}
      this.sessions.delete(siteId);
      console.log(`[SESSION] Closed: ${siteId}`);
    }
  }

  private cleanupSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [siteId, session] of this.sessions) {
      if (now - session.lastActivity > this.SESSION_TIMEOUT) {
        this.closeSession(siteId);
        cleaned++;
      }
    }

    if (cleaned > 0) console.log(`[CLEANUP] Closed ${cleaned} inactive sessions`);
  }

  private evictOldestSession(): void {
    let oldest: { id: string; time: number } | null = null;

    for (const [id, session] of this.sessions) {
      if (!oldest || session.lastActivity < oldest.time) oldest = { id, time: session.lastActivity };
    }

    if (oldest) {
      console.log(`[EVICT] Closing oldest session: ${oldest.id}`);
      this.closeSession(oldest.id);
    }
  }

  getStatus() {
    const sessionDetails: Record<string, { url: string; schemas: number; age: number }> = {};
    for (const [id, s] of this.sessions) {
      sessionDetails[id] = {
        url: s.currentUrl,
        schemas: s.formSchemas.length,
        age: Math.round((Date.now() - s.lastActivity) / 1000),
      };
    }

    return {
      ready: this.isReady,
      db: !!this.supabase,
      sessions: this.sessions.size,
      maxSessions: this.MAX_SESSIONS,
      activeSites: Array.from(this.sessions.keys()),
      sessionDetails,
      uptime: Math.floor(process.uptime()),
    };
  }

  async shutdown(): Promise<void> {
    console.log("[SHUTDOWN] Closing all sessions...");
    for (const [id] of this.sessions) await this.closeSession(id);
    if (this.browser) await this.browser.close();
    console.log("[SHUTDOWN] Done");
  }

  // expose private for /forms endpoint fallback
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public __unsafeLoadFormSchemasForApi(sessionId: string): Promise<FormSchemaRow[]> {
    return this.loadFormSchemas(sessionId);
  }
}

// ───────────────────────────────────────────────────────────────
// EXPRESS SERVER
// ───────────────────────────────────────────────────────────────

async function main() {
  const manager = new HotSessionManager();

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Auth middleware
  app.use((req, res, next) => {
    if (req.path === "/" || req.path === "/health") return next();
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token !== WORKER_SECRET) {
      console.log(`[AUTH] Rejected request to ${req.path}`);
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
  });

  app.get("/", (_, res) => {
    res.json({
      name: "NEO Worker",
      version: "5.1.0",
      type: "hot-session+db+deterministic",
      status: "running",
    });
  });

  app.get("/health", (_, res) => {
    res.json({
      status: "ok",
      ...manager.getStatus(),
    });
  });

  app.post("/prepare-session", async (req: Request, res: Response) => {
    const { site_id, site_map, session_id } = req.body;
    if (!site_id || !site_map) {
      return res.json({ success: false, error: "Missing site_id or site_map" });
    }

    const success = await manager.prepareSession(site_id, site_map, session_id);
    res.json({ success, session_ready: success });
  });

  // legacy compatible
  app.post("/execute", async (req: Request, res: Response) => {
    const { site_id, session_id, keywords, data } = req.body;
    if (!site_id || !Array.isArray(keywords)) {
      return res.json({ success: false, message: "Invalid request" });
    }

    const result = await manager.execute({ site_id, session_id, keywords, data });
    res.json(result);
  });

  // deterministic form fill
  app.post("/fill-form", async (req: Request, res: Response) => {
    const body = req.body as FillFormRequest;
    if (!body.site_id || !body.data) {
      return res.json({ success: false, message: "Missing site_id or data" });
    }

    const result = await manager.executeFillForm(body);
    res.json(result);
  });

  // get schemas
  app.get("/forms/:sessionId", async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    // Try cache
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [, session] of (manager as any).sessions as Map<string, HotSession>) {
      if (session.sessionId === sessionId) {
        return res.json({ success: true, forms: session.formSchemas, source: "cache" });
      }
    }

    const schemas = await manager.__unsafeLoadFormSchemasForApi(sessionId);
    res.json({ success: true, forms: schemas, source: "db" });
  });

  app.post("/refresh-forms", async (req: Request, res: Response) => {
    const { site_id } = req.body;
    if (!site_id) return res.json({ success: false, error: "Missing site_id" });

    const schemas = await manager.refreshFormSchemas(site_id);
    res.json({ success: true, count: schemas.length, forms: schemas });
  });

  app.post("/close-session", async (req: Request, res: Response) => {
    if (req.body.site_id) await manager.closeSession(req.body.site_id);
    res.json({ success: true });
  });

  // legacy: interact
  app.post("/interact", async (req: Request, res: Response) => {
    const request = req.body as InteractRequest;
    if (!request.site_url || !request.user_message || !request.session_id) {
      return res.json({ success: false, message: "Missing fields", logs: [] });
    }

    // minimal legacy behavior: create a session if missing, then /execute data-driven
    const logs: string[] = [];
    logs.push(`[LEGACY] Session: ${request.session_id}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionsMap = (manager as any).sessions as Map<string, HotSession>;
    let session = sessionsMap.get(request.session_id);

    if (!session) {
      logs.push(`[LEGACY] No hot session, creating...`);
      // fallback: create minimal session
      // (kept from old logic but simplified)
      // This block intentionally mirrors the old behavior without keyword decisions.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const browser = (manager as any).browser as Browser | null;
        if (!browser) {
          return res.json({ success: false, message: "Worker не е готов", logs });
        }

        const context = await browser.newContext({
          viewport: { width: 1366, height: 768 },
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
          locale: "bg-BG",
          timezoneId: "Europe/Sofia",
          ignoreHTTPSErrors: true,
        });

        const page = await context.newPage();

        let url = request.site_url;
        if (url && !url.startsWith("http")) url = "https://" + url;

        if (url) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForTimeout(1500);
        }

        const observation = await (manager as any).observeDOM(page);

        const siteMap: SiteMap = {
          site_id: request.session_id,
          url: request.site_url,
          buttons: observation.buttons.map((b: any) => ({
            text: b.text,
            selector: b.selector,
            keywords: (b.text || "").toLowerCase().split(/\s+/),
            action_type: (manager as any).detectButtonType(b.text),
          })),
          forms: [],
          prices: (observation.prices || []).map((p: string) => ({ text: p, context: "" })),
        };

        const formSchemas = await manager.__unsafeLoadFormSchemasForApi(request.session_id);

        session = {
          page,
          context,
          siteMap,
          sessionId: request.session_id,
          formSchemas,
          lastActivity: Date.now(),
          currentUrl: page.url(),
        };

        sessionsMap.set(request.session_id, session);
        logs.push(`[LEGACY] Session created (${formSchemas.length} form schemas from DB)`);
      } catch (error) {
        logs.push(`[LEGACY] Failed to create session: ${error}`);
        return res.json({ success: false, message: "Грешка при свързване със сайта", logs });
      }
    }

    const result = await manager.execute({
      site_id: request.session_id,
      session_id: request.session_id,
      keywords: [], // ignored
      data: request.booking_data as any,
    });

    logs.push(`[LEGACY] Result: ${result.success ? "success" : "failed"}`);

    res.json({
      success: result.success,
      message: result.message,
      observation: result.observation,
      action_taken: result.success ? result.message : undefined,
      logs,
    });
  });

  app.post("/close", async (req: Request, res: Response) => {
    if (req.body.session_id) await manager.closeSession(req.body.session_id);
    res.json({ success: true });
  });

  // START SERVER FIRST
  app.listen(PORT, () => {
    console.log(`\n🚀 NEO Worker v5.1 (Deterministic DB Forms)`);
    console.log(`   Port: ${PORT}`);
    console.log(`   DB: ${SUPABASE_URL ? "configured" : "not configured"}`);
    console.log(`   Ready: ${manager.getStatus().ready}\n`);
  });

  // Start browser async
  manager
    .start()
    .then(() => console.log("[BOOT] HotSessionManager ready"))
    .catch((err) => console.error("[BOOT] HotSessionManager failed:", err));

  process.on("SIGTERM", async () => {
    console.log("\n[SIGTERM] Shutting down...");
    await manager.shutdown();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("\n[SIGINT] Shutting down...");
    await manager.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
