/**
 * NEO WORKER v6.3.0-smart-booking — Universal, deterministic, schema-first
 *
 * Patch v6.1.0-universal-choices:
 * - scanWizardStep detects ALL interactive choice elements universally
 * - countUnfilledVisibleFields detects unselected radios + div choices
 * - fillWizard matches ANY choice from data by group name/label
 * - buildWizardNeedPayload checks choice groups as missing_required
 * - Handles multi-step wizards where new fields appear after interaction
 *
 * Patch v6.2.0-booking-check:
 * - NEW: POST /check-availability endpoint
 * - Auto-detects booking widgets (inline forms, iframes, buttons)
 * - Crawls booking form fields and returns required_fields for Gemini
 * - Fills check-in/check-out/adults/children/rooms across all frame contexts
 * - Scrapes availability results: room names, price/night, total price, currency
 * - Supports: MPHB, Beds24, Sirvoy, Lodgify, Cloudbeds, generic WordPress booking
 * - Returns only info — does NOT make actual reservations
 *
 * Patch v6.3.0-smart-booking:
 * - URL resolution: form_schemas.url → demo_sessions.url by session id → siteMap.url
 * - AI-powered booking button detection via Gemini 2.0 Flash Lite
 * - No hardcoded selectors — works on ANY site universally
 * - LLM scores ALL visible clickable elements, picks the most booking-relevant one
 * - Falls back gracefully: AI → DOM keyword scan → proceed without click
 * - ENV: GEMINI_API_KEY required for AI detection
 * - /fill-form with kind=availability and NO schema → auto-routes to checkAvailability
 * - Accepts both mphb_* and generic check_in/check_out/adults/children keys
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

// ─────────────────────────────────────────────────────────
// Booking availability interfaces
// ─────────────────────────────────────────────────────────

interface CheckAvailabilityRequest {
  site_id: string;
  session_id?: string;
  /** URL override — ако не е подаден взима от form_schemas или siteMap */
  url?: string;
  /**
   * Данни за търсене. Ако не са подадени worker-ът връща needs_input=true
   * Ключове: check_in, check_out, adults, children, rooms, promo_code
   */
  booking_data?: Record<string, string>;
  /** Само crawl — не попълва формата */
  crawl_only?: boolean;
}

interface RequiredBookingField {
  key: string;
  label: string;
  type: string;
  options?: string[];
  example?: string;
  selector?: string;
}

interface RoomResult {
  name: string;
  price_per_night?: string;
  total_price?: string;
  currency?: string;
  availability?: string;
  description?: string;
  capacity?: string;
}

interface AvailabilityResult {
  success: boolean;
  needs_input?: boolean;
  required_fields?: RequiredBookingField[];
  rooms?: RoomResult[];
  message: string;
  source_url?: string;
  widget_vendor?: string;
  raw_snippet?: string;
}

// ─────────────────────────────────────────────────────────
// Booking widget vendor detection constants
// ─────────────────────────────────────────────────────────

const BOOKING_IFRAME_VENDORS: Record<string, string> = {
  "mphb":        "motopress-hotel-booking",
  "booking.com": "booking.com-widget",
  "beds24":      "beds24",
  "eviivo":      "eviivo",
  "sirvoy":      "sirvoy",
  "lodgify":     "lodgify",
  "cloudbeds":   "cloudbeds",
  "guesty":      "guesty",
  "hostfully":   "hostfully",
  "resly":       "resly",
  "roomcloud":   "roomcloud",
  "hotel3s":     "hotel3s",
  "pms365":      "pms365",
};


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

  // ═══════════════════════════════════════════════════════════
  // /check-availability — Booking Widget Handler
  // ═══════════════════════════════════════════════════════════

  /**
   * Взима URL за отваряне по приоритет:
   * 1. Всеки ред в form_schemas за тази сесия → взима .url
   * 2. demo_sessions WHERE id = session_id → взима .url
   * 3. siteMap.url (от /prepare-session payload)
   */
  /**
   * Връща само frames, които са booking-свързани или главния frame.
   * Филтрира reCAPTCHA, Google Analytics, Facebook и др. junk frames.
   */
  private getBookingFrames(page: Page) {
    const JUNK_RE = /recaptcha|google\.com\/recaptcha|gstatic\.com|facebook\.com|analytics|gtm\.js|doubleclick|googletagmanager|googlesyndication|adsbygoogle/i;
    const mainFrame = page.mainFrame();
    const otherFrames = page.frames()
      .filter(f => {
        const u = f.url();
        if (!u || u === "about:blank" || u === page.url()) return false;
        if (JUNK_RE.test(u)) return false;
        return true;
      });
    return [mainFrame, ...otherFrames];
  }

  private async resolveBookingUrl(session: HotSession, sessionId: string): Promise<string> {
    // 1) form_schemas — взима url от първия наличен ред (всякакъв kind)
    if (session.formSchemas.length > 0) {
      for (const schema of session.formSchemas) {
        if (schema.url) {
          console.log(`[URL-RESOLVE] from form_schemas: ${schema.url}`);
          return schema.url;
        }
      }
    }

    // 2) demo_sessions WHERE id = session_id
    if (this.supabase && sessionId) {
      try {
        const { data, error } = await this.supabase
          .from("demo_sessions")
          .select("url")
          .eq("id", sessionId)
          .maybeSingle();

        if (!error && data?.url) {
          console.log(`[URL-RESOLVE] from demo_sessions: ${data.url}`);
          return String(data.url);
        }
      } catch (e) {
        console.log(`[URL-RESOLVE] demo_sessions lookup failed: ${e}`);
      }
    }

    // 3) siteMap fallback
    const fallback = session.siteMap.url || "";
    console.log(`[URL-RESOLVE] fallback siteMap.url: ${fallback}`);
    return fallback;
  }

  async checkAvailability(req: CheckAvailabilityRequest): Promise<AvailabilityResult> {
    const { site_id, session_id, url, booking_data, crawl_only } = req;

    const session = this.sessions.get(site_id);
    if (!session) {
      return { success: false, message: "Няма активна сесия. Извикай /prepare-session първо." };
    }
    session.lastActivity = Date.now();

    // Зареди schemas ако липсват
    const dbSessionId = session_id || session.sessionId || site_id;
    if (session.formSchemas.length === 0 && dbSessionId) {
      session.formSchemas = await this.loadFormSchemas(dbSessionId);
    }

    // Определи target URL — req.url override → form_schemas → demo_sessions → siteMap
    let targetUrl = url || "";
    if (!targetUrl) {
      targetUrl = await this.resolveBookingUrl(session, dbSessionId);
    }
    if (targetUrl && !targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl;

    // Навигирай ако е нужно
    if (targetUrl) {
      try {
        const cur = new URL(session.page.url());
        const tgt = new URL(targetUrl);
        if (cur.pathname !== tgt.pathname || cur.hostname !== tgt.hostname) {
          console.log(`[CHECK-AVAIL] Navigating to ${targetUrl}`);
          await session.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          await session.page.waitForTimeout(1500);
          await this.dismissCookieBanner(session.page);
        }
      } catch (e) {
        console.log(`[CHECK-AVAIL] Nav error: ${e}`);
      }
    }

    // Открий и кликни booking widget
    const widgetFound = await this.findAndClickBookingWidget(session.page);
    console.log(`[CHECK-AVAIL] widget_found=${widgetFound.found} vendor=${widgetFound.vendor} method=${widgetFound.method}`);

    // ── След клик: провери дали се е отворил нов таб или cross-origin iframe ──
    // Ако има cross-origin booking iframe (quendoo, beds24, etc.) → навигирай директно към него
    await session.page.waitForTimeout(2000); // Изчакай iframe-а да се зареди
    const bookingIframeUrl = await this.detectCrossOriginBookingIframe(session.page);
    if (bookingIframeUrl) {
      console.log(`[CHECK-AVAIL] Cross-origin booking iframe detected: ${bookingIframeUrl}`);
      console.log(`[CHECK-AVAIL] Navigating directly to iframe URL for full DOM access`);
      try {
        await session.page.goto(bookingIframeUrl, { waitUntil: "networkidle", timeout: 25000 });
        await session.page.waitForTimeout(1500);
        await this.dismissCookieBanner(session.page);
        console.log(`[CHECK-AVAIL] Now on: ${session.page.url()}`);
      } catch (e) {
        console.log(`[CHECK-AVAIL] iframe nav error: ${e}`);
        // Опитай с domcontentloaded ако networkidle timeout-не
        try {
          await session.page.goto(bookingIframeUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
          await session.page.waitForTimeout(2000);
        } catch {}
      }
    }

    // Crawl формата (сега сме на правилната страница)
    const crawled = await this.scrapeBookingWidgetForm(session.page);
    console.log(`[CHECK-AVAIL] crawled fields=${crawled.required_fields.length} vendor=${crawled.vendor}`);

    if (crawl_only) {
      return {
        success: true,
        needs_input: crawled.required_fields.length > 0,
        required_fields: crawled.required_fields,
        message: "Crawl завършен",
        source_url: session.page.url(),
        widget_vendor: crawled.vendor || widgetFound.vendor,
      };
    }

    // Ако няма booking_data → върни required_fields за Gemini
    if (!booking_data || Object.keys(booking_data).length === 0) {
      return {
        success: false,
        needs_input: true,
        required_fields: crawled.required_fields,
        message: "Необходими са данни за резервацията",
        source_url: session.page.url(),
        widget_vendor: crawled.vendor || widgetFound.vendor,
      };
    }

    // Попълни widget-а
    const fillResult = await this.fillBookingWidget(session.page, booking_data, crawled);
    console.log(`[CHECK-AVAIL] fill_ok=${fillResult.ok} msg=${fillResult.message}`);

    if (!fillResult.ok) {
      return {
        success: false,
        needs_input: fillResult.needs_more_input,
        required_fields: fillResult.missing_fields,
        message: fillResult.message,
        source_url: session.page.url(),
        widget_vendor: crawled.vendor || widgetFound.vendor,
      };
    }

    // Изчакай и scraпни резултати — по-дълго чакане за бавни booking системи
    await session.page.waitForTimeout(3000);
    await this.dismissCookieBanner(session.page);

    const results = await this.scrapeBookingResults(session.page);

    // raw_snippet вече идва от правилния frame (Quendoo/iframe) в scrapeBookingResults
    // НЕ взимаме pageText от session.page — може да сме навигирани към друг URL
    const rawSnippet = results.raw_snippet || "";

    // Допълнителен лог за debugging
    console.log(`[CHECK-AVAIL] rooms=${results.rooms.length} raw_snippet_len=${rawSnippet.length} current_url=${session.page.url().slice(0, 80)}`);
    if (results.rooms.length > 0) {
      results.rooms.forEach((r, i) => console.log(`[ROOM-${i}] name="${r.name}" price="${r.price_per_night}" total="${r.total_price}"`));
    } else if (rawSnippet) {
      console.log(`[RAW-SNIPPET] ${rawSnippet.slice(0, 300)}`);
    }

    const hasRooms = results.rooms.length > 0;

    // Ако нямаме нито структурирани стаи нито raw_snippet от iframe → взимаме page text
    let finalSnippet = rawSnippet;
    if (!finalSnippet) {
      finalSnippet = await session.page.evaluate(() =>
        (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 3000)
      ).catch(() => "");
      console.log(`[CHECK-AVAIL] fallback pageText len=${finalSnippet.length}`);
    }

    return {
      success: true,
      rooms: results.rooms,
      message: hasRooms
        ? `Намерени ${results.rooms.length} вид/а стаи`
        : finalSnippet
          ? "Проверих наличността — виж raw_snippet за резултата"
          : "Не намерих стаи — провери дали формата е попълнена правилно",
      source_url: session.page.url(),
      widget_vendor: crawled.vendor || widgetFound.vendor,
      raw_snippet: finalSnippet,
    };
  }

  /**
   * AI-POWERED универсален детектор на booking бутони.
   *
   * Логика:
   * 1. Провери дали вече има видима booking форма → не е нужен клик
   * 2. Провери за iframe с познат vendor
   * 3. Събери ВСИЧКИ видими кликаеми елементи от DOM с техните текстове + позиции
   * 4. Изпрати списъка към Claude Vision → LLM избира кой да се кликне
   * 5. Кликни по координати (не по selector — работи на ВСЕКИ сайт)
   * 6. Fallback: DOM keyword scan без AI
   */
  private async findAndClickBookingWidget(
    page: Page
  ): Promise<{ found: boolean; vendor: string; method: string }> {

    // ── A) Вече има inline booking форма ────────────────────────────
    const hasInlineForm = await page.evaluate(() => {
      const re = /check.?in|check.?out|настаняване|напускане|arrival|departure|mphb_check|checkin|checkout/i;
      return Array.from(document.querySelectorAll("input, select")).some(el => {
        const a = el as any;
        return re.test(`${a.name||""} ${a.id||""} ${a.placeholder||""} ${a.getAttribute?.("aria-label")||""}`);
      });
    }).catch(() => false);

    if (hasInlineForm) {
      console.log("[BOOKING-WIDGET] Inline booking form already visible");
      return { found: true, vendor: "inline", method: "inline_form" };
    }

    // ── B) iframe с познат vendor ────────────────────────────────────
    const iframeVendor = await page.evaluate((vendors: Record<string, string>) => {
      for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
        const src = ((iframe as any).src || iframe.getAttribute("data-src") || "").toLowerCase();
        for (const [key, name] of Object.entries(vendors)) {
          if (src.includes(key)) return { name, key };
        }
      }
      return null;
    }, BOOKING_IFRAME_VENDORS).catch(() => null);

    if (iframeVendor) {
      console.log(`[BOOKING-WIDGET] iframe vendor: ${iframeVendor.name}`);
      try {
        await page.evaluate((k: string) => {
          const iframe = Array.from(document.querySelectorAll("iframe"))
            .find(el => ((el as any).src || "").includes(k));
          if (iframe) (iframe as HTMLElement).scrollIntoView({ behavior: "smooth" });
        }, iframeVendor.key);
        await page.waitForTimeout(600);
      } catch {}
      return { found: true, vendor: iframeVendor.name, method: "iframe_vendor" };
    }

    // ── C) Събери всички видими кликаеми елементи ───────────────────
    const clickableElements = await page.evaluate(() => {
      const isVisible = (el: Element) => {
        const s = window.getComputedStyle(el as HTMLElement);
        if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 10 && r.height > 10;
      };

      const results: Array<{
        index: number;
        tag: string;
        text: string;
        ariaLabel: string;
        title: string;
        href: string;
        className: string;
        id: string;
        x: number;
        y: number;
        w: number;
        h: number;
      }> = [];

      const seen = new Set<string>();
      let idx = 0;

      const els = Array.from(document.querySelectorAll(
        "button, a, [role='button'], [role='link'], input[type='button'], input[type='submit'], " +
        "[class*='btn'], [class*='button'], [class*='nav'], [class*='menu']"
      ));

      for (const el of els) {
        if (!isVisible(el)) continue;
        const any = el as any;
        const r   = (el as HTMLElement).getBoundingClientRect();
        const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
        const aria = any.getAttribute?.("aria-label") || "";
        const title = any.title || "";
        const href  = any.href ? String(any.href).replace(location.origin, "").slice(0, 80) : "";
        const cls   = (any.className || "").toString().slice(0, 80);
        const id    = (any.id || "").slice(0, 40);

        // Skip empty/useless
        if (!text && !aria && !title && !href) continue;

        const key = `${text}|${aria}|${Math.round(r.x)}|${Math.round(r.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          index: idx++,
          tag: el.tagName.toLowerCase(),
          text, ariaLabel: aria, title, href, className: cls, id,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });

        if (results.length >= 80) break;
      }

      return results;
    }).catch(() => [] as any[]);

    console.log(`[BOOKING-WIDGET] Found ${clickableElements.length} clickable elements for AI analysis`);

    if (clickableElements.length === 0) {
      return { found: false, vendor: "", method: "no_elements" };
    }

    // ── D) AI анализ — изпрати елементите към Claude ────────────────
    const aiResult = await this.askAiForBookingElement(clickableElements, page);

    if (aiResult.index >= 0) {
      const el = clickableElements[aiResult.index];
      if (el) {
        try {
          // Кликни по центъра на елемента (не по selector)
          await page.mouse.click(el.x, el.y);
          await page.waitForTimeout(1400);

          // Провери дали се е отворила форма / нова страница
          const afterCheck = await page.evaluate(() => {
            const re = /check.?in|check.?out|настаняване|arrival|departure|mphb_check|checkin|checkout|датa|date/i;
            return Array.from(document.querySelectorAll("input, select")).some(el => {
              const a = el as any;
              return re.test(`${a.name||""} ${a.id||""} ${a.placeholder||""} ${a.getAttribute?.("aria-label")||""}`);
            });
          }).catch(() => false);

          console.log(`[BOOKING-WIDGET] AI clicked index=${aiResult.index} text="${el.text}" reason="${aiResult.reason}" form_appeared=${afterCheck}`);
          return {
            found: true,
            vendor: "ai-detected",
            method: `ai:${el.text || el.ariaLabel || el.href}`,
          };
        } catch (e) {
          console.log(`[BOOKING-WIDGET] AI click failed: ${e}`);
        }
      }
    }

    // ── E) DOM keyword fallback (без AI) ────────────────────────────
    // Внимание: "Настаняване" в nav бара е DROPDOWN за типове стаи — НЕ е booking бутон!
    // Използваме двупасов подход: приоритетни → вторични (само <button>, не <a>)
    const fallbackClicked = await page.evaluate(() => {
      const PRIORITY_RE  = /^резервирай$|^book\s*now$|^reserve\s*now$|^check\s*availability$|^направи резервация$|^резервации$/i;
      const SECONDARY_RE = /резерв[ауи]|booking|наличност|свободни стаи|виж стаи|find rooms/i;
      const EXCLUDE_RE   = /^настаняване$|конферентн|ресторант|оферт|контакт|начало|галери|за нас|^bg$|^en$/i;

      const isVisible = (el: Element) => {
        const s = window.getComputedStyle(el as HTMLElement);
        if (s.display === "none" || s.visibility === "hidden") return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 10 && r.height > 10;
      };

      const allEls = Array.from(document.querySelectorAll(
        "button, a, [role='button'], input[type='submit'], input[type='button']"
      ));

      // Pass 1: точни booking бутони
      for (const el of allEls) {
        const text = (el.textContent || "").trim();
        if (!text || text.length > 40 || !isVisible(el)) continue;
        if (EXCLUDE_RE.test(text)) continue;
        if (PRIORITY_RE.test(text)) {
          (el as HTMLElement).click();
          return `priority:${text}`;
        }
      }

      // Pass 2: само <button> и <input> — не <a> (твърде много false positives в nav)
      for (const el of allEls) {
        const tag = el.tagName.toLowerCase();
        if (tag === "a") continue;
        const text = (el.textContent || "").trim();
        if (!text || text.length > 50 || !isVisible(el)) continue;
        if (EXCLUDE_RE.test(text)) continue;
        if (SECONDARY_RE.test(text)) {
          (el as HTMLElement).click();
          return `secondary:${text}`;
        }
      }

      return "";
    }).catch(() => "");

    if (fallbackClicked) {
      await page.waitForTimeout(1200);
      console.log(`[BOOKING-WIDGET] DOM keyword fallback clicked: "${fallbackClicked}"`);
      return { found: true, vendor: "dom-keyword", method: `dom:${fallbackClicked}` };
    }

    console.log("[BOOKING-WIDGET] No booking button found — will attempt form fill directly on current page");
    return { found: false, vendor: "", method: "none" };
  }

  /**
   * Открива cross-origin booking iframe след клик на booking бутон.
   * Quendoo, Beds24, Sirvoy и др. се зареждат като отделен iframe с различен origin.
   * Playwright НЕ може да evaluate() в cross-origin frames → навигираме директно.
   *
   * Връща URL-а на iframe-а ако е booking-свързан, иначе "".
   */
  private async detectCrossOriginBookingIframe(page: Page): Promise<string> {
    // Знаем vendors чийто iframe URL-ове са cross-origin booking системи
    const BOOKING_IFRAME_URL_RE = /quendoo|beds24|sirvoy|lodgify|cloudbeds|eviivo|guesty|hostfully|resly|roomcloud|hotel3s|pms365|booking\.com\/hotel|reservations\./i;

    // Проверявай и iframe src атрибути в DOM
    const iframeSrc = await page.evaluate((re: string) => {
      const regex = new RegExp(re, "i");
      const iframes = Array.from(document.querySelectorAll("iframe"));
      for (const f of iframes) {
        const src = (f as any).src || f.getAttribute("data-src") || "";
        if (src && regex.test(src)) return src;
      }
      return "";
    }, BOOKING_IFRAME_URL_RE.source).catch(() => "");

    if (iframeSrc) {
      console.log(`[IFRAME-DETECT] Found booking iframe in DOM: ${iframeSrc.slice(0, 80)}`);
      return iframeSrc;
    }

    // Провери и Playwright frame обектите (може да са lazy-loaded)
    for (const frame of page.frames()) {
      const frameUrl = frame.url();
      if (!frameUrl || frameUrl === "about:blank" || frameUrl === page.url()) continue;
      // Пропускай reCAPTCHA, Google Analytics, Facebook и др.
      if (/recaptcha|google\.com\/recaptcha|gstatic|facebook|analytics|gtm\.js|doubleclick/i.test(frameUrl)) continue;
      if (BOOKING_IFRAME_URL_RE.test(frameUrl)) {
        console.log(`[IFRAME-DETECT] Found booking iframe via Playwright frames: ${frameUrl.slice(0, 80)}`);
        return frameUrl;
      }
    }

    return "";
  }

  /**
   * LLM анализира текстовете и избира кой е booking/reservation бутонът.
   * Не разчита на screenshot — само на текст + атрибути (бързо и надеждно).
   */
  private async askAiForBookingElement(
    elements: Array<{
      index: number; tag: string; text: string; ariaLabel: string;
      title: string; href: string; className: string; id: string;
      x: number; y: number; w: number; h: number;
    }>,
    page: Page
  ): Promise<{ index: number; reason: string }> {
    // Вземи заглавие и URL на страницата за контекст
    const pageContext = await page.evaluate(() => ({
      title: document.title || "",
      url:   location.href || "",
      h1:    (document.querySelector("h1")?.textContent || "").trim().slice(0, 80),
    })).catch(() => ({ title: "", url: "", h1: "" }));

    // Форматирай елементите като кратък списък за LLM
    const elementList = elements
      .map(e => {
        const label = e.text || e.ariaLabel || e.title || e.href;
        const extra  = [e.className, e.id].filter(Boolean).join(" ").slice(0, 50);
        return `[${e.index}] <${e.tag}> "${label}"${extra ? ` (${extra})` : ""}`;
      })
      .join("\n");

    const prompt = `You are analyzing a Bulgarian hotel website to find the BOOKING SEARCH button — the one that opens a date picker or leads to a room availability search form.

Page: "${pageContext.title}" | H1: "${pageContext.h1}" | URL: ${pageContext.url}

Visible clickable elements:
${elementList}

TASK: Find the element that triggers a booking/availability search form (date picker, check-in/check-out form).

PREFER (highest priority first):
1. Button labeled "РЕЗЕРВИРАЙ", "Book Now", "Check Availability", "Reserve" that is visually prominent (large, colored)
2. A link/button directly labeled "Резервации" or "Booking" that goes to a booking page (not a dropdown)
3. A search/submit button inside a booking widget (e.g. "Търси", "Search")

AVOID (these are NOT what we want):
- Navigation dropdown items like "Настаняване ▸" that open a sub-menu with room descriptions
- Language switchers (BG/EN)
- "Контакти", "Оферти", "Ресторант", "Конферентна зала" nav links
- Login, social media, newsletter links

IMPORTANT: "Настаняване" in a top navigation bar is a DROPDOWN MENU for room types — NOT a booking button. Skip it.
The real booking button is usually a visually distinct button (different color, often top-right) labeled "РЕЗЕРВИРАЙ" or similar.

If NO element is a booking button, return index -1.

Respond ONLY with valid JSON: {"index": NUMBER, "reason": "SHORT_REASON"}`;

    try {
      const apiKey = (process.env.GEMINI_API_KEY || "").trim();
      if (!apiKey) {
        console.log("[AI-BOOKING] GEMINI_API_KEY not set — skipping AI detection");
        return { index: -1, reason: "no_api_key" };
      }

      // Пробвай модели по ред — от най-евтин към по-скъп
      // При 404 "no longer available" минава на следващия
      const MODELS = [
        "gemini-2.5-flash-preview-04-17",
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite",
        "gemini-1.5-flash",
        "gemini-1.5-flash-8b",
      ];

      for (const model of MODELS) {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 120, temperature: 0 },
            }),
          }
        );

        if (response.status === 404) {
          console.log(`[AI-BOOKING] Model ${model} not available, trying next...`);
          continue;
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          console.log(`[AI-BOOKING] Gemini error ${response.status} on ${model}: ${errText.slice(0, 80)}`);
          return { index: -1, reason: "api_error" };
        }

        const data = await response.json() as any;
        const rawText = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
        console.log(`[AI-BOOKING] ${model} → ${rawText}`);

        const clean  = rawText.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);
        if (typeof parsed?.index === "number") {
          return { index: parsed.index, reason: parsed.reason || "" };
        }
        break;
      }
    } catch (e) {
      console.log(`[AI-BOOKING] Parse/fetch error: ${e}`);
    }

    return { index: -1, reason: "parse_error" };
  }

  /**
   * Crawl-ва booking формата (основен frame + iframes).
   * Важно: MPHB и много booking системи използват СКРИТИ inputs
   * (display:none) с flatpickr/custom picker отгоре.
   * Затова сканираме ВСИЧКИ inputs — и скрити, и видими.
   */
  private async scrapeBookingWidgetForm(page: Page): Promise<{
    required_fields: RequiredBookingField[];
    vendor: string;
  }> {
    const frames = this.getBookingFrames(page);

    for (const frame of frames) {
      try {
        const result = await frame.evaluate(() => {
          const vendorHints: string[] = [];
          const html = document.body?.innerHTML || "";
          if (html.includes("mphb"))      vendorHints.push("motopress-hotel-booking");
          if (html.includes("beds24"))    vendorHints.push("beds24");
          if (html.includes("sirvoy"))    vendorHints.push("sirvoy");
          if (html.includes("lodgify"))   vendorHints.push("lodgify");
          if (html.includes("cloudbeds")) vendorHints.push("cloudbeds");
          if (html.includes("eviivo"))    vendorHints.push("eviivo");

          // Не проверяваме visibility — MPHB скрива реалните inputs!
          // Само пропускаме disabled и type=hidden/submit/button/image/reset
          const getLabel = (el: Element): string => {
            const any = el as any;
            if (any.id) {
              const lab = document.querySelector(`label[for="${CSS.escape(any.id)}"]`);
              if (lab?.textContent) return lab.textContent.trim();
            }
            const ariaLabel = any.getAttribute?.("aria-label");
            if (ariaLabel) return ariaLabel.trim();
            if (any.placeholder) return any.placeholder.trim();
            let p: Element | null = el;
            for (let i = 0; i < 5; i++) {
              p = p?.parentElement || null;
              if (!p) break;
              const lab = p.querySelector("label");
              if (lab?.textContent) return lab.textContent.trim();
            }
            return any.name || any.id || "";
          };

          const checkInRe  = /check.?in|arrival|настаняване|пристигане|mphb_check_in|date.?from|start.?date/i;
          const checkOutRe = /check.?out|departure|напускане|заминаване|mphb_check_out|date.?to|end.?date/i;
          const adultsRe   = /adult|възрастн|гост|person|pax/i;
          const childrenRe = /child|дете|деца|kid/i;
          const roomsRe    = /\broom\b|стая|стаи|num.?room/i;
          const promoRe    = /promo|coupon|код.?отстъп|discount/i;

          const fields: any[] = [];
          const seen = new Set<string>();

          // Сканирай ВСИЧКИ inputs и select-и — включително скрити (flatpickr pattern)
          document.querySelectorAll("input, select").forEach((el: any) => {
            const type = (el.type || "").toLowerCase();
            if (["submit", "button", "image", "reset", "file", "checkbox", "radio"].includes(type)) return;
            if (el.disabled) return;

            const label = getLabel(el);
            const name  = el.name || el.id || "";
            const combined = `${name} ${label}`.toLowerCase();

            let key = "";
            let fieldType = type || "text";
            let example = "";

            if (checkInRe.test(combined))       { key = "check_in";   fieldType = "date";   example = "2025-08-10"; }
            else if (checkOutRe.test(combined)) { key = "check_out";  fieldType = "date";   example = "2025-08-15"; }
            else if (adultsRe.test(combined))   { key = "adults";     fieldType = "number"; example = "2"; }
            else if (childrenRe.test(combined)) { key = "children";   fieldType = "number"; example = "0"; }
            else if (roomsRe.test(combined))    { key = "rooms";      fieldType = "number"; example = "1"; }
            else if (promoRe.test(combined))    { key = "promo_code"; fieldType = "text";   example = ""; }

            if (!key || seen.has(key)) return;
            seen.add(key);

            const options = el.tagName.toLowerCase() === "select"
              ? Array.from(el.options || []).slice(0, 20)
                  .map((o: any) => (o.text || "").trim())
                  .filter((t: string) => t.length > 0)
              : [];

            fields.push({
              key,
              label: label || name || key,
              type:  el.tagName.toLowerCase() === "select" ? "select" : fieldType,
              options: options.length > 0 ? options : undefined,
              example,
              selector: el.id ? `#${CSS.escape(el.id)}` : (el.name ? `[name="${el.name}"]` : ""),
              hidden: (() => {
                const s = window.getComputedStyle(el);
                return s.display === "none" || s.visibility === "hidden";
              })(),
            });
          });

          return { fields, vendor: vendorHints[0] || "" };
        });

        if (result.fields.length > 0) {
          console.log(`[SCRAPE-WIDGET] ${result.fields.length} booking fields | vendor=${result.vendor} | frame=${frame.url().slice(0, 60)}`);
          return { required_fields: result.fields, vendor: result.vendor };
        }
      } catch (e) {
        console.log(`[SCRAPE-WIDGET] frame error: ${e}`);
      }
    }

    // Fallback — стандартни полета
    console.log("[SCRAPE-WIDGET] No booking fields found — returning standard fallback fields");
    return {
      required_fields: [
        { key: "check_in",  label: "Дата на настаняване", type: "date",   example: "2025-08-10" },
        { key: "check_out", label: "Дата на напускане",   type: "date",   example: "2025-08-15" },
        { key: "adults",    label: "Брой възрастни",      type: "number", example: "2" },
        { key: "children",  label: "Брой деца",           type: "number", example: "0" },
      ],
      vendor: "unknown",
    };
  }

  /**
   * Попълва booking widget-а с booking_data.
   * Работи с React/Vue/flatpickr чрез native DOM events.
   */
  private async fillBookingWidget(
    page: Page,
    data: Record<string, string>,
    crawled: { required_fields: RequiredBookingField[]; vendor: string }
  ): Promise<{
    ok: boolean;
    message: string;
    needs_more_input?: boolean;
    missing_fields?: RequiredBookingField[];
  }> {
    const MANDATORY = ["check_in", "check_out"];
    const missing = MANDATORY.filter(k => !data[k]?.trim());
    if (missing.length > 0) {
      return {
        ok: false,
        message: `Липсват задължителни данни: ${missing.join(", ")}`,
        needs_more_input: true,
        missing_fields: crawled.required_fields.filter(f => missing.includes(f.key)),
      };
    }

    const normalizeDate = (d: string): string => {
      if (!d) return "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) return d.trim();
      const m = d.trim().match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
      if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      return d.trim();
    };

    const ci       = normalizeDate(data.check_in  || "");
    const co       = normalizeDate(data.check_out || "");
    const adults   = data.adults    || "2";
    const children = data.children  || "0";
    const rooms    = data.rooms     || "1";
    const promo    = data.promo_code || "";

    const frames = this.getBookingFrames(page);
    let totalFilled = 0;

    for (const frame of frames) {
      try {
        const filledCount = await frame.evaluate(
          ({ ci, co, adults, children, rooms, promo }: {
            ci: string; co: string; adults: string; children: string; rooms: string; promo: string;
          }) => {
            let filled = 0;

            /**
             * setInput — работи и за скрити inputs (flatpickr/MPHB pattern).
             * Използва native value setter + всички нужни events.
             */
            const setInput = (el: HTMLInputElement | null, val: string): boolean => {
              if (!el) return false;
              try {
                // Native setter за React/framework controlled inputs
                const nativeSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLInputElement.prototype, "value"
                )?.set;
                if (nativeSetter) nativeSetter.call(el, val);
                else el.value = val;

                // Изстрелвай всички events за да засечат flatpickr/Vue/React
                el.dispatchEvent(new Event("input",  { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                el.dispatchEvent(new Event("blur",   { bubbles: true }));

                // Ако flatpickr — forcе update чрез _flatpickr instance
                const fp = (el as any)._flatpickr;
                if (fp && typeof fp.setDate === "function") {
                  fp.setDate(val, true);
                }

                return true;
              } catch { return false; }
            };

            const setSelect = (el: HTMLSelectElement | null, val: string): boolean => {
              if (!el) return false;
              const num = parseInt(val, 10);
              // Опитай точно match по value или text
              for (const opt of Array.from(el.options)) {
                const ov = parseInt(opt.value, 10);
                if (opt.value === val || opt.text.trim() === val ||
                    (!isNaN(num) && !isNaN(ov) && ov === num)) {
                  el.value = opt.value;
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                  return true;
                }
              }
              // Fallback: избери по числов индекс (1 → втора опция, защото 0 е placeholder)
              if (!isNaN(num) && num > 0) {
                const idx = Math.min(num, el.options.length - 1);
                if (idx > 0) {
                  el.selectedIndex = idx;
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                  return true;
                }
              }
              return false;
            };

            /**
             * findInput — търси по множество name/id варианти.
             * НЕ проверява visibility — скритите MPHB inputs са валидни.
             */
            const findInput = (keys: string[]): HTMLInputElement | null => {
              for (const k of keys) {
                const el = (
                  document.querySelector(`input[name="${k}"]`) ||
                  document.querySelector(`#${k}`) ||
                  document.querySelector(`input[name*="${k}"]`) ||
                  document.querySelector(`input[id*="${k}"]`)
                ) as HTMLInputElement | null;
                if (el && !el.disabled) return el;
              }
              return null;
            };

            const findSelect = (keys: string[]): HTMLSelectElement | null => {
              for (const k of keys) {
                const el = (
                  document.querySelector(`select[name="${k}"]`) ||
                  document.querySelector(`select#${k}`) ||
                  document.querySelector(`select[name*="${k}"]`) ||
                  document.querySelector(`select[id*="${k}"]`)
                ) as HTMLSelectElement | null;
                if (el && !el.disabled) return el;
              }
              return null;
            };

            // ── Check-in ──────────────────────────────────────────────
            if (ci) {
              const inp = findInput([
                "mphb_check_in_date", "check_in", "checkin", "arrival",
                "check-in", "startdate", "start_date", "date_from", "datefrom",
                "from", "date-from", "date_start", "arrivaldate",
              ]);
              if (inp && setInput(inp, ci)) {
                filled++;
                console.log(`[FILL-WIDGET] check_in="${ci}" → ${inp.name || inp.id}`);
              }
            }

            // ── Check-out ─────────────────────────────────────────────
            if (co) {
              const inp = findInput([
                "mphb_check_out_date", "check_out", "checkout", "departure",
                "check-out", "enddate", "end_date", "date_to", "dateto",
                "to", "date-to", "date_end", "departuredate",
              ]);
              if (inp && setInput(inp, co)) {
                filled++;
                console.log(`[FILL-WIDGET] check_out="${co}" → ${inp.name || inp.id}`);
              }
            }

            // ── Adults ────────────────────────────────────────────────
            if (adults) {
              const sel = findSelect([
                "mphb_adults", "adults", "adult", "guests", "pax",
                "num_adults", "numadults", "persons", "num-adults",
              ]);
              if (sel && setSelect(sel, adults)) {
                filled++;
                console.log(`[FILL-WIDGET] adults="${adults}" → select ${sel.name || sel.id}`);
              } else {
                const inp = findInput([
                  "mphb_adults", "adults", "adult", "guests", "pax", "num_adults",
                ]);
                if (inp && setInput(inp, adults)) {
                  filled++;
                  console.log(`[FILL-WIDGET] adults="${adults}" → input ${inp.name || inp.id}`);
                }
              }
            }

            // ── Children ──────────────────────────────────────────────
            if (children) {
              const sel = findSelect([
                "mphb_children", "children", "child", "kids",
                "num_children", "numchildren", "num-children",
              ]);
              if (sel && setSelect(sel, children)) {
                filled++;
                console.log(`[FILL-WIDGET] children="${children}" → select ${sel.name || sel.id}`);
              } else {
                const inp = findInput([
                  "mphb_children", "children", "child", "kids", "num_children",
                ]);
                if (inp && setInput(inp, children)) {
                  filled++;
                  console.log(`[FILL-WIDGET] children="${children}" → input ${inp.name || inp.id}`);
                }
              }
            }

            // ── Rooms ─────────────────────────────────────────────────
            if (rooms && parseInt(rooms, 10) > 1) {
              const sel = findSelect([
                "rooms", "num_rooms", "numrooms", "room_count", "mphb_rooms",
              ]);
              if (sel && setSelect(sel, rooms)) filled++;
            }

            // ── Promo code ────────────────────────────────────────────
            if (promo) {
              const inp = findInput([
                "promo_code", "coupon", "promocode", "promo", "discount_code", "code",
              ]);
              if (inp && setInput(inp, promo)) filled++;
            }

            return filled;
          },
          { ci, co, adults, children, rooms, promo }
        );

        totalFilled += filledCount;
        if (filledCount > 0) {
          console.log(`[FILL-WIDGET] Filled ${filledCount} fields in frame: ${frame.url().slice(0, 60)}`);
          break;
        }
      } catch (e) {
        console.log(`[FILL-WIDGET] frame error: ${e}`);
      }
    }

    if (totalFilled === 0) {
      console.log("[FILL-WIDGET] Could not fill any field — trying direct fillAvailability approach");
      // Последен опит: директно чрез fillAvailability (MPHB-aware)
      const fakeSchema: any = { kind: "availability", url: page.url(), schema: {} };
      const directResult = await this.fillAvailability(page, fakeSchema, {
        mphb_check_in_date:  ci,
        mphb_check_out_date: co,
        mphb_adults:   adults,
        mphb_children: children,
      }, true);

      if (directResult.ok) {
        return { ok: true, message: `fillAvailability fallback: ${directResult.message}` };
      }
      return { ok: false, message: "Не успях да попълня нито едно поле в booking widget" };
    }

    // Submit — натисни Search/Check бутона
    await page.waitForTimeout(400);
    const submitted = await this.submitBookingSearch(page);
    const actions = [`Попълних ${totalFilled} полета`];
    if (submitted) actions.push("Кликнах Търси/Submit");
    else actions.push("Не намерих submit бутон");

    return { ok: true, message: actions.join("; ") };
  }

  /**
   * Натиска "Търси"/"Search"/"Check Availability" бутона в booking widget
   */
  private async submitBookingSearch(page: Page): Promise<boolean> {
    const selectors = [
      'button:has-text("Търси")',
      'button:has-text("Търсене")',
      'button:has-text("Провери")',
      'button:has-text("Провери наличност")',
      'button:has-text("Виж стаи")',
      'button:has-text("Search")',
      'button:has-text("Check")',
      'button:has-text("Find Rooms")',
      'button:has-text("Check Availability")',
      'button:has-text("Book")',
      'input[type="submit"]',
      'button[type="submit"]',
    ];

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 3000 });
        console.log(`[SUBMIT-SEARCH] Clicked: ${sel}`);
        return true;
      } catch {}
    }

    // Iframe fallback
    for (const frame of this.getBookingFrames(page).slice(1)) {
      try {
        const ok = await frame.evaluate(() => {
          const btn = document.querySelector('button[type="submit"], input[type="submit"]') as any;
          if (!btn) return false;
          btn.click();
          return true;
        });
        if (ok) { console.log("[SUBMIT-SEARCH] iframe submit"); return true; }
      } catch {}
    }

    return false;
  }

  /**
   * Scraпва резултатите от booking търсенето.
   * Извлича: имена на стаи, цена/нощ, обща цена, валута, наличност.
   */
  private async scrapeBookingResults(page: Page): Promise<{
    rooms: RoomResult[];
    raw_snippet: string;
  }> {
    // Изчакай резултатите
    try {
      await page.waitForFunction(() => {
        const body = document.body?.innerText || "";
        return /\d+\s*(?:лв|bgn|eur|usd|\$|€|£)/i.test(body) ||
               /available|наличн|свободн/i.test(body) ||
               /no\s+rooms|няма стаи|не са намерени/i.test(body);
      }, { timeout: 8000 });
    } catch {}

    await page.waitForTimeout(600);
    await this.dismissCookieBanner(page);

    const frames = this.getBookingFrames(page);

    for (const frame of frames) {
      try {
        // ПРОСТО: взимаме целия текст от frame-а — Gemini ще го прочете и разбере
        const rawText = await frame.evaluate(() =>
          (document.body?.innerText || "").replace(/\s+/g, " ").trim()
        );

        if (!rawText || rawText.length < 20) continue;

        console.log(`[SCRAPE-RESULTS] raw_text_len=${rawText.length} | frame=${frame.url().slice(0, 60)}`);
        console.log(`[SCRAPE-RESULTS] preview: ${rawText.slice(0, 200)}`);

        // Върни като raw_snippet — Gemini ще го прочете директно
        return { rooms: [], raw_snippet: rawText.slice(0, 4000) };

      } catch (e) {
        console.log(`[SCRAPE-RESULTS] frame error: ${e}`);
      }
    }

    return { rooms: [], raw_snippet: "" };
  }


  // ═══════════════════════════════════════════════════════════
  // /make-booking — Попълва резервационната форма
  // ═══════════════════════════════════════════════════════════

  /**
   * Scraпва страницата с резултати за booking форма/бутон "Резервирай".
   * Ако намери форма → попълва я с данните на клиента.
   * Ако няма форма → връща contact_email за изпращане на имейл.
   */
  async makeBooking(req: {
    site_id: string;
    session_id?: string;
    room_name?: string;
    booking_data: Record<string, string>;
    client_data: Record<string, string>; // name, email, phone, message
  }): Promise<{
    success: boolean;
    method: "form_filled" | "email_required" | "button_clicked" | "no_action";
    message: string;
    contact_email?: string;
    form_fields?: Array<{ key: string; label: string; type: string; required: boolean }>;
    needs_client_data?: boolean;
    missing_client_fields?: string[];
  }> {
    const { site_id, session_id, room_name, booking_data, client_data } = req;

    const session = this.sessions.get(site_id);
    if (!session) {
      return { success: false, method: "no_action", message: "Няма активна сесия. Извикай /prepare-session първо." };
    }
    session.lastActivity = Date.now();

    // Провери дали имаме нужните данни на клиента
    const missingClientFields: string[] = [];
    if (!client_data.name?.trim()) missingClientFields.push("Три имена");
    if (!client_data.email?.trim()) missingClientFields.push("Имейл");
    if (!client_data.phone?.trim()) missingClientFields.push("Телефон");

    if (missingClientFields.length > 0) {
      return {
        success: false,
        method: "no_action",
        needs_client_data: true,
        missing_client_fields: missingClientFields,
        message: `Нужни са данни от клиента: ${missingClientFields.join(", ")}`,
      };
    }

    // Опитай да намериш "Резервирай" бутон до избраната стая
    const bookingBtnClicked = await this.clickRoomBookingButton(session.page, room_name);
    console.log(`[MAKE-BOOKING] booking_btn_clicked=${bookingBtnClicked} room=${room_name || "any"}`);

    if (bookingBtnClicked) {
      await session.page.waitForTimeout(2000);
      await this.dismissCookieBanner(session.page);
    }

    // Провери дали се е отворила резервационна форма с лични данни
    const reservationForm = await this.scrapeReservationForm(session.page);
    console.log(`[MAKE-BOOKING] reservation_form_fields=${reservationForm.fields.length} has_submit=${!!reservationForm.submit_selector}`);

    if (reservationForm.fields.length > 0) {
      // Попълни формата
      const fillData: Record<string, string> = {
        ...client_data,
        ...booking_data,
      };

      const filledCount = await this.fillReservationForm(session.page, reservationForm, fillData);
      console.log(`[MAKE-BOOKING] filled ${filledCount} fields`);

      if (filledCount > 0 && reservationForm.submit_selector) {
        // Submit
        await session.page.waitForTimeout(500);
        try {
          const submitEl = await session.page.$(reservationForm.submit_selector);
          if (submitEl && await submitEl.isVisible().catch(() => false)) {
            await submitEl.click({ timeout: 3000 });
            await session.page.waitForTimeout(2000);
            console.log(`[MAKE-BOOKING] form submitted via ${reservationForm.submit_selector}`);
          }
        } catch (e) {
          console.log(`[MAKE-BOOKING] submit error: ${e}`);
        }

        // Провери за success
        const isSuccess = await this.detectWizardSuccess(session.page);
        return {
          success: isSuccess,
          method: "form_filled",
          message: isSuccess
            ? `Резервацията е изпратена успешно за ${room_name || "стаята"}!`
            : `Попълних формата за ${room_name || "стаята"} — моля проверете страницата`,
        };
      }

      return {
        success: false,
        method: "form_filled",
        message: "Намерих форма но не успях да я изпрати",
        form_fields: reservationForm.fields,
      };
    }

    // Няма форма → намери contact email от страницата
    const contactEmail = await this.extractContactEmail(session.page);
    console.log(`[MAKE-BOOKING] no_form → contact_email=${contactEmail || "not_found"}`);

    return {
      success: false,
      method: "email_required",
      contact_email: contactEmail || undefined,
      message: contactEmail
        ? `Резервацията изисква имейл към ${contactEmail}`
        : "Не намерих форма за резервация. Свържете се директно с хотела.",
    };
  }

  /**
   * Кликва "Резервирай" бутона за конкретна стая в резултатите
   */
  private async clickRoomBookingButton(page: Page, roomName?: string): Promise<boolean> {
    // Опит 1: намери бутон до стаята по име
    if (roomName) {
      try {
        const clicked = await page.evaluate((rName: string) => {
          const rooms = Array.from(document.querySelectorAll("[class*='room'], [class*='card'], [class*='result']"));
          for (const room of rooms) {
            const text = (room.textContent || "").toLowerCase();
            if (text.includes(rName.toLowerCase())) {
              // Намери booking бутон вътре в тази стая
              const btn = room.querySelector("a[href*='book'], a[href*='reserv'], button") as HTMLElement | null;
              if (btn) { btn.click(); return true; }
            }
          }
          return false;
        }, roomName);
        if (clicked) return true;
      } catch {}
    }

    // Опит 2: намери първия "Резервирай" / "Book" бутон
    for (const sel of [
      'a[href*="book"]', 'a[href*="reserv"]', 'a[href*="checkout"]',
      'button:has-text("Резервирай")', 'a:has-text("Резервирай")',
      'button:has-text("Book")', 'a:has-text("Book Now")',
      '[class*="book-btn"]', '[class*="reserve-btn"]',
    ]) {
      try {
        const el = await page.$(sel);
        if (!el || !await el.isVisible().catch(() => false)) continue;
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 3000 });
        return true;
      } catch {}
    }

    return false;
  }

  /**
   * Scraпва резервационна форма с лични данни (не availability форма)
   */
  private async scrapeReservationForm(page: Page): Promise<{
    fields: Array<{ key: string; label: string; selector: string; type: string; required: boolean }>;
    submit_selector: string;
  }> {
    try {
      const result = await page.evaluate(() => {
        const getLabel = (el: Element): string => {
          const any = el as any;
          if (any.id) {
            const lab = document.querySelector(`label[for="${CSS.escape(any.id)}"]`);
            if (lab?.textContent) return lab.textContent.trim();
          }
          const aria = any.getAttribute?.("aria-label");
          if (aria) return aria.trim();
          if (any.placeholder) return any.placeholder.trim();
          return any.name || any.id || "";
        };

        const nameRe   = /name|ime|имена|три имена|first|last/i;
        const emailRe  = /email|imeil|имейл|e-mail|mail/i;
        const phoneRe  = /phone|tel|telefon|телефон|gsm/i;
        const msgRe    = /message|съобщ|забел|note|comment|zabelejka/i;
        const dateRe   = /check.?in|check.?out|arrival|departure|дата|date/i;

        const fields: any[] = [];
        const seen = new Set<string>();

        document.querySelectorAll("input, textarea, select").forEach((el: any) => {
          const type = (el.type || "").toLowerCase();
          if (["submit", "button", "image", "reset", "hidden"].includes(type)) return;
          if (el.disabled) return;

          const label = getLabel(el);
          const name = el.name || el.id || "";
          const combined = `${name} ${label}`.toLowerCase();

          let key = "";
          if (nameRe.test(combined))  key = "name";
          else if (emailRe.test(combined)) key = "email";
          else if (phoneRe.test(combined)) key = "phone";
          else if (msgRe.test(combined)) key = "message";
          else if (dateRe.test(combined)) key = combined.includes("out") || combined.includes("depart") ? "check_out" : "check_in";

          if (!key || seen.has(key)) return;
          seen.add(key);

          const selector = el.id ? `#${CSS.escape(el.id)}` : el.name ? `[name="${el.name}"]` : "";
          if (!selector) return;

          fields.push({
            key,
            label: label || name || key,
            selector,
            type: el.tagName.toLowerCase() === "textarea" ? "textarea" : type || "text",
            required: !!el.required || el.getAttribute("aria-required") === "true",
          });
        });

        // Намери submit бутон
        const submitCandidates = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:last-of-type',
        ];
        let submitSel = "";
        for (const s of submitCandidates) {
          const btn = document.querySelector(s);
          if (!btn) continue;
          const r = (btn as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const id = (btn as any).id;
            submitSel = id ? `#${CSS.escape(id)}` : s;
            break;
          }
        }

        return { fields, submit_selector: submitSel };
      });

      // Филтрирай само ако намерихме поне ime/email/phone (за да не вземем availability форма)
      const hasPersonalData = result.fields.some((f: any) => ["name", "email", "phone"].includes(f.key));
      if (!hasPersonalData) return { fields: [], submit_selector: "" };

      return result;
    } catch {
      return { fields: [], submit_selector: "" };
    }
  }

  /**
   * Попълва резервационна форма с данните на клиента
   */
  private async fillReservationForm(
    page: Page,
    form: { fields: Array<{ key: string; label: string; selector: string; type: string; required: boolean }> },
    data: Record<string, string>
  ): Promise<number> {
    const keyMap: Record<string, string[]> = {
      name:     ["name", "full_name", "client_name"],
      email:    ["email", "e_mail"],
      phone:    ["phone", "tel", "telephone"],
      message:  ["message", "note", "comment"],
      check_in: ["check_in", "mphb_check_in_date"],
      check_out: ["check_out", "mphb_check_out_date"],
    };

    let filled = 0;
    for (const field of form.fields) {
      const candidates = keyMap[field.key] || [field.key];
      let value = "";
      for (const k of candidates) {
        if (data[k]?.trim()) { value = data[k].trim(); break; }
      }
      if (!value) continue;

      try {
        const el = await page.$(field.selector);
        if (!el || !await el.isVisible().catch(() => false)) continue;
        await el.scrollIntoViewIfNeeded().catch(() => {});
        if (field.type === "textarea") {
          await (el as any).fill(value);
        } else {
          await page.fill(field.selector, value);
        }
        await page.keyboard.press("Tab").catch(() => {});
        filled++;
        console.log(`[FILL-RESERVATION] ${field.key}=${value.slice(0, 20)}`);
      } catch (e) {
        console.log(`[FILL-RESERVATION] failed ${field.selector}: ${e}`);
      }
    }
    return filled;
  }

  /**
   * Извлича contact email от страницата (footer, contact section и т.н.)
   */
  private async extractContactEmail(page: Page): Promise<string> {
    try {
      // Опитай от DB session structured_data
      const dbSessionId = page.url(); // fallback
      const emailFromPage = await page.evaluate(() => {
        const emailRe = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const body = document.body?.innerText || "";
        // Предпочитай emails в footer или contact секция
        const footer = document.querySelector("footer")?.innerText || "";
        const contact = document.querySelector("[class*='contact'], [id*='contact']")?.textContent || "";
        const priority = footer + " " + contact;
        const priorityMatch = priority.match(emailRe);
        if (priorityMatch) return priorityMatch[0];
        const allMatch = body.match(emailRe);
        if (allMatch) {
          // Пропусни noreply, spam и т.н.
          const clean = allMatch.filter(e => !e.includes("noreply") && !e.includes("example") && !e.includes("resend"));
          if (clean.length) return clean[0];
        }
        return "";
      });
      return emailFromPage;
    } catch {
      return "";
    }
  }



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

      // ── Ако kind=availability и няма schema → fallback към checkAvailability ──
      // Това се случва когато form_schemas е празна (сайтът не е бил crawl-нат)
      // но Gemini пак изпраща /fill-form с kind=availability
      if (kind === "availability" || kind === "booking_widget") {
        console.log(`[FILL-FORM][AVAIL-FALLBACK] No schema but kind=${kind} → routing to checkAvailability`);

        // Нормализирай data ключовете към booking_data формат
        const merged = mergeConfirmedData(data || {}, confirmed as any);
        const bookingData: Record<string, string> = {};

        // Приеми и двата формата: mphb_check_in_date и check_in
        const ci = String(merged.mphb_check_in_date  || merged.check_in  || merged.checkin  || merged["Настаняване"] || "");
        const co = String(merged.mphb_check_out_date || merged.check_out || merged.checkout || merged["Напускане"]   || "");
        const ad = String(merged.mphb_adults   || merged.adults   || merged["Възрастни"] || "");
        const ch = String(merged.mphb_children || merged.children || merged["Деца"]      || "");

        if (ci) bookingData.check_in  = ci;
        if (co) bookingData.check_out = co;
        if (ad) bookingData.adults    = ad;
        if (ch) bookingData.children  = ch;

        const availResult = await this.checkAvailability({
          site_id,
          session_id: session_id || session.sessionId || undefined,
          booking_data: Object.keys(bookingData).length > 0 ? bookingData : undefined,
        });

        // Преобразувай AvailabilityResult → fill-form response формат
        // Важно: observation трябва да съдържа реалните резултати за Gemini
        const obs: JsonObj = {
          url:           availResult.source_url || "",
          title:         "",
          widget_vendor: availResult.widget_vendor || "",
          // raw_snippet = реалният текст от страницата с резултати
          // Gemini ТРЯБВА да го прочете и да го преразкаже на клиента
          page_content:  availResult.raw_snippet || "",
        };

        if (availResult.rooms && availResult.rooms.length > 0) {
          obs.availability = {
            rooms:     availResult.rooms,
            submitted: true,
            url:       availResult.source_url || "",
          };
          // Изгради human-readable summary на стаите за Gemini
          const roomSummary = availResult.rooms.map((r: any) =>
            `• ${r.name || "Стая"}` +
            (r.price_per_night ? ` — ${r.price_per_night}/нощ` : "") +
            (r.total_price && r.total_price !== r.price_per_night ? ` (общо: ${r.total_price})` : "") +
            (r.availability === "available" ? " ✅ свободна" : r.availability === "unavailable" ? " ❌ заета" : "")
          ).join("\n");
          obs.rooms_summary = roomSummary;
          obs.rooms_count   = availResult.rooms.length;
        }

        if (availResult.needs_input) {
          obs.needs_input     = true;
          obs.required_fields = availResult.required_fields || [];
        }

        // message съдържа РЕАЛНИТЕ данни директно — Gemini чете message преди observation
        let msg: string;
        if (availResult.rooms && availResult.rooms.length > 0) {
          const roomLines = availResult.rooms.map((r: any) =>
            `• ${r.name || "Стая"}` +
            (r.price_per_night ? ` — ${r.price_per_night}/нощ` : "") +
            (r.total_price && r.total_price !== r.price_per_night ? ` (общо: ${r.total_price})` : "") +
            (r.availability === "available" ? " ✅" : r.availability === "unavailable" ? " ❌ заета" : "")
          ).join("\n");
          msg = `НАЛИЧНОСТ ПРОВЕРЕНА — намерени ${availResult.rooms.length} вид/а стаи:\n${roomLines}\n\nИзпрати тази информация на клиента на неговия език. НЕ казвай "запитването е изпратено".`;
        } else if (availResult.raw_snippet && availResult.raw_snippet.length > 50) {
          msg = `НАЛИЧНОСТ ПРОВЕРЕНА — резултат от сайта:\n${availResult.raw_snippet.slice(0, 800)}\n\nПреразкажи тази информация на клиента. НЕ казвай "запитването е изпратено".`;
        } else {
          msg = availResult.message || "Не намерих информация за наличност.";
        }

        return {
          success:     availResult.success,
          message:     msg,
          observation: obs,
        };
      }

      return { success: false, message: `Не намерих форма (schemas=${session.formSchemas.length})` };
    }

    console.log(`[FILL-FORM] kind=${schema.kind} form_id=${schema.id} fingerprint=${schema.fingerprint.slice(0, 12)}… fields=${schema.schema.fields?.length || 0}`);

    const merged = mergeConfirmedData(data || {}, confirmed as any);

    const mergedKeys = Object.keys(merged);
    const mergedPreview = mergedKeys.slice(0, 12).map(k => `${k}=${summarizeValue(k, (merged as any)[k])}`);
    console.log(`[FILL-FORM][PAYLOAD] keys=${mergedKeys.join(",")} preview=${mergedPreview.join(" | ")}`);

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

    // After submit — scrape availability results if navigated to search-results
    let availResult: JsonObj = {};
    if (autoSubmit && submitClicked) {
      try {
        await page.waitForURL("**/search-results/**", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1200);
        await this.dismissCookieBanner(page);
        const scraped = await this.scrapeAvailabilityResults(page);
        const rc = (scraped.rooms as any[])?.length || 0;
        console.log(`[AVAILABILITY] scraped ${rc} rooms from ${page.url().slice(0, 80)}`);
        if (rc === 0 && page.url().includes("search-results")) {
          scraped.snippet = await page.evaluate(() =>
            (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 2000)
          ).catch(() => "");
        }
        if (rc > 0 || page.url().includes("search-results")) availResult = scraped;
      } catch {}
    }

    const obs = await this.quickObserve(page);
    obs.submit = submitInfo;
    if (Object.keys(availResult).length > 0) obs.availability = availResult;

    return {
      ok: autoSubmit ? submitClicked : true,
      message: actions.length ? `Попълних: ${actions.join(", ")}` : "Не успях да попълня полета",
      observation: obs,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // AVAILABILITY + helpers
  // ═══════════════════════════════════════════════════════════

  private async dismissCookieBanner(page: Page): Promise<void> {
    for (const sel of [
      'button:has-text("Приемам")', 'button:has-text("Accept")',
      'button:has-text("OK")', 'button:has-text("Разбрах")',
      '.cc-accept', '#onetrust-accept-btn-handler',
      '[class*="cookie-accept"]', '[id*="consent"] button',
    ]) {
      try {
        const el = await page.$(sel);
        if (!el || !await el.isVisible().catch(() => false)) continue;
        await el.click({ timeout: 1000 });
        console.log(`[COOKIE] Dismissed: ${sel}`);
        return;
      } catch {}
    }
  }

  private async fillAvailability(
    page: Page,
    schema: FormSchemaRow,
    data: Record<string, unknown>,
    autoSubmit = true
  ): Promise<{ ok: boolean; message: string; observation?: JsonObj }> {
    const actions: string[] = [];
    const ci = String(data.mphb_check_in_date  || data.check_in  || data.checkin  || data["Настаняване"] || "").trim();
    const co = String(data.mphb_check_out_date || data.check_out || data.checkout || data["Напускане"]   || "").trim();
    const ad = String(data.mphb_adults   || data.adults   || data["Възрастни"] || "").trim();
    const ch = String(data.mphb_children || data.children || data["Деца"]      || "").trim();

    console.log(`[AVAILABILITY] ci="${ci}" co="${co}" adults=${ad} children=${ch}`);

    // Fill date inputs — flatpickr-aware via native setter + keyboard
    const fillDate = async (name: string, val: string): Promise<boolean> => {
      if (!val) return false;
      for (const sel of [`input[name="${name}"]`, `#${name}`]) {
        try {
          const el = await page.$(sel);
          if (!el || !await el.isVisible().catch(() => false)) continue;
          await page.evaluate(({ s, v }: { s: string; v: string }) => {
            const inp = document.querySelector(s) as HTMLInputElement | null;
            if (!inp) return;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (setter) setter.call(inp, v);
            inp.dispatchEvent(new Event("input",  { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
          }, { s: sel, v: val });
          await el.click().catch(() => {});
          await page.keyboard.press("Control+a");
          await page.keyboard.type(val);
          await page.keyboard.press("Tab");
          console.log(`[AVAILABILITY] filled ${name}=${val}`);
          return true;
        } catch {}
      }
      return false;
    };

    if (await fillDate("mphb_check_in_date",  ci)) actions.push(`Настаняване: ${ci}`);
    if (await fillDate("mphb_check_out_date", co)) actions.push(`Напускане: ${co}`);

    // Guest selects
    const fillSelect = async (sels: string[], val: string, label: string) => {
      for (const sel of sels) {
        try {
          const el = await page.$(sel);
          if (!el || !await el.isVisible().catch(() => false)) continue;
          await (el as any).selectOption({ value: val }).catch(async () => {
            await (el as any).selectOption({ label: val }).catch(() => {});
          });
          actions.push(`${label}: ${val}`);
          return;
        } catch {}
      }
    };
    if (ad) await fillSelect(['select[name="mphb_adults"]', 'select[name*="adult"]'], ad, "Възрастни");
    if (ch) await fillSelect(['select[name="mphb_children"]', 'select[name*="child"]'], ch, "Деца");

    if (autoSubmit) {
      for (const sel of ['button:has-text("Търсене")', 'button:has-text("Search")', 'button[type="submit"]', 'input[type="submit"]']) {
        try {
          const el = await page.$(sel);
          if (!el || !await el.isVisible().catch(() => false)) continue;
          await el.click({ timeout: 2000 });
          actions.push("Търсене");
          break;
        } catch {}
      }
      try {
        await page.waitForURL("**/search-results/**", { timeout: 8000 });
        console.log(`[AVAILABILITY] → ${page.url().slice(0, 80)}`);
      } catch {
        await page.waitForTimeout(2000);
      }
      await page.waitForTimeout(1200);
      await this.dismissCookieBanner(page);
    }

    const scraped = await this.scrapeBookingResults(page);
    const rc = scraped.rooms.length;
    console.log(`[AVAILABILITY] ${rc} rooms | snippet_len=${scraped.raw_snippet.length} | url=${page.url().slice(0, 80)}`);

    const roomsSummary = rc > 0 ? scraped.rooms.map(r =>
      `• ${r.name || "Стая"}` +
      (r.price_per_night ? ` — ${r.price_per_night}/нощ` : "") +
      (r.total_price && r.total_price !== r.price_per_night ? ` (общо: ${r.total_price})` : "") +
      (r.availability === "available" ? " ✅" : r.availability === "unavailable" ? " ❌" : "")
    ).join("\n") : "";

    const snippetForObs = scraped.raw_snippet || "";

    return {
      ok: true,
      message: rc > 0
        ? `НАЛИЧНОСТ ПРОВЕРЕНА — намерени ${rc} вид/а стаи:\n${roomsSummary}\n\nИзпрати тази информация на клиента. НЕ казвай "запитването е изпратено".`
        : snippetForObs
          ? `НАЛИЧНОСТ ПРОВЕРЕНА — резултат от сайта:\n${snippetForObs.slice(0, 800)}\n\nПреразкажи тази информация на клиента. НЕ казвай "запитването е изпратено".`
          : "Availability търсено — " + actions.join(" → "),
      observation: {
        availability: {
          url: page.url(),
          rooms: scraped.rooms,
          rooms_summary: roomsSummary,
          raw_snippet: snippetForObs,
          submitted: true,
          check_in: ci, check_out: co, adults: ad, children: ch,
        }
      },
    };
  }

  private async scrapeAvailabilityResults(page: Page): Promise<JsonObj> {
    try {
      return await page.evaluate(() => {
        const vis = (el: Element) => {
          const s = window.getComputedStyle(el as HTMLElement);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const rooms: any[] = [];
        const seen = new Set<Element>();
        for (const sel of [
          '[class*="room-type"]', '[class*="roomType"]', '.mphb-room-type',
          '[class*="rate-plan"]', '[class*="accommodation-type"]',
          '[data-room-type]', '[class*="mphb_room"]',
          '[class*="result"]', '[class*="room"]', '[class*="card"]',
        ]) {
          document.querySelectorAll(sel).forEach((el: Element) => {
            if (seen.has(el) || !vis(el)) return;
            const t = el.textContent || "";
            if (t.length < 5 || t.length > 3000) return;
            seen.add(el);
            const nameEl  = el.querySelector("h1,h2,h3,h4,[class*='title'],[class*='name']");
            const priceEl = el.querySelector("[class*='price'],[class*='cost'],[class*='rate'],[class*='amount']");
            const descEl  = el.querySelector("[class*='desc'],[class*='info']");
            const name  = (nameEl?.textContent  || "").trim();
            const price = (priceEl?.textContent || "").trim();
            const desc  = (descEl?.textContent  || "").trim().slice(0, 100);
            if (name || price) rooms.push({ name, price, ...(desc ? { desc } : {}) });
          });
          if (rooms.length >= 10) break;
        }
        return { url: window.location.href, title: document.title, rooms: rooms.slice(0, 10), submitted: true };
      });
    } catch { return { url: "", rooms: [], submitted: false }; }
  }

  // ═══════════════════════════════════════════════════════════

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

  app.post("/check-availability", async (req: Request, res: Response) => {
    const body = req.body as CheckAvailabilityRequest;
    if (!body?.site_id) {
      return res.json({ success: false, message: "Missing site_id" });
    }

    console.log(
      `[HTTP][/check-availability] site_id=${body.site_id} ` +
      `data_keys=${Object.keys(body.booking_data || {}).join(",")} ` +
      `crawl_only=${!!body.crawl_only}`
    );

    const r = await manager.checkAvailability(body);
    res.json(r);
  });


  app.post("/make-booking", async (req: Request, res: Response) => {
    const body = req.body;
    if (!body?.site_id) {
      return res.json({ success: false, message: "Missing site_id" });
    }

    console.log(
      `[HTTP][/make-booking] site_id=${body.site_id} room=${body.room_name || "any"} ` +
      `client_keys=${Object.keys(body.client_data || {}).join(",")}`
    );

    const r = await manager.makeBooking({
      site_id: String(body.site_id),
      session_id: body.session_id ? String(body.session_id) : undefined,
      room_name: body.room_name ? String(body.room_name) : undefined,
      booking_data: (body.booking_data || {}) as Record<string, string>,
      client_data: (body.client_data || {}) as Record<string, string>,
    });
    res.json(r);
  });

  app.post("/close-session", async (req: Request, res: Response) => {
    const { site_id } = req.body || {};
    if (site_id) await manager.closeSession(String(site_id));
    res.json({ success: true });
  });

  app.listen(PORT, () => {
    console.log(`🚀 NEO Worker v6.3.0-smart-booking listening on :${PORT}`);
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
