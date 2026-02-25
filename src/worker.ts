/**
 * NEO WORKER v5.0 - Hot Session + DB Form Schemas
 *
 * ПРОМЕНИ от v4.0:
 * 1. Supabase connection — worker чете form_schemas от DB
 * 2. FormSchema-aware execution — използва rich schema (selector_candidates, labels, required)
 * 3. Wizard/multi-step support — detect & navigate steps
 * 4. File upload support — приема base64 файл от agent и го прикачва
 * 5. Fallback — ако DB е недостъпна, работи по стария начин (SiteMap-only)
 *
 * ENDPOINTS (непроменени + нови):
 * - GET  /               — info
 * - GET  /health         — status
 * - POST /prepare-session — подготвя hot session (от crawler)
 * - POST /execute         — изпълнява действие (от neo-agent-core)
 * - POST /interact        — legacy endpoint
 * - POST /close-session   — затваря session
 * - POST /close           — legacy close
 * - POST /fill-form       — NEW: попълва конкретна form_schema по id/fingerprint
 * - GET  /forms/:sessionId — NEW: връща form_schemas за session
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

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

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
  keywords: string[];
  data?: Record<string, unknown>;
}

interface FillFormRequest {
  site_id: string;
  session_id?: string;
  form_id?: string; // form_schemas.id (uuid)
  fingerprint?: string; // form_schemas.fingerprint
  kind?: string; // filter by kind
  data: Record<string, string>; // field_name → value
  file?: {
    // optional file upload
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

// ═══════════════════════════════════════════════════════════════
// UNIVERSAL KEYWORD PATTERNS
// ═══════════════════════════════════════════════════════════════

const PATTERNS = {
  booking: [
    "резерв",
    "book",
    "запази",
    "наличност",
    "свободн",
    "availability",
    "reserve",
    "нощувк",
  ],
  check_in: [
    "от",
    "check-in",
    "checkin",
    "настаняване",
    "пристигане",
    "arrival",
    "from",
    "start",
  ],
  check_out: [
    "до",
    "check-out",
    "checkout",
    "напускане",
    "заминаване",
    "departure",
    "to",
    "end",
  ],
  guests: [
    "човека",
    "души",
    "гости",
    "guests",
    "adults",
    "persons",
    "двама",
    "трима",
    "възрастни",
    "брой",
  ],
  prices: ["цена", "цени", "price", "струва", "колко", "cost", "rate", "тариф"],
  contact: [
    "контакт",
    "contact",
    "свържи",
    "обади",
    "телефон",
    "имейл",
    "email",
  ],
  search: ["търси", "search", "find", "провери", "check", "покажи", "show"],
  rooms: [
    "стая",
    "стаи",
    "room",
    "rooms",
    "апартамент",
    "suite",
    "настаняване",
  ],
  form: [
    "форма",
    "form",
    "попълни",
    "запитване",
    "заяви",
    "оферта",
    "консултация",
    "записване",
    "анкета",
    "регистрация",
  ],
};

// ═══════════════════════════════════════════════════════════════
// SUPABASE HELPER
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// HOT SESSION MANAGER
// ═══════════════════════════════════════════════════════════════

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

    // Periodic cleanup of inactive sessions
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
      console.log(
        `[DB] Loaded ${rows.length} form_schemas for session ${sessionId.slice(0, 8)}…`
      );
      return rows;
    } catch (err) {
      console.error("[DB] loadFormSchemas error:", err);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────
  // DB: LOAD single form_schema by id (preferred for deterministic execution)
  // ─────────────────────────────────────────────────────────

  private async loadFormSchemaById(formId: string): Promise<FormSchemaRow | null> {
    if (!this.supabase || !formId) return null;
    try {
      const { data, error } = await this.supabase
        .from("form_schemas")
        .select("*")
        .eq("id", formId)
        .maybeSingle();

      if (error) {
        console.error("[DB] form_schema by id query error:", error.message);
        return null;
      }
      return (data as FormSchemaRow) || null;
    } catch (err) {
      console.error("[DB] form_schema by id exception:", err);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────
  // DB: LOAD single form_schema by fingerprint within a session
  // ─────────────────────────────────────────────────────────

  private async loadFormSchemaByFingerprint(
    sessionId: string,
    fingerprint: string
  ): Promise<FormSchemaRow | null> {
    if (!this.supabase || !sessionId || !fingerprint) return null;
    try {
      const { data, error } = await this.supabase
        .from("form_schemas")
        .select("*")
        .eq("session_id", sessionId)
        .eq("fingerprint", fingerprint)
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error(
          "[DB] form_schema by fingerprint query error:",
          error.message
        );
        return null;
      }
      return (data as FormSchemaRow) || null;
    } catch (err) {
      console.error("[DB] form_schema by fingerprint exception:", err);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────
  // PREPARE SESSION - Called by Crawler after training
  // ─────────────────────────────────────────────────────────

  async prepareSession(
    siteId: string,
    siteMap: SiteMap,
    sessionId?: string
  ): Promise<boolean> {
    if (!this.isReady || !this.browser) {
      console.error("[PREPARE] Browser not ready");
      return false;
    }

    const startTime = Date.now();
    console.log(`[PREPARE] Site: ${siteId}`);
    console.log(`[PREPARE] URL: ${siteMap.url}`);
    console.log(
      `[PREPARE] Buttons: ${siteMap.buttons?.length || 0}, Forms: ${siteMap.forms?.length || 0}, Prices: ${siteMap.prices?.length || 0}`
    );

    try {
      // Close old session if exists
      await this.closeSession(siteId);

      // Check session limit
      if (this.sessions.size >= this.MAX_SESSIONS) {
        this.evictOldestSession();
      }

      // Create new context and page
      const context = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        locale: "bg-BG",
        timezoneId: "Europe/Sofia",
        ignoreHTTPSErrors: true,
      });

      const page = await context.newPage();

      // Navigate to site
      let url = siteMap.url;
      if (!url.startsWith("http")) url = "https://" + url;

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      // Wait a bit for JS to load
      await page.waitForTimeout(1500);

      // Load form_schemas from DB (non-blocking for session creation)
      const dbSessionId = sessionId || siteId;
      const formSchemas = await this.loadFormSchemas(dbSessionId);

      // Save session
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
      console.log(
        `[PREPARE] ✓ Session ready in ${elapsed}ms (${formSchemas.length} form schemas)`
      );
      return true;
    } catch (error) {
      console.error(`[PREPARE] ✗ Failed:`, error);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────
  // REFRESH form_schemas from DB (call when agent needs latest)
  // ─────────────────────────────────────────────────────────

  async refreshFormSchemas(siteId: string): Promise<FormSchemaRow[]> {
    const session = this.sessions.get(siteId);
    if (!session) return [];

    const dbSessionId = session.sessionId || siteId;
    const schemas = await this.loadFormSchemas(dbSessionId);
    session.formSchemas = schemas;
    return schemas;
  }

  // ─────────────────────────────────────────────────────────
  // EXECUTE - Main action method (called by neo-agent-core)
  // ─────────────────────────────────────────────────────────

  async execute(
    request: ExecuteRequest
  ): Promise<{
    success: boolean;
    message: string;
    observation?: Record<string, unknown>;
    form_schemas?: FormSchemaRow[];
  }> {
    const { site_id, session_id, keywords, data } = request;
    let session = this.sessions.get(site_id);

    if (!session) {
      console.log(`[EXECUTE] No session for ${site_id}`);
      return {
        success: false,
        message: "Няма активна сесия. Моля, изчакайте зареждане.",
      };
    }

    // If caller provides session_id and we have no schemas yet — load them
    if (
      session_id &&
      session.sessionId !== session_id &&
      session.formSchemas.length === 0
    ) {
      session.sessionId = session_id;
      session.formSchemas = await this.loadFormSchemas(session_id);
    }

    const startTime = Date.now();
    session.lastActivity = Date.now();

    console.log(`[EXECUTE] Site: ${site_id}`);
    console.log(`[EXECUTE] Keywords: ${keywords.slice(0, 5).join(", ")}`);
    console.log(`[EXECUTE] FormSchemas: ${session.formSchemas.length}`);
    if (data) console.log(`[EXECUTE] Data:`, data);

    try {
      // Check if page is still valid
      try {
        await session.page.evaluate(() => true);
      } catch {
        console.log(`[EXECUTE] Page closed, recreating...`);
        await this.prepareSession(site_id, session.siteMap, session.sessionId || undefined);
        session = this.sessions.get(site_id)!;
        if (!session) {
          return {
            success: false,
            message: "Грешка при възстановяване на сесията",
          };
        }
      }

      // 1. MATCH ACTION from keywords (now considers form_schemas too)
      const action = this.matchAction(
        keywords,
        session.siteMap,
        session.formSchemas,
        data
      );
      console.log(`[EXECUTE] Action: ${action.type}`);

      // 2. EXECUTE ACTION
      let result: {
        message: string;
        observation?: Record<string, unknown>;
        form_schemas?: FormSchemaRow[];
      };

      switch (action.type) {
        case "fill_form":
          result = await this.fillForm(
            session.page,
            action.form!,
            action.data!
          );
          break;

        case "fill_form_schema":
          result = await this.fillFormSchema(
            session.page,
            action.formSchema!,
            action.data || {}
          );
          break;

        case "fill_wizard":
          result = await this.fillWizard(
            session.page,
            action.formSchema!,
            action.data || {}
          );
          break;

        case "click":
          result = await this.clickButton(
            session.page,
            action.selector!,
            action.buttonText
          );
          break;

        case "return_prices":
          result = {
            message: this.formatPrices(session.siteMap.prices),
            observation: { prices: session.siteMap.prices },
          };
          break;

        case "return_contact":
          result = await this.getContactInfo(session.page);
          break;

        case "return_forms":
          result = {
            message: this.describeFormSchemas(session.formSchemas),
            form_schemas: session.formSchemas,
          };
          break;

        case "navigate":
          result = await this.navigateTo(session.page, action.url!);
          break;

        case "navigate_and_fill":
          result = await this.navigateAndFillSchema(
            session.page,
            action.formSchema!,
            action.data || {}
          );
          break;

        case "observe":
        default:
          result = await this.observeCurrentState(session.page);
          break;
      }

      const elapsed = Date.now() - startTime;
      console.log(
        `[EXECUTE] ✓ Done in ${elapsed}ms: ${result.message.slice(0, 50)}`
      );

      return { success: true, ...result };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[EXECUTE] ✗ Error:`, errMsg);
      return { success: false, message: "Грешка при изпълнение" };
    }
  }

  // ─────────────────────────────────────────────────────────
  // FILL FORM SCHEMA — new: direct by id/fingerprint
  // ─────────────────────────────────────────────────────────

  async executeFillForm(
    request: FillFormRequest
  ): Promise<{
    success: boolean;
    message: string;
    observation?: Record<string, unknown>;
  }> {
    const { site_id, session_id, form_id, fingerprint, kind, data, file, auto_submit } = request;

    const session = this.sessions.get(site_id);
    if (!session) {
      return { success: false, message: "Няма активна сесия" };
    }

    // Find the target schema (prefer single-row DB fetch when possible)
    let schema: FormSchemaRow | null = null;

    // 1) Strongest key: form_id
    if (form_id) {
      schema = session.formSchemas.find((s) => s.id === form_id) || null;
      if (!schema) {
        schema = await this.loadFormSchemaById(form_id);
        if (schema) {
          // cache locally for this hot session (helps retries)
          session.formSchemas = [
            schema,
            ...session.formSchemas.filter((s) => s.id !== schema!.id),
          ];
        }
      }
    }

    // 2) Next best: fingerprint within a session
    if (!schema && fingerprint) {
      schema =
        session.formSchemas.find((s) => s.fingerprint === fingerprint) || null;
      if (!schema) {
        const sid = session_id || session.sessionId;
        if (sid) {
          schema = await this.loadFormSchemaByFingerprint(sid, fingerprint);
          if (schema) {
            session.formSchemas = [
              schema,
              ...session.formSchemas.filter((s) => s.id !== schema!.id),
            ];
          }
        }
      }
    }

    // 3) If caller only provided kind, we need the list for the session
    if (!schema) {
      if (session.formSchemas.length === 0 && (session_id || session.sessionId)) {
        session.formSchemas = await this.loadFormSchemas(
          session_id || session.sessionId || site_id
        );
      }

      if (kind) {
        schema = session.formSchemas.find((s) => s.kind === kind) || null;
      } else {
        // Default: prefer wizard first
        schema =
          session.formSchemas.find(
            (s) => s.kind === "wizard" || s.kind === "form"
          ) || null;
      }
    }

    if (!schema) {
      return {
        success: false,
        message: `Не намерих форма (schemas: ${session.formSchemas.length}, filter: ${form_id || fingerprint || kind || "default"})`,
      };
    }

    console.log(
      `[FILL-FORM] kind=${schema.kind} fingerprint=${schema.fingerprint.slice(0, 12)}… fields=${schema.schema.fields?.length || 0}`
    );

    session.lastActivity = Date.now();

    try {
      // Check if page is still valid
      try {
        await session.page.evaluate(() => true);
      } catch {
        await this.prepareSession(site_id, session.siteMap, session.sessionId || undefined);
        const newSession = this.sessions.get(site_id);
        if (!newSession) {
          return { success: false, message: "Грешка при възстановяване" };
        }
      }

      const currentSession = this.sessions.get(site_id)!;

      // Navigate to form URL if different from current
      const formUrl = schema.url;
      if (formUrl && !currentSession.page.url().includes(new URL(formUrl).pathname)) {
        console.log(`[FILL-FORM] Navigating to form URL: ${formUrl}`);
        await currentSession.page.goto(formUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await currentSession.page.waitForTimeout(1000);
      }

      // Fill based on kind
      let result: { message: string; observation?: Record<string, unknown> };

      if (schema.kind === "wizard") {
        result = await this.fillWizard(currentSession.page, schema, data);
      } else {
        result = await this.fillFormSchema(
          currentSession.page,
          schema,
          data,
          file,
          auto_submit !== false
        );
      }

      return { success: true, ...result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[FILL-FORM] Error:", msg);
      return { success: false, message: `Грешка: ${msg}` };
    }
  }

  // ─────────────────────────────────────────────────────────
  // LEGACY INTERACT - For backwards compatibility
  // ─────────────────────────────────────────────────────────

  async interact(
    request: InteractRequest
  ): Promise<{
    success: boolean;
    message: string;
    observation?: Record<string, unknown>;
    action_taken?: string;
    logs: string[];
  }> {
    const logs: string[] = [];
    const { site_url, user_message, session_id, booking_data } = request;

    logs.push(`[LEGACY] Session: ${session_id}`);

    // Check if we have a hot session
    let session = this.sessions.get(session_id);

    // If no hot session, create one on-the-fly (slower, but backwards compatible)
    if (!session) {
      logs.push(`[LEGACY] No hot session, creating...`);

      if (!this.browser) {
        return { success: false, message: "Worker не е готов", logs };
      }

      try {
        const context = await this.browser.newContext({
          viewport: { width: 1366, height: 768 },
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
          locale: "bg-BG",
          timezoneId: "Europe/Sofia",
          ignoreHTTPSErrors: true,
        });

        const page = await context.newPage();

        let url = site_url;
        if (url && !url.startsWith("http")) url = "https://" + url;

        if (url) {
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });
          await page.waitForTimeout(1500);
        }

        // Create minimal siteMap from page observation
        const observation = await this.observeDOM(page);

        const siteMap: SiteMap = {
          site_id: session_id,
          url: site_url,
          buttons: observation.buttons.map((b) => ({
            text: b.text,
            selector: b.selector,
            keywords: b.text.toLowerCase().split(/\s+/),
            action_type: this.detectButtonType(b.text),
          })),
          forms: [],
          prices: observation.prices.map((p) => ({ text: p, context: "" })),
        };

        // Load form_schemas from DB
        const formSchemas = await this.loadFormSchemas(session_id);

        session = {
          page,
          context,
          siteMap,
          sessionId: session_id,
          formSchemas,
          lastActivity: Date.now(),
          currentUrl: page.url(),
        };

        this.sessions.set(session_id, session);
        logs.push(
          `[LEGACY] Session created (${formSchemas.length} form schemas from DB)`
        );
      } catch (error) {
        logs.push(`[LEGACY] Failed to create session: ${error}`);
        return {
          success: false,
          message: "Грешка при свързване със сайта",
          logs,
        };
      }
    }

    // Extract keywords from message
    const keywords = user_message
      .toLowerCase()
      .replace(/[,.!?;:()[\]{}""'']/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

    // Execute using new system
    const result = await this.execute({
      site_id: session_id,
      session_id: session_id,
      keywords,
      data: booking_data as Record<string, unknown> | undefined,
    });

    logs.push(`[LEGACY] Result: ${result.success ? "success" : "failed"}`);

    return {
      success: result.success,
      message: result.message,
      observation: result.observation,
      action_taken: result.success ? result.message : undefined,
      logs,
    };
  }

  // ─────────────────────────────────────────────────────────
  // ACTION MATCHING — now considers form_schemas
  // ─────────────────────────────────────────────────────────

  private matchAction(
    keywords: string[],
    siteMap: SiteMap,
    formSchemas: FormSchemaRow[],
    data?: Record<string, unknown>
  ): {
    type:
      | "fill_form"
      | "fill_form_schema"
      | "fill_wizard"
      | "click"
      | "return_prices"
      | "return_contact"
      | "return_forms"
      | "navigate"
      | "navigate_and_fill"
      | "observe";
    form?: SiteMapForm;
    formSchema?: FormSchemaRow;
    selector?: string;
    buttonText?: string;
    url?: string;
    data?: Record<string, unknown>;
  } {
    const joined = keywords.join(" ").toLowerCase();

    // 0. FORM KEYWORDS → return available forms info
    const hasFormKeyword = PATTERNS.form.some((p) => joined.includes(p));

    // 1. BOOKING - if has dates or booking keywords
    const hasBookingKeyword = PATTERNS.booking.some((p) => joined.includes(p));
    const hasDates = !!(data?.check_in || data?.check_out);

    if (hasBookingKeyword || hasDates) {
      // Try form_schemas first (richer data)
      const bookingSchema = formSchemas.find((s) => {
        if (s.kind === "booking_widget") return true;
        if (s.kind !== "form" && s.kind !== "wizard") return false;
        const fields = s.schema.fields || [];
        return fields.some(
          (f) =>
            f.type === "date" ||
            /date|дата|check.?in|настаняване|пристигане/i.test(
              `${f.name} ${f.label} ${f.placeholder}`
            )
        );
      });

      if (bookingSchema) {
        const isCurrentPage = this.isOnSamePage(bookingSchema.url);
        if (bookingSchema.kind === "wizard") {
          return {
            type: isCurrentPage ? "fill_wizard" : "navigate_and_fill",
            formSchema: bookingSchema,
            data,
          };
        }
        return {
          type: isCurrentPage ? "fill_form_schema" : "navigate_and_fill",
          formSchema: bookingSchema,
          data,
        };
      }

      // Fallback: SiteMap form
      const form = siteMap.forms?.find((f) =>
        f.fields?.some(
          (field) =>
            field.type === "date" ||
            PATTERNS.check_in.some((k) => field.keywords?.includes(k)) ||
            PATTERNS.check_out.some((k) => field.keywords?.includes(k))
        )
      );

      if (form) {
        return { type: "fill_form", form, data };
      }

      // Try booking button
      const bookBtn = siteMap.buttons?.find(
        (b) =>
          b.action_type === "booking" ||
          PATTERNS.booking.some((p) => b.text.toLowerCase().includes(p))
      );

      if (bookBtn) {
        return {
          type: "click",
          selector: bookBtn.selector,
          buttonText: bookBtn.text,
        };
      }
    }

    // 2. FORM/WIZARD - if asking about forms, consultations, offers
    if (hasFormKeyword) {
      // If we have form_schemas, return them so agent knows what's available
      if (formSchemas.length > 0) {
        // If there's data to fill → fill the first matching form
        if (data && Object.keys(data).length > 0) {
          const fillable = formSchemas.find(
            (s) => s.kind === "form" || s.kind === "wizard"
          );
          if (fillable) {
            return {
              type:
                fillable.kind === "wizard"
                  ? "fill_wizard"
                  : "fill_form_schema",
              formSchema: fillable,
              data,
            };
          }
        }
        return { type: "return_forms" };
      }
    }

    // 3. PRICES
    if (PATTERNS.prices.some((p) => joined.includes(p))) {
      if (siteMap.prices && siteMap.prices.length > 0) {
        return { type: "return_prices" };
      }
    }

    // 4. CONTACT
    if (PATTERNS.contact.some((p) => joined.includes(p))) {
      // Check if there's a contact form in form_schemas
      const contactSchema = formSchemas.find((s) => {
        if (s.kind !== "form") return false;
        const fields = s.schema.fields || [];
        return fields.some((f) =>
          /email|имейл|телефон|phone|name|име|message|съобщение/i.test(
            `${f.name} ${f.label} ${f.type}`
          )
        );
      });

      if (contactSchema && data && Object.keys(data).length > 0) {
        return { type: "fill_form_schema", formSchema: contactSchema, data };
      }

      const contactBtn = siteMap.buttons?.find(
        (b) =>
          b.action_type === "contact" ||
          PATTERNS.contact.some((p) => b.text.toLowerCase().includes(p))
      );
      if (contactBtn) {
        return {
          type: "click",
          selector: contactBtn.selector,
          buttonText: contactBtn.text,
        };
      }
      return { type: "return_contact" };
    }

    // 5. ROOMS
    if (PATTERNS.rooms.some((p) => joined.includes(p))) {
      const roomsBtn = siteMap.buttons?.find((b) =>
        PATTERNS.rooms.some((p) => b.text.toLowerCase().includes(p))
      );
      if (roomsBtn) {
        return {
          type: "click",
          selector: roomsBtn.selector,
          buttonText: roomsBtn.text,
        };
      }
    }

    // 6. SEARCH/CHECK button
    if (PATTERNS.search.some((p) => joined.includes(p))) {
      const searchBtn = siteMap.buttons?.find(
        (b) =>
          b.action_type === "submit" ||
          PATTERNS.search.some((p) => b.text.toLowerCase().includes(p))
      );
      if (searchBtn) {
        return {
          type: "click",
          selector: searchBtn.selector,
          buttonText: searchBtn.text,
        };
      }
    }

    // 7. Match specific button by keywords
    if (siteMap.buttons) {
      for (const btn of siteMap.buttons) {
        const btnKeywords =
          btn.keywords?.map((k) => k.toLowerCase()) || [];
        if (
          keywords.some((kw) => btnKeywords.includes(kw.toLowerCase()))
        ) {
          return {
            type: "click",
            selector: btn.selector,
            buttonText: btn.text,
          };
        }
      }
    }

    // Default: observe
    return { type: "observe" };
  }

  // helper: rough check if schema URL is current page
  private isOnSamePage(schemaUrl: string): boolean {
    // We don't have access to current page URL here without async,
    // so we return true (navigate_and_fill will check and skip nav if same)
    return true;
  }

  // ─────────────────────────────────────────────────────────
  // FILL FORM SCHEMA — uses rich selector_candidates
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

    if (fields.length === 0) {
      return { message: "Формата няма полета" };
    }

    for (const field of fields) {
      // Find matching value from data
      const value = this.matchFieldValue(field, data);
      if (!value) continue;

      const filled = await this.fillSingleField(page, field, value);
      if (filled) {
        const label = field.label || field.name || field.placeholder || field.type;
        actions.push(`${label}: ${value}`);
      }
    }

    // Handle file upload
    if (file) {
      const uploaded = await this.uploadFile(page, fields, file);
      if (uploaded) {
        actions.push(`Файл: ${file.filename}`);
      }
    }

    // Click submit
    if (autoSubmit && schema.schema.submit && actions.length > 0) {
      const clicked = await this.clickBySelector(
        page,
        schema.schema.submit.selector_candidates,
        schema.schema.submit.text
      );
      if (clicked) {
        actions.push("Изпратено");
        await page.waitForTimeout(1500);
      }
    }

    const observation = await this.quickObserve(page);

    return {
      message:
        actions.length > 0
          ? `Попълних: ${actions.join(", ")}`
          : "Не успях да попълня формата — не намерих съвпадащи полета",
      observation,
    };
  }

  // ─────────────────────────────────────────────────────────
  // FILL WIZARD — multi-step form
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
      // Find visible fields on current step
      const visibleFields = await this.getVisibleFormFields(page);

      if (visibleFields.length === 0 && step > 0) {
        // No more visible fields — we might be done
        break;
      }

      // Try to fill visible fields
      let filledInStep = 0;

      for (const field of fields) {
        const value = this.matchFieldValue(field, data);
        if (!value) continue;

        // Check if field is visible right now
        const isVisible = await this.isFieldVisible(page, field);
        if (!isVisible) continue;

        const filled = await this.fillSingleField(page, field, value);
        if (filled) {
          const label = field.label || field.name || field.type;
          actions.push(`${label}: ${value}`);
          filledInStep++;
        }
      }

      // Also try to fill by matching visible fields to data keys
      for (const vf of visibleFields) {
        const matchedValue = this.matchVisibleFieldToData(vf, data);
        if (matchedValue && !actions.some((a) => a.includes(matchedValue))) {
          const filled = await this.fillSingleField(page, vf, matchedValue);
          if (filled) {
            actions.push(`${vf.label || vf.name}: ${matchedValue}`);
            filledInStep++;
          }
        }
      }

      stepsCompleted++;

      // Try to click Next / Continue / Напред
      const nextClicked = await this.clickNextStep(page);
      if (!nextClicked) {
        // No "next" button — maybe it's the last step or a submit
        break;
      }

      // Wait for step transition
      await page.waitForTimeout(800);
    }

    const observation = await this.quickObserve(page);

    return {
      message:
        actions.length > 0
          ? `Wizard (${stepsCompleted} стъпки): ${actions.join(", ")}`
          : `Wizard: преминах ${stepsCompleted} стъпки, но не намерих полета за попълване`,
      observation,
    };
  }

  // ─────────────────────────────────────────────────────────
  // NAVIGATE + FILL (when form is on different page)
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
          await page.goto(formUrl, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          await page.waitForTimeout(1000);
        }
      } catch {
        await page.goto(formUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await page.waitForTimeout(1000);
      }
    }

    if (schema.kind === "wizard") {
      return this.fillWizard(page, schema, data);
    }
    return this.fillFormSchema(page, schema, data);
  }

  // ─────────────────────────────────────────────────────────
  // FIELD HELPERS
  // ─────────────────────────────────────────────────────────

  private matchFieldValue(
    field: FormSchemaField,
    data: Record<string, unknown>
  ): string | undefined {
    // Direct match by field name
    if (data[field.name] !== undefined) return String(data[field.name]);

    // Match by common patterns
    const searchText =
      `${field.name} ${field.label} ${field.placeholder} ${field.autocomplete || ""}`.toLowerCase();

    // Check-in date
    if (
      PATTERNS.check_in.some((k) => searchText.includes(k)) ||
      (field.type === "date" && /от|from|start|check.?in|настаняване/i.test(searchText))
    ) {
      if (data.check_in) return String(data.check_in);
    }

    // Check-out date
    if (
      PATTERNS.check_out.some((k) => searchText.includes(k)) ||
      (field.type === "date" && /до|to|end|check.?out|напускане/i.test(searchText))
    ) {
      if (data.check_out) return String(data.check_out);
    }

    // Guests
    if (PATTERNS.guests.some((k) => searchText.includes(k))) {
      if (data.guests) return String(data.guests);
    }

    // Name
    if (/name|име|first.?name|last.?name|фамилия/i.test(searchText)) {
      if (data.name) return String(data.name);
      if (data.full_name) return String(data.full_name);
      if (data.first_name) return String(data.first_name);
    }

    // Email
    if (/email|имейл|e-mail|поща/i.test(searchText)) {
      if (data.email) return String(data.email);
    }

    // Phone
    if (/phone|телефон|тел|mobile|мобилен/i.test(searchText)) {
      if (data.phone) return String(data.phone);
      if (data.telephone) return String(data.telephone);
    }

    // Message
    if (/message|съобщение|бележка|забележка|описание|note|comment/i.test(searchText)) {
      if (data.message) return String(data.message);
      if (data.note) return String(data.note);
      if (data.comment) return String(data.comment);
    }

    return undefined;
  }

  private matchVisibleFieldToData(
    field: FormSchemaField,
    data: Record<string, unknown>
  ): string | undefined {
    // Same logic as matchFieldValue but for dynamically discovered fields
    return this.matchFieldValue(field, data);
  }

  private async fillSingleField(
    page: Page,
    field: FormSchemaField,
    value: string
  ): Promise<boolean> {
    // Try selector_candidates first (most reliable)
    const selectors = [
      ...(field.selector_candidates || []),
      field.name ? `[name="${field.name}"]` : "",
      field.name ? `#${field.name}` : "",
    ].filter(Boolean);

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;

        // Check visibility
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;

        if (field.type === "select" || field.tag === "select") {
          await page.selectOption(sel, value, { timeout: 2000 });
          return true;
        }

        if (field.type === "file") {
          // File inputs handled separately
          continue;
        }

        // Clear and fill
        await el.click({ timeout: 1000 }).catch(() => {});
        await page.fill(sel, value, { timeout: 2000 });
        return true;
      } catch {
        // Try next selector
      }
    }

    return false;
  }

  private async isFieldVisible(
    page: Page,
    field: FormSchemaField
  ): Promise<boolean> {
    const selectors = [
      ...(field.selector_candidates || []),
      field.name ? `[name="${field.name}"]` : "",
    ].filter(Boolean);

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible();
          if (visible) return true;
        }
      } catch {}
    }
    return false;
  }

  private async getVisibleFormFields(
    page: Page
  ): Promise<FormSchemaField[]> {
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
          if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            style.display === "none" ||
            style.visibility === "hidden"
          )
            return;

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
            type: el.type || el.tagName.toLowerCase(),
            name,
            label,
            placeholder: el.placeholder || "",
            required: el.required,
            autocomplete: el.autocomplete || "",
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
    const nextPatterns = [
      "text=/напред/i",
      "text=/следваща/i",
      "text=/next/i",
      "text=/continue/i",
      "text=/продълж/i",
      "text=/стъпка/i",
      'button:has-text("Напред")',
      'button:has-text("Следваща")',
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Продължи")',
      "[class*='next']",
      "[class*='step'] button",
    ];

    for (const sel of nextPatterns) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            await el.click({ timeout: 2000 });
            return true;
          }
        }
      } catch {}
    }

    return false;
  }

  private async uploadFile(
    page: Page,
    fields: FormSchemaField[],
    file: NonNullable<FillFormRequest["file"]>
  ): Promise<boolean> {
    // Find file input by field_name or first file input
    const fileFields = fields.filter((f) => f.type === "file");
    const targetField =
      fileFields.find((f) => f.name === file.field_name) || fileFields[0];

    // Write base64 to temp file
    const tmpPath = `/tmp/upload_${Date.now()}_${file.filename}`;

    try {
      const buffer = Buffer.from(file.base64, "base64");
      const fs = await import("fs");
      fs.writeFileSync(tmpPath, buffer);

      // Find file input selector
      let selectors: string[] = [];
      if (targetField) {
        selectors = [...(targetField.selector_candidates || [])];
        if (targetField.name)
          selectors.push(`input[name="${targetField.name}"]`);
      }
      selectors.push('input[type="file"]'); // fallback

      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await (el as any).setInputFiles(tmpPath);
            console.log(`[UPLOAD] ✓ File set via ${sel}`);

            // Cleanup
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

  private async clickBySelector(
    page: Page,
    candidates: string[],
    text?: string
  ): Promise<boolean> {
    // Try selector candidates
    for (const sel of candidates || []) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            await el.click({ timeout: 3000 });
            return true;
          }
        }
      } catch {}
    }

    // Fallback: text-based click
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
  // DESCRIBE FORMS (for agent to understand what's available)
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
  // EXISTING ACTIONS (unchanged)
  // ─────────────────────────────────────────────────────────

  private async fillForm(
    page: Page,
    form: SiteMapForm,
    data: Record<string, unknown>
  ): Promise<{ message: string; observation?: Record<string, unknown> }> {
    const actions: string[] = [];

    if (!form.fields) {
      return { message: "Формата няма полета" };
    }

    for (const field of form.fields) {
      let value: string | undefined;

      // Match field to data by keywords
      const fieldKeywords =
        field.keywords?.map((k) => k.toLowerCase()) || [];

      if (
        PATTERNS.check_in.some((k) => fieldKeywords.includes(k)) &&
        data.check_in
      ) {
        value = String(data.check_in);
      } else if (
        PATTERNS.check_out.some((k) => fieldKeywords.includes(k)) &&
        data.check_out
      ) {
        value = String(data.check_out);
      } else if (
        PATTERNS.guests.some((k) => fieldKeywords.includes(k)) &&
        data.guests
      ) {
        value = String(data.guests);
      }

      if (value) {
        try {
          // Try multiple selector strategies
          const selectors = [
            field.selector,
            `[name="${field.name}"]`,
            `#${field.name}`,
          ].filter(Boolean);

          let filled = false;
          for (const sel of selectors) {
            try {
              const el = await page.$(sel);
              if (el) {
                if (field.type === "select") {
                  await page.selectOption(sel, value, { timeout: 2000 });
                } else {
                  await page.fill(sel, value, { timeout: 2000 });
                }
                filled = true;
                break;
              }
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
    }

    // Click submit button
    if (form.submit_button && actions.length > 0) {
      try {
        await page.click(form.submit_button, { timeout: 3000 });
        await page.waitForTimeout(1500);
        actions.push("Търсене");
      } catch (e) {
        console.log(`[FILL] Could not click submit:`, e);
      }
    }

    const observation = await this.quickObserve(page);

    return {
      message:
        actions.length > 0
          ? `Попълних: ${actions.join(", ")}`
          : "Не успях да попълня формата",
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
        async () =>
          buttonText &&
          (await page.click(`text="${buttonText}"`, { timeout: 2000 })),
        async () =>
          buttonText &&
          (await page.click(`button:has-text("${buttonText}")`, {
            timeout: 2000,
          })),
        async () =>
          buttonText &&
          (await page.click(`a:has-text("${buttonText}")`, {
            timeout: 2000,
          })),
      ];

      for (const strategy of strategies) {
        try {
          await strategy();
          await page.waitForTimeout(1000);
          const observation = await this.quickObserve(page);
          return {
            message: buttonText ? `Кликнах "${buttonText}"` : "Кликнах",
            observation,
          };
        } catch {}
      }

      return { message: "Не успях да кликна" };
    } catch {
      return { message: "Не успях да кликна" };
    }
  }

  private formatPrices(prices: SiteMap["prices"]): string {
    if (!prices || prices.length === 0) return "Не намерих цени на сайта";

    const formatted = prices
      .slice(0, 5)
      .map((p) => (p.context ? `${p.context}: ${p.text}` : p.text))
      .join("; ");

    return `Цени: ${formatted}`;
  }

  private async getContactInfo(
    page: Page
  ): Promise<{ message: string }> {
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
        message:
          parts.length > 0
            ? parts.join(". ")
            : "Не намерих контактна информация на тази страница",
      };
    } catch {
      return { message: "Не успях да извлека контактите" };
    }
  }

  private async navigateTo(
    page: Page,
    url: string
  ): Promise<{
    message: string;
    observation?: Record<string, unknown>;
  }> {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
      await page.waitForTimeout(1000);
      const observation = await this.quickObserve(page);
      return { message: `Отворих ${url}`, observation };
    } catch {
      return { message: "Не успях да отворя страницата" };
    }
  }

  private async observeCurrentState(
    page: Page
  ): Promise<{
    message: string;
    observation?: Record<string, unknown>;
  }> {
    const observation = await this.quickObserve(page);

    let message = `Страница: "${observation.title}"`;

    if (observation.hasAvailability) {
      message += ". Виждам информация за наличност.";
    }

    if (
      observation.prices &&
      (observation.prices as string[]).length > 0
    ) {
      message += `. Цени: ${(observation.prices as string[]).slice(0, 3).join(", ")}`;
    }

    return { message, observation };
  }

  private async quickObserve(
    page: Page
  ): Promise<Record<string, unknown>> {
    try {
      return await page.evaluate(() => {
        const text = document.body.innerText.slice(0, 1000);

        // Extract prices
        const priceMatches = [
          ...text.matchAll(/(\d+[\s,.]?\d*)\s*(лв\.?|BGN|EUR|€)/gi),
        ];
        const prices = priceMatches.map((m) => m[0]).slice(0, 5);

        // Check for availability indicators
        const hasAvailability = /налични|свободни|available|в наличност/i.test(
          text
        );
        const noAvailability =
          /няма налични|sold out|unavailable|заети/i.test(text);

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

  // Legacy DOM observation for backwards compatibility
  private async observeDOM(
    page: Page
  ): Promise<{
    buttons: Array<{ text: string; selector: string }>;
    prices: string[];
  }> {
    try {
      return await page.evaluate(() => {
        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };

        const getSelector = (el: Element, idx: number): string => {
          if (el.id) return `#${el.id}`;
          if (el.className && typeof el.className === "string") {
            const cls = el.className.trim().split(/\s+/)[0];
            if (cls && !cls.includes(":")) return `.${cls}`;
          }
          return `${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
        };

        const buttons = Array.from(
          document.querySelectorAll(
            "button, a[href], [role='button'], input[type='submit'], .btn"
          )
        )
          .filter(isVisible)
          .slice(0, 25)
          .map((el, i) => ({
            text: (
              el.textContent?.trim() ||
              (el as HTMLInputElement).value ||
              ""
            ).slice(0, 80),
            selector: getSelector(el, i),
          }))
          .filter((b) => b.text.length > 0);

        const priceRegex = /(\d+[\s,.]?\d*)\s*(лв\.?|BGN|EUR|€|\$)/gi;
        const bodyText = document.body.innerText;
        const prices = [...bodyText.matchAll(priceRegex)]
          .map((m) => m[0])
          .slice(0, 10);

        return { buttons, prices };
      });
    } catch {
      return { buttons: [], prices: [] };
    }
  }

  private detectButtonType(
    text: string
  ): SiteMapButton["action_type"] {
    const lower = text.toLowerCase();
    if (/резерв|book|запази|reserve/i.test(lower)) return "booking";
    if (/контакт|contact|свържи/i.test(lower)) return "contact";
    if (/търси|search|провери|check|submit|изпрати/i.test(lower))
      return "submit";
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

    if (cleaned > 0) {
      console.log(`[CLEANUP] Closed ${cleaned} inactive sessions`);
    }
  }

  private evictOldestSession(): void {
    let oldest: { id: string; time: number } | null = null;

    for (const [id, session] of this.sessions) {
      if (!oldest || session.lastActivity < oldest.time) {
        oldest = { id, time: session.lastActivity };
      }
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
    for (const [id] of this.sessions) {
      await this.closeSession(id);
    }
    if (this.browser) {
      await this.browser.close();
    }
    console.log("[SHUTDOWN] Done");
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════

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

  // ── Root ──
  app.get("/", (_, res) => {
    res.json({
      name: "NEO Worker",
      version: "5.0.0",
      type: "hot-session+db",
      status: "running",
    });
  });

  // ── Health ──
  app.get("/health", (_, res) => {
    res.json({
      status: "ok",
      ...manager.getStatus(),
    });
  });

  // ── Prepare session (from crawler) ──
  app.post("/prepare-session", async (req: Request, res: Response) => {
    const { site_id, site_map, session_id } = req.body;
    if (!site_id || !site_map) {
      return res.json({
        success: false,
        error: "Missing site_id or site_map",
      });
    }

    const success = await manager.prepareSession(
      site_id,
      site_map,
      session_id
    );
    res.json({ success, session_ready: success });
  });

  // ── Execute action (from neo-agent-core) ──
  app.post("/execute", async (req: Request, res: Response) => {
    const { site_id, session_id, keywords, data } = req.body;
    if (!site_id || !Array.isArray(keywords)) {
      return res.json({ success: false, message: "Invalid request" });
    }

    const result = await manager.execute({
      site_id,
      session_id,
      keywords,
      data,
    });
    res.json(result);
  });

  // ── NEW: Fill specific form by id/fingerprint ──
  app.post("/fill-form", async (req: Request, res: Response) => {
    const body = req.body as FillFormRequest;
    if (!body.site_id || !body.data) {
      return res.json({
        success: false,
        message: "Missing site_id or data",
      });
    }

    const result = await manager.executeFillForm(body);
    res.json(result);
  });

  // ── NEW: Get form_schemas for a session ──
  app.get("/forms/:sessionId", async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    // Try to find in active sessions
    for (const [, session] of (manager as any).sessions as Map<
      string,
      HotSession
    >) {
      if (session.sessionId === sessionId) {
        return res.json({
          success: true,
          forms: session.formSchemas,
          source: "cache",
        });
      }
    }

    // Fallback: load from DB directly
    const schemas = await (manager as any).loadFormSchemas(sessionId);
    res.json({
      success: true,
      forms: schemas,
      source: "db",
    });
  });

  // ── NEW: Refresh form_schemas for active session ──
  app.post("/refresh-forms", async (req: Request, res: Response) => {
    const { site_id } = req.body;
    if (!site_id) {
      return res.json({ success: false, error: "Missing site_id" });
    }

    const schemas = await manager.refreshFormSchemas(site_id);
    res.json({
      success: true,
      count: schemas.length,
      forms: schemas,
    });
  });

  // ── Close session ──
  app.post("/close-session", async (req: Request, res: Response) => {
    if (req.body.site_id) {
      await manager.closeSession(req.body.site_id);
    }
    res.json({ success: true });
  });

  // ── Legacy: interact ──
  app.post("/interact", async (req: Request, res: Response) => {
    const request = req.body as InteractRequest;
    if (
      !request.site_url ||
      !request.user_message ||
      !request.session_id
    ) {
      return res.json({
        success: false,
        message: "Missing fields",
        logs: [],
      });
    }

    const result = await manager.interact(request);
    res.json(result);
  });

  // ── Legacy: close ──
  app.post("/close", async (req: Request, res: Response) => {
    if (req.body.session_id) {
      await manager.closeSession(req.body.session_id);
    }
    res.json({ success: true });
  });

  // 🚀 START SERVER FIRST
  app.listen(PORT, () => {
    console.log(`\n🚀 NEO Worker v5.0 (Hot Sessions + DB)`);
    console.log(`   Port: ${PORT}`);
    console.log(`   DB: ${SUPABASE_URL ? "configured" : "not configured"}`);
    console.log(`   Ready: ${manager.getStatus().ready}\n`);
  });

  // 🔥 START BROWSER ASYNC (НЕ блокира boot)
  manager
    .start()
    .then(() => console.log("[BOOT] HotSessionManager ready"))
    .catch((err) => {
      console.error("[BOOT] HotSessionManager failed:", err);
    });

  // Graceful shutdown
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
