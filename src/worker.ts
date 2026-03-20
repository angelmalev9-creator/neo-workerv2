/**
 * NEO WORKER v12.1.0 — Universal Widget Engine + Smart URL + Quendoo + Verbatim
 *
 * v8.0.0 — НОВА АРХИТЕКТУРА:
 * ─────────────────────────────────────────────────────────────────
 * UNIVERSAL WIDGET ENGINE — работи с ВСЯКАКВИ booking уиджети:
 *   Clock PMS, Beds24, Cloudbeds, Mews, SabeeApp, LittleHotelier,
 *   HotelRunner, Bookero, Amelia, RMS, Sirvoy, и всеки нов вендор.
 *
 * DOM-FIRST подход (без Gemini Vision за form fields):
 *   • universalScanWidgetDOM()    — сканира DOM за required/optional полета
 *                                  без да праща screenshot на AI
 *   • universalFillKnownFields()  — попълва произволен widget семантично
 *                                  (по label, aria-label, placeholder)
 *                                  поддържа: Quasar selects, native selects,
 *                                  React/Vue inputs, custom datepickers
 *   • universalGetMissingRequired() — точно разпознава кои полета
 *                                    липсват СЛЕД навигация до checkout
 *
 * TIMING FIX (критичен):
 *   • inferCurrentBookingStepNeeds() се вика СЛЕД navigateBookingWidgetToCheckout
 *     не преди → коректен списък с required полета
 *
 * SCREENSHOT ОПТИМИЗАЦИЯ:
 *   • JPEG вместо PNG (10× по-малко)
 *   • само iframe когато е налично
 *   • Gemini Vision само за availability results (цени/стаи)
 *
 * BULGARIAN CLOCK PMS ПОЛЕТА:
 *   • guest_egn, guest_birthdate, guest_gender, guest_country,
 *     guest_doc_type, guest_doc_number — пълна поддръжка
 * ─────────────────────────────────────────────────────────────────
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
  // Bulgarian Clock PMS specific guest fields
  guest_egn?: string;           // ЕГН (Bulgarian personal ID)
  guest_birthdate?: string;     // Дата на раждане (DD.MM.YYYY or YYYY-MM-DD)
  guest_gender?: string;        // Пол (код): "M" | "F" | "male" | "female" | "мъж" | "жена"
  guest_country?: string;       // Държава (country name or ISO code)
  guest_doc_type?: string;      // Тип документ: "Лична карта" | "Паспорт" | "ID" | "Passport"
  guest_doc_number?: string;    // Номер на документ
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

// ── Material Design icon names that prefix field labels in Clock PMS / Quasar ──
const MATERIAL_ICON_PREFIXES = /^(edit|email|phone|public|event|person|lock|search|home|info|check|close|add|remove|delete|save|send|star|favorite|settings|help|warning|error|done|clear|arrow_drop_down|arrow_forward|arrow_back|chevron_right|chevron_left|expand_more|expand_less|shopping_cart|calendar_today|date_range|schedule|location_on|place|flag|notes|description|attach_file|image|photo|camera|visibility|visibility_off|account_circle|group|business|store|credit_card|payment|security|vpn_key|fingerprint|badge|card_travel|luggage|backpack|hotel|flight|directions_car|local_taxi|train|tram|directions_bus|map|navigation|explore|language|translate|text_fields|format_list|format_quote|link|grid_view|grid_on|view_list|view_module|sell|label|local_offer|discount|percent)\s*/i;

function cleanFieldLabel(raw: unknown): string {
  let s = String(raw || "").trim();
  // Remove leading Material icon name (e.g. "editСобствено име *" → "Собствено име *")
  s = s.replace(MATERIAL_ICON_PREFIXES, "");
  // Remove trailing Material icon names (e.g. "Държава *arrow_drop_down" → "Държава")
  s = s.replace(/\s*(arrow_drop_down|arrow_forward|arrow_back|expand_more|expand_less|chevron_right|chevron_left|shopping_cart|add|close|search|edit|check|info|help|warning|done|clear|visibility|visibility_off)\s*$/i, "");
  // Remove trailing asterisk with spaces
  s = s.replace(/\s*\*\s*$/, "").trim();
  // Remove leading asterisk
  s = s.replace(/^\*\s*/, "").trim();
  return s;
}

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

async function getClickableDebugLabel(loc: any): Promise<string> {
  try {
    const meta = await loc.evaluate((el: any) => {
      const text = String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
      const value = String(el?.value || "").replace(/\s+/g, " ").trim();
      const aria = String(el?.getAttribute?.("aria-label") || "").replace(/\s+/g, " ").trim();
      const title = String(el?.getAttribute?.("title") || "").replace(/\s+/g, " ").trim();
      const placeholder = String(el?.getAttribute?.("placeholder") || "").replace(/\s+/g, " ").trim();
      const cls = String(el?.className || "").replace(/\s+/g, " ").trim();
      const tag = String(el?.tagName || "").toLowerCase();
      const type = String(el?.type || "").toLowerCase();
      return { text, value, aria, title, placeholder, cls, tag, type };
    });

    const parts = [
      meta?.text ? `text="${meta.text}"` : "",
      meta?.value ? `value="${meta.value}"` : "",
      meta?.aria ? `aria="${meta.aria}"` : "",
      meta?.title ? `title="${meta.title}"` : "",
      meta?.placeholder ? `placeholder="${meta.placeholder}"` : "",
      meta?.tag ? `tag=${meta.tag}` : "",
      meta?.type ? `type=${meta.type}` : "",
      meta?.cls ? `class="${String(meta.cls).slice(0, 120)}"` : "",
    ].filter(Boolean);

    return parts.join(" ");
  } catch {
    return "";
  }
}

function roomTextMatches(containerTextRaw: string, wantedRoomRaw: string): boolean {
  const text = normLabel(containerTextRaw || "");
  const wanted = normLabel(wantedRoomRaw || "");
  if (!text || !wanted) return false;

  const exactPhrase = new RegExp(`(^|\\s)${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "i");
  if (exactPhrase.test(text)) return true;

  return false;
}

function isBadClickableLabel(raw: string): boolean {
  const s = normLabel(raw || "");
  if (!s) return true;

  // ✅ Booking action labels — ALWAYS allow these regardless of other checks
  if (/покажи\s*тарифит|show\s*rate|избери|book\s*now|резервирай|напред|next\s*step/i.test(s)) return false;

  // Exact match — pure icon-only labels
  const exactBad = new Set([
    "lens", "chevron left", "chevron right", "fullscreen", "expand more",
    "expand less", "close", "menu", "search", "favorite", "share", "prev",
    "next", "zoom", "галерия", "снимка", "картина", "person", "profile",
    "sign in", "shopping cart", "cart", "event", "grid view", "sell",
    "arrow back", "arrow drop down", "toggle details", "language",
    "български", "english", "profile or sign in",
    // ✅ Clock PMS availability calendar — NOT a booking button
    "календар на заетостта", "calendar на заетостта", "availability calendar",
  ]);
  if (exactBad.has(s)) return true;

  // Bad if label starts with "покажи повече" (expand details, not booking)
  if (/^покажи\s*повече/i.test(s)) return true;

  // Bad if label ENDS with an icon word (e.g. "покажи повече expand_more" → bad)
  const badSuffixes = ["expand more", "expand less", "chevron right", "chevron left", "arrow drop down"];
  if (badSuffixes.some(suf => s.endsWith(suf))) return true;

  // ✅ Bad if label STARTS with icon word AND has NO booking keywords
  // (e.g. "arrow downward ИЗБЕРИ" → good because contains "избери")
  if (/^(arrow|lens|chevron|fullscreen)/.test(s) && !/избери|book|резерв|покажи|select|continue|напред/i.test(s)) return true;

  return false;
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
        for (let i = 0; i < 6; i++) {
          if (!p) break;
          // ✅ Quasar q-field label: .q-field__label inside the q-field wrapper
          const qLabel = p.querySelector?.(".q-field__label") as HTMLElement | null;
          if (qLabel && qLabel.textContent) return qLabel.textContent.trim();
          // ✅ Quasar q-field__messages / q-field__hint also carry labels sometimes
          const qLabelEl = p.querySelector?.("[class*='q-field__label']") as HTMLElement | null;
          if (qLabelEl && qLabelEl.textContent) return qLabelEl.textContent.trim();
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
            // ✅ Quasar q-field--required class on ancestor
            let qRequired = false;
            let ancestor: Element | null = el;
            for (let d = 0; d < 5; d++) {
              if (!ancestor) break;
              const cls = (ancestor as any).className || "";
              if (typeof cls === "string" && cls.includes("q-field--required")) { qRequired = true; break; }
              ancestor = ancestor.parentElement;
            }
            return !!any.required || ariaReq || dataReq || star || qRequired;
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

          // Material Icons: snake_case single word (person, shopping_cart, arrow_drop_down...)
          const isMaterialIconText = (t: string) => /^[a-z]+(_[a-z]+)*$/.test(t) && !/ /.test(t) && t.length <= 30;
          // Filter out nav/submit and Material Icon glyphs
          const optBtns = siblings.filter((b) => {
            const t = ((b as any).textContent || "").trim();
            return t.length >= 1 && t.length <= 30 && !submitRe.test(t) && !isMaterialIconText(t);
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
    // ✅ PRIMARY: use the universal DOM scanner
    try {
      const result = await this.universalGetMissingRequired(page);
      return {
        missing_required: result.missing_required,
        current_step: result.current_step,
        payment_required: result.payment_required,
        can_continue: result.can_continue,
      };
    } catch {}

    // ── FALLBACK: original scanWizardStep-based approach ──────────
    try {
      const _scanBf = await this.findBookingFrameWithContent(page, 2000).catch(() => this.findBookingFrame(page));
      const _scanCtx = (_scanBf as any) as Page;
      const _useFrame = !!_scanBf;

      const unfilled = await this.countUnfilledVisibleFields(_useFrame ? _scanCtx : page);
      const scanned = await this.scanWizardStep(_useFrame ? _scanCtx : page).catch(() => ({
        fields: [],
        choices: [],
        choiceGroups: [],
      }));

      const bodyText = _useFrame
        ? (await _scanBf!.locator("body").innerText().catch(() => "")).toLowerCase()
        : (await page.locator("body").innerText().catch(() => "")).toLowerCase();
      const currentUrl = page.url().toLowerCase();

      const paymentRequired =
        /cvv|cvc|expiry|exp date|expiration|card number|credit card number|name on card|stripe/i.test(bodyText) ||
        /номер на карта|валидна до|име на карта|cvv|cvc/i.test(bodyText) ||
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

      const requiredFieldLabels = (scanned.fields || [])
        .filter((f: any) => !!f?.required)
        .map((f: any) => cleanFieldLabel(f.label || f.aria_label || f.placeholder || f.name || f.id || ""))
        .filter(Boolean);

      const requiredChoiceLabels = (scanned.choiceGroups || [])
        .filter((g: any) => !!g?.required)
        .map((g: any) =>
          String(g.label || g.name || "").trim() ||
          (Array.isArray(g.options) ? g.options.map((o: any) => o.text).filter(Boolean).join(" / ") : "")
        )
        .filter(Boolean);

      for (const lbl of requiredFieldLabels) push(lbl);
      for (const lbl of requiredChoiceLabels) push(lbl);


      console.log(
        `[RESERVATION][STEP-NEEDS] url=${page.url()} payment=${paymentRequired} current_step=${paymentRequired ? "payment" : "reserve"} missing=${out.join(" | ") || "none"}`
      );

      if (unfilled.labels?.length) {
        console.log(
          `[RESERVATION][STEP-NEEDS][UNFILLED_LABELS] ${unfilled.labels.slice(0, 30).join(" | ")}`
        );
      }

      console.log(
        `[RESERVATION][STEP-NEEDS][SCANNED_REQUIRED_FIELDS] ${requiredFieldLabels.join(" | ") || "none"}`
      );

      console.log(
        `[RESERVATION][STEP-NEEDS][SCANNED_REQUIRED_CHOICES] ${requiredChoiceLabels.join(" | ") || "none"}`
      );



      // Filter known nav/decoration noise from Clock PMS and main page
      // Also apply cleanFieldLabel to remove any remaining icon prefixes
      const _STEP_NOISE = /^(бонус|bonus.?code|избор:|емоция|сватби|бизнес|конферентни|почивка|релакс|person|shopping|arrow|grid.?view|sell|event\b|bg\b|en\b)/i;
      const cleanOut = out
        .map(s => cleanFieldLabel(s))
        .filter(s => s.length > 1)
        .filter(s => !_STEP_NOISE.test(s.trim()))
        .slice(0, 12);

      return {
        missing_required: cleanOut,
        current_step: paymentRequired ? "payment" : "reserve",
        payment_required: paymentRequired,
        can_continue: cleanOut.length === 0,
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

  private normalizeBookingEngine(raw: unknown): string {
    const v = String(raw || "").toLowerCase();
    if (!v) return "generic";
    if (/(clock|wbe|clock\s*pms|clock_pms)/i.test(v)) return "clock_pms";
    if (/beds24/i.test(v)) return "beds24";
    if (/cloudbeds/i.test(v)) return "cloudbeds";
    if (/mews/i.test(v)) return "mews";
    if (/(sabee|sabeeapp)/i.test(v)) return "sabeeapp";
    if (/littlehotelier/i.test(v)) return "littlehotelier";
    if (/hotelrunner/i.test(v)) return "hotelrunner";
    if (/bookero/i.test(v)) return "bookero";
    if (/amelia/i.test(v)) return "amelia";
    return "generic";
  }

  private async detectBookingEngine(page: Page, schema?: any): Promise<{ engine: string; iframeSrc: string; reason: string }> {
    const schemaAny: any = schema?.schema || {};
    const rawVendor = String(schemaAny?.booking_vendor || schemaAny?.vendor || schemaAny?.engine || "");
    const rawUiType = String(schemaAny?.ui_type || "");
    const rawIframeSrc = String(schemaAny?.iframe_src || schemaAny?.src || "");
    const schemaHints = `${rawVendor} ${rawUiType} ${rawIframeSrc}`.toLowerCase();
    const schemaEngine = this.normalizeBookingEngine(schemaHints);
    if (schemaEngine !== 'generic') {
      return { engine: schemaEngine, iframeSrc: rawIframeSrc, reason: `schema:${schemaHints.slice(0,80)}` };
    }

    const bookingFrame = await this.findBookingFrameWithContent(page, 1800).catch(() => this.findBookingFrame(page));
    const frameHay = bookingFrame ? `${String(bookingFrame.name?.() || '')} ${String(bookingFrame.url() || '')}`.toLowerCase() : '';
    const frameEngine = this.normalizeBookingEngine(frameHay);
    if (frameEngine !== 'generic') {
      return { engine: frameEngine, iframeSrc: String(bookingFrame?.url?.() || rawIframeSrc || ''), reason: `frame:${frameHay.slice(0,120)}` };
    }

    const bodyText = String(await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (/clock\s*pms|завършване|тарифи|престой/.test(bodyText) && /(?:стаи|резерв)/.test(bodyText)) {
      return { engine: 'clock_pms', iframeSrc: rawIframeSrc, reason: 'body:clock-signals' };
    }

    return { engine: 'generic', iframeSrc: rawIframeSrc, reason: 'fallback' };
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
      const schemaIframeSrc = String(schemaAny?.iframe_src || schemaAny?.src || "");
      const detected = await this.detectBookingEngine(page, schema);
      const engine = detected.engine;
      const iframeSrc = detected.iframeSrc || schemaIframeSrc;
      const vendor = engine !== 'generic' ? engine : String(schemaAny?.booking_vendor || schemaAny?.vendor || "unknown");

      const isIframeAvailability =
        engine !== 'generic' ||
        uiType.includes("iframe_booking_widget") ||
        !!iframeSrc ||
        String(vendor).toLowerCase().includes("quendoo");

      console.log(`[AVAIL][ENGINE] engine=${engine} vendor=${vendor} reason=${detected.reason} ui_type=${uiType} url=${schema.url}`);

      // ── 2. Engine-first iframe availability flow ───────────────
      if (isIframeAvailability) {
        // ✅ v11 FIX: Always ensure we are on the right page for Clock PMS
        // Old worker: always navigates to schema.url — reliable because it's always the correct page
        // New worker was skipping navigation, causing issues when on wrong sub-page
        const _currentUrl = page.url();
        const _schemaUrl = schema.url || "";
        const _hasFrameNow = !!this.findBookingFrame(page);
        
        let _shouldNavigate = false;
        if (!_hasFrameNow) {
          _shouldNavigate = true; // No frame at all → must navigate
        } else if (_schemaUrl) {
          // Frame present, but check if we are on the right page
          try {
            const _schemaOrigin = new URL(_schemaUrl).origin;
            const _curOrigin = new URL(_currentUrl).origin;
            if (_schemaOrigin === _curOrigin) {
              // Same site — only navigate if the schema URL looks like a specific page (not root)
              const _schemaPath = new URL(_schemaUrl).pathname;
              const _curPath = new URL(_currentUrl).pathname;
              if (_schemaPath !== "/" && _schemaPath !== _curPath && !_schemaPath.includes("%")) {
                _shouldNavigate = true; // Schema has specific page that differs from current
              }
            }
          } catch {}
        }

        if (_shouldNavigate) {
          await this.ensureOnSchemaUrl(page, _schemaUrl);
          await page.waitForTimeout(engine === 'clock_pms' ? 1800 : 1200);
          // If still no iframe, try site root
          if (!this.findBookingFrame(page) && _schemaUrl) {
            try {
              const _siteRoot = new URL(_schemaUrl).origin + "/";
              if (_siteRoot !== page.url()) {
                console.log(`[AVAIL] No iframe at schema URL → trying site root: ${_siteRoot}`);
                await page.goto(_siteRoot, { waitUntil: "domcontentloaded", timeout: 12000 });
                await page.waitForTimeout(1800);
              }
            } catch {}
          }
        } else {
          console.log(`[AVAIL] Using current page ${_currentUrl} (frame present, correct page)`);
          await page.waitForTimeout(engine === 'clock_pms' ? 800 : 500);
        }

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
            engine,
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
    // Strategy 1: Try iframe-only JPEG — if large enough (>40KB), it has actual room data
    // If iframe is small (loading spinner), fall back to fullPage to capture all visible content
    let iframeBuf: Buffer | null = null;
    try {
      const iframeSelectors = [
        'iframe[name="clock-pms-wbe-iframe"]',
        'iframe[src*="clock"]',
        'iframe[src*="wbe"]',
        'iframe[src*="booking"]',
        'iframe[src*="reserv"]',
        'iframe[src*="hotel"]',
        'iframe[src*="beds24"]',
        'iframe[src*="cloudbeds"]',
        'iframe[src*="mews"]',
        'iframe[src*="sabee"]',
      ];
      for (const sel of iframeSelectors) {
        const el = await page.$(sel).catch(() => null);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        const buf = await el.screenshot({ type: "jpeg", quality: 72 }).catch(() => null);
        if (buf && buf.length > 1000) {
          iframeBuf = buf;
          console.log(`[SCREENSHOT] iframe JPEG via "${sel}" size=${buf.length}`);
          // If iframe has substantial content (>40KB), use it — it shows availability results
          if (buf.length > 40000) {
            return Buffer.from(buf).toString("base64");
          }
          // Small iframe = likely loading spinner — keep it but also try fullPage
          break;
        }
      }
    } catch {}

    // Strategy 2: fullPage JPEG — captures everything visible (room cards on main page, etc.)
    // Used when iframe is small/loading OR no iframe found
    try {
      const fullBuf = await page.screenshot({ type: "jpeg", quality: 68, fullPage: true });
      if (fullBuf && fullBuf.length > 1000) {
        console.log(`[SCREENSHOT] fullPage JPEG size=${fullBuf.length} iframeSize=${iframeBuf?.length ?? 0}`);
        // If we have both: return the larger one (more content = more room data for Gemini Vision)
        if (iframeBuf && iframeBuf.length > fullBuf.length * 0.8) {
          console.log(`[SCREENSHOT] Using iframe (larger)`);
          return Buffer.from(iframeBuf).toString("base64");
        }
        return Buffer.from(fullBuf).toString("base64");
      }
    } catch {}

    // Strategy 3: If we have iframe buf, use it despite being small
    if (iframeBuf) {
      console.log(`[SCREENSHOT] Using iframe buf as last resort size=${iframeBuf.length}`);
      return Buffer.from(iframeBuf).toString("base64");
    }

    // Strategy 4: viewport JPEG (no fullPage)
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 65, fullPage: false });
      console.log(`[SCREENSHOT] viewport JPEG size=${buf.length}`);
      return Buffer.from(buf).toString("base64");
    } catch {}

    // Fallback: fullPage JPEG
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: true });
      console.log(`[SCREENSHOT] fullPage JPEG fallback size=${buf.length}`);
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

      // ✅ v11 FIX: Detect vendor FIRST so we can skip frameLocator for clock_pms/quendoo
      // clock_pms uses bookingFrame (Playwright Frame object), NOT frameLocator
      // quendoo uses its own calendar handler
      const _earlyNormalizedVendor = this.normalizeBookingEngine(vendor);
      const _isClockPms  = _earlyNormalizedVendor === 'clock_pms';
      const _isQuendoo   = _earlyNormalizedVendor === 'quendoo' || vendor.toLowerCase().includes('quendoo');

      // Locate the iframe via CSS frameLocator (needed for non-clock_pms generic fill)
      let frameLocator: any = null;
      if (!_isClockPms && !_isQuendoo) {
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
      } else {
        console.log(`[IFRAME] vendor=${_earlyNormalizedVendor} — skipping frameLocator, using direct Frame`);
      }
      if (!frameLocator && !_isClockPms && !_isQuendoo) {
        // Generic vendor — try site root before main-page fallback
        const _curUrl = page.url();
        try {
          const _siteRoot = new URL(_curUrl).origin + "/";
          if (_siteRoot !== _curUrl && !_curUrl.endsWith("/")) {
            console.log(`[IFRAME] Generic vendor — trying site root: ${_siteRoot}`);
            await page.goto(_siteRoot, { waitUntil: "domcontentloaded", timeout: 12000 });
            await page.waitForTimeout(1800);
            const iframeSelectors2 = [
              iframeSrc ? `iframe[src*="${iframeSrc.slice(0, 40)}"]` : "",
              "iframe",
            ].filter(Boolean) as string[];
            for (const sel of iframeSelectors2) {
              try {
                const el2 = await page.$(sel);
                if (!el2) continue;
                if (!(await el2.isVisible().catch(() => false))) continue;
                frameLocator = page.frameLocator(sel);
                console.log(`[IFRAME] Found iframe at site root via: ${sel}`);
                break;
              } catch {}
            }
          }
        } catch {}

        if (!frameLocator) {
          console.log("[IFRAME] Could not locate iframe — falling back to main page");
          await this.fillAvailabilityDates(
            page,
            {
              id: "", session_id: "", url: page.url(), domain: "",
              kind: "availability", fingerprint: "", schema: {}, dom_snapshot: null,
            } as FormSchemaRow,
            checkin, checkout, guests, rooms
          );
          const clicked = await this.clickAvailabilitySearch(page);
          await this.waitForAvailabilityResults(page);
          const screenshot_base64 = await this.takeAvailabilityScreenshot(page);
          return { ok: true, message: "iframe_fallback_main_page", screenshot_base64 };
        }
      }

      // ── Vendor-specific date selectors ────────────────────
      const vendorDateSelectors: Record<string, { checkin: string[]; checkout: string[]; guests: string[]; search: string[] }> = {
        clock_pms: {
          checkin: [
            'input[name="arrival"]', '#floatingArrival', 'input[placeholder*="Пристигане"]',
            'input[aria-label*="Пристигане"]', '[data-testid*="arrival"] input',
            '[class*="arrival"] input', '[class*="checkin"] input', 'input[type="date"]'
          ],
          checkout: [
            'input[name="departure"]', '#floatingDeparture', 'input[placeholder*="Заминаване"]',
            'input[aria-label*="Заминаване"]', '[data-testid*="departure"] input',
            '[class*="departure"] input', '[class*="checkout"] input', 'input[type="date"]'
          ],
          guests: [
            'select[name*="adult"]', 'select[name*="guest"]', '[class*="q-select"] input',
            '[class*="guest"] input', '[class*="adult"] input', '[aria-label*="Гости"]', '[aria-label*="Adults"]'
          ],
          search: [
            'button:has-text("Резервирай")', 'button:has-text("Провери и резервирай")',
            'button:has-text("Провери")', 'button:has-text("Търси")',
            'button:has-text("Search")', 'button[type="submit"]', 'input[type="submit"]'
          ],
        },
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

      const normalizedVendor = this.normalizeBookingEngine(vendor);
      const selMap = vendorDateSelectors[normalizedVendor] || vendorDateSelectors[vendor] || genericSelectors;

      let bookingFrame = await this.findBookingFrameWithContent(page, normalizedVendor === 'clock_pms' ? 12000 : 2200).catch(() => this.findBookingFrame(page));

      // Helper: try to fill an element inside the iframe
      const iframeFill = async (selectors: string[], value: string): Promise<boolean> => {
        for (const sel of selectors) {
          try {
            const loc = frameLocator.locator(sel).first();
            const count = await loc.count().catch(() => 0);
            if (count === 0) continue;
            const visible = await loc.isVisible().catch(() => false);
            if (!visible) continue;

            await loc.click({ timeout: 2000 }).catch(() => {});
            await loc.fill(value, { timeout: 2000 }).catch(() => {});
            await page.keyboard.press("Tab").catch(() => {});
            await page.waitForTimeout(200);

            const filled = await loc.inputValue().catch(() => "");
            if (filled && filled !== "") {
              console.log(`[IFRAME][FILL] ${sel} = ${filled}`);
              return true;
            }

            const filledDP = await this.fillCustomDatepickerInFrame(frameLocator, sel, value);
            if (filledDP) {
              console.log(`[IFRAME][DATEPICKER] ${sel} = ${value}`);
              return true;
            }
          } catch {}
        }
        return false;
      };

      // Clock PMS special rule:
      // availability must NOT use checkout navigation. We only set dates/guests,
      // click the real search button, and wait for room/tariff results.
      if (normalizedVendor === 'clock_pms') {
        const getFrameTextLen = async (ctx: any): Promise<number> => {
          try {
            return String(await ctx.locator('body').innerText().catch(() => '')).trim().length;
          } catch {
            return 0;
          }
        };

        let initialFrameLen = bookingFrame ? await getFrameTextLen(bookingFrame) : 0;
        console.log(`[IFRAME][CLOCK] initial frame len=${initialFrameLen}`);

        const pageFill = await this.fillAvailabilityDates(
          page,
          {
            id: '',
            session_id: '',
            url: page.url(),
            domain: '',
            kind: 'availability',
            fingerprint: '',
            schema: {
              fields: [],
              date_inputs: [
                { name: 'arrival', label: 'Пристигане', selector_candidates: selMap.checkin },
                { name: 'departure', label: 'Заминаване', selector_candidates: selMap.checkout },
              ],
              guest_fields: selMap.guests.map((s) => ({ name: 'guests', label: 'Гости', selector_candidates: [s] })),
            } as any,
            dom_snapshot: null,
          } as FormSchemaRow,
          checkin,
          checkout,
          guests,
          rooms,
        );

        let searchClicked = await this.clickAvailabilitySearch(page).catch(() => false);
        console.log(`[IFRAME][CLOCK] page-level fill=${JSON.stringify(pageFill)} searchClicked=${searchClicked}`);

        // ✅ v11 FIX: Also try filling dates INSIDE the Clock PMS iframe directly
        // Old worker did this via frameLocator + genericSelectors — more reliable for SPAs
        if (bookingFrame) {
          try {
            const _clockInnerSelectors = {
              checkin:  ['input[name="arrival"]', 'input[name*="checkin"]', 'input[name*="check_in"]', 'input[placeholder*="Пристигане"]', 'input[placeholder*="Check-in"]', 'input[type="date"]'],
              checkout: ['input[name="departure"]', 'input[name*="checkout"]', 'input[name*="check_out"]', 'input[placeholder*="Заминаване"]', 'input[placeholder*="Check-out"]', 'input[type="date"]'],
            };
            let _innerFilled = false;
            for (const sel of _clockInnerSelectors.checkin) {
              try {
                const loc = bookingFrame.locator(sel).first();
                if (await loc.count().catch(() => 0) === 0) continue;
                if (!(await loc.isVisible().catch(() => false))) continue;
                await loc.click({ clickCount: 3, timeout: 1500 }).catch(() => {});
                await loc.fill(checkin, { timeout: 1500 }).catch(() => {});
                await page.keyboard.press('Tab').catch(() => {});
                const v = await loc.inputValue().catch(() => '');
                if (v && v !== '') {
                  console.log(`[IFRAME][CLOCK][INNER] filled checkin ${sel}=${v}`);
                  _innerFilled = true;
                  break;
                }
              } catch {}
            }
            if (_innerFilled) {
              await page.waitForTimeout(300);
              for (const sel of _clockInnerSelectors.checkout) {
                try {
                  const loc = bookingFrame.locator(sel).first();
                  if (await loc.count().catch(() => 0) === 0) continue;
                  if (!(await loc.isVisible().catch(() => false))) continue;
                  await loc.click({ clickCount: 3, timeout: 1500 }).catch(() => {});
                  await loc.fill(checkout, { timeout: 1500 }).catch(() => {});
                  await page.keyboard.press('Tab').catch(() => {});
                  console.log(`[IFRAME][CLOCK][INNER] filled checkout ${sel}`);
                  break;
                } catch {}
              }
            }
          } catch (_ie) {}
        }

        if (!searchClicked && bookingFrame) {
          // Fallback: try search buttons inside the iframe
          const _iframeSearchSels = [
            'button:has-text("Резервирай")', 'button:has-text("Провери и резервирай")',
            'button:has-text("Search")', 'button:has-text("Провери")',
            'button[type="submit"]', 'input[type="submit"]',
          ];
          for (const sel of _iframeSearchSels) {
            try {
              const loc = bookingFrame.locator(sel).first();
              if (await loc.count().catch(() => 0) === 0) continue;
              if (!(await loc.isVisible().catch(() => false))) continue;
              await loc.click({ timeout: 3000, force: true });
              searchClicked = true;
              console.log(`[IFRAME][CLOCK] iframe search clicked ${sel}`);
              break;
            } catch {}
          }
        }

        if (!bookingFrame || initialFrameLen < 120) {
          console.log('[IFRAME][CLOCK] frame not ready yet — waiting longer after page trigger');
          await page.waitForTimeout(1200);
          bookingFrame = await this.findBookingFrameWithContent(page, 12000).catch(() => this.findBookingFrame(page));
          initialFrameLen = bookingFrame ? await getFrameTextLen(bookingFrame) : 0;
          console.log(`[IFRAME][CLOCK] frame len after extended wait=${initialFrameLen}`);
        }

        await this.waitForAvailabilityResults(page);
        const resultDetected = await (async () => {
          const deadline = Date.now() + 12000;
          while (Date.now() < deadline) {
            const freshFrame = await this.findBookingFrameWithContent(page, 1800).catch(() => this.findBookingFrame(page));
            const ctx = freshFrame || bookingFrame;
            if (!ctx) {
              await page.waitForTimeout(500);
              continue;
            }
            const txt = String(await ctx.locator('body').innerText().catch(() => '')).toLowerCase();
            const hasResults = /престой|стаи|тарифи|избери|покажи\s*тарифите|standard.?rate|нощувка\s*с\s*закуска|bb/i.test(txt);
            const strongLen = txt.trim().length;
            if (hasResults && strongLen > 360) {
              console.log(`[IFRAME][CLOCK] availability results detected len=${strongLen}`);
              return true;
            }
            await page.waitForTimeout(500);
          }
          return false;
        })();

        const screenshot_base64 = await this.takeAvailabilityScreenshot(page);
        return {
          ok: searchClicked && (resultDetected || initialFrameLen > 360),
          message: resultDetected ? 'clock_pms_availability_ready' : 'clock_pms_availability_not_confirmed',
          screenshot_base64,
        };
      }

      // ── Quendoo calendar widget — click-based date picker ──────
      if (_isQuendoo) {
        const _qFrame = await this.findBookingFrameWithContent(page, 5000).catch(() => null);
        const _qCtx: any = _qFrame || page;
        console.log(`[QUENDOO] Starting calendar interaction frame=${!!_qFrame}`);

        const _ciParts = checkin.split('-');
        const _coParts = checkout.split('-');
        const _ciDay   = parseInt(_ciParts[2] || '1');
        const _coDay   = parseInt(_coParts[2] || '1');
        const _ciMonth = parseInt(_ciParts[1] || '1');

        // ✅ v12 FIX: Click the DATE INPUT (or button) inside the container, not the container itself
        // Quendoo containers: div[class*="arrival"] > input or button
        const _ciTriggerSels = [
          // Input fields
          '[class*="arrival"] input, [class*="Arrival"] input',
          '[class*="checkin"] input, [class*="CheckIn"] input',
          'input[placeholder*="Пристигане"], input[placeholder*="Check-in"], input[placeholder*="Arrival"]',
          'input[placeholder*="From"], input[name*="checkin"], input[name*="arrival"]',
          // Clickable elements that open the calendar
          '[class*="arrival"] button, [class*="checkin"] button',
          '[class*="date-from"], [class*="dateFrom"], [class*="date_from"]',
          // Quendoo specific
          '.booking-calendar-checkin, .checkin-date, .arrival-date',
        ];

        let _ciOpened = false;
        for (const selGroup of _ciTriggerSels) {
          for (const sel of selGroup.split(',').map((s) => s.trim())) {
            try {
              const el = _qCtx.locator(sel).first();
              if (!(await el.isVisible({ timeout: 600 }).catch(() => false))) continue;
              await el.click({ timeout: 1500 });
              console.log(`[QUENDOO] Clicked checkin trigger: ${sel}`);
              _ciOpened = true;
              break;
            } catch {}
          }
          if (_ciOpened) break;
        }

        // Wait for calendar grid to appear
        if (_ciOpened) await page.waitForTimeout(1200);

        // Helper: click a calendar day by matching text content
        const clickCalDay = async (dayNum: number, label: string) => {
          const _calSels = [
            `.flatpickr-day:not(.disabled):not(.prevMonthDay):not(.nextMonthDay)`,
            `[class*="DayCell"]:not([class*="disabled"])`,
            `[class*="calendar-day"]:not([class*="disabled"])`,
            `[role="gridcell"]:not([aria-disabled="true"])`,
            `[class*="day"]:not([class*="disabled"]):not([class*="inactive"])`,
            `td:not([class*="disabled"])`,
          ];
          for (const sel of _calSels) {
            try {
              const allEls = await _qCtx.locator(sel).all().catch(() => []);
              for (const el of allEls) {
                const txt = (await el.textContent().catch(() => "")).trim();
                if (txt !== String(dayNum)) continue;
                if (!(await el.isVisible().catch(() => false))) continue;
                const cls = await el.getAttribute('class').catch(() => '') || '';
                if (/disabled|inactive|past|prev-month|next-month/i.test(cls)) continue;
                await el.click({ timeout: 1500 });
                console.log(`[QUENDOO] Clicked ${label} day ${dayNum}`);
                return true;
              }
            } catch {}
          }
          // Fallback: data-date attribute
          try {
            const _byDate = _qCtx.locator(`[data-date*="${checkin.slice(0,7)}-${String(dayNum).padStart(2,'0')}"], [data-date*="${String(dayNum).padStart(2,'0')}"]`).first();
            if (await _byDate.isVisible({ timeout: 400 }).catch(() => false)) {
              await _byDate.click({ timeout: 1500 });
              console.log(`[QUENDOO] Clicked ${label} day ${dayNum} via data-date`);
              return true;
            }
          } catch {}
          return false;
        };

        let _calSuccess = false;
        if (_ciOpened) {
          _calSuccess = await clickCalDay(_ciDay, 'checkin');
          if (_calSuccess) {
            await page.waitForTimeout(700);
            // After checkin clicked, checkout calendar may open automatically
            // or we need to click the checkout trigger
            let _coClicked = await clickCalDay(_coDay, 'checkout');
            if (!_coClicked) {
              // Try opening checkout picker explicitly
              const _coTriggerSels = [
                '[class*="departure"] input, [class*="Departure"] input',
                '[class*="checkout"] input, [class*="CheckOut"] input',
                'input[placeholder*="Заминаване"], input[placeholder*="Check-out"], input[placeholder*="Departure"]',
              ];
              for (const selGroup of _coTriggerSels) {
                for (const sel of selGroup.split(',').map((s) => s.trim())) {
                  try {
                    const el = _qCtx.locator(sel).first();
                    if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;
                    await el.click({ timeout: 1200 });
                    await page.waitForTimeout(700);
                    _coClicked = await clickCalDay(_coDay, 'checkout-after-trigger');
                    if (_coClicked) break;
                  } catch {}
                }
                if (_coClicked) break;
              }
            }
          }
        }

        // Set guests
        try {
          const _guestSels = [
            'input[placeholder*="Гости"], input[placeholder*="Adults"], input[placeholder*="Guests"]',
            '[class*="guests"] input, [class*="adult"] input',
            'select[class*="guests"], select[class*="adult"]',
          ];
          for (const sg of _guestSels) {
            for (const sel of sg.split(',').map((s) => s.trim())) {
              try {
                const el = _qCtx.locator(sel).first();
                if (!(await el.isVisible({ timeout: 400 }).catch(() => false))) continue;
                const tag = await el.evaluate((e: any) => e.tagName?.toLowerCase()).catch(() => '');
                if (tag === 'select') await el.selectOption(guests).catch(() => {});
                else await el.fill(guests).catch(() => {});
                break;
              } catch {}
            }
          }
        } catch {}

        // Click search/reserve
        const _qSearchSels = [
          'button:has-text("РЕЗЕРВИРАЙ")', 'button:has-text("Резервирай")',
          'button:has-text("Reserve")', 'button:has-text("Book")',
          'button:has-text("Search")', 'button[type="submit"]',
        ];
        let _qSearchClicked = false;
        for (const sel of _qSearchSels) {
          try {
            const btn = _qCtx.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
              await btn.click({ timeout: 2000 });
              console.log(`[QUENDOO] Clicked search: ${sel}`);
              _qSearchClicked = true;
              break;
            }
          } catch {}
        }

        await page.waitForTimeout(2500);
        await this.waitForAvailabilityResults(page);
        const _qScreenshot = await this.takeAvailabilityScreenshot(page);
        const _qFrameAfter = await this.findBookingFrameWithContent(page, 3000).catch(() => null);
        const _qTxt = _qFrameAfter ? (await _qFrameAfter.locator('body').innerText().catch(() => '')).slice(0, 200) : '';
        const _qHasRooms = _qTxt.length > 100;
        console.log(`[QUENDOO] Result: calSuccess=${_calSuccess} searchClicked=${_qSearchClicked} hasRooms=${_qHasRooms} len=${_qTxt.length}`);

        return {
          ok: _qSearchClicked || _calSuccess,
          message: _qHasRooms ? 'quendoo_availability_ready' : 'quendoo_availability_attempted',
          screenshot_base64: _qScreenshot,
        };
      }

      const checkinOk = await iframeFill(selMap.checkin, checkin);
      await page.waitForTimeout(300);
      const checkoutOk = await iframeFill(selMap.checkout, checkout);
      await page.waitForTimeout(300);

      try {
        for (const sel of selMap.guests) {
          const loc = frameLocator.locator(sel).first();
          const count = await loc.count().catch(() => 0);
          if (count === 0) continue;
          const visible = await loc.isVisible().catch(() => false);
          if (!visible) continue;
          const tag = await loc.evaluate((el: any) => el.tagName?.toLowerCase()).catch(() => '');
          if (tag === 'select') await loc.selectOption(guests).catch(() => {});
          else {
            await loc.click({ timeout: 1200 }).catch(() => {});
            await loc.fill(guests).catch(() => {});
          }
          await page.waitForTimeout(250);
          break;
        }
      } catch {}

      let searchClicked = false;
      for (const sel of selMap.search) {
        try {
          const loc = frameLocator.locator(sel).first();
          const count = await loc.count().catch(() => 0);
          if (count === 0) continue;
          const visible = await loc.isVisible().catch(() => false);
          if (!visible) continue;
          await loc.click({ timeout: 3000, force: true });
          searchClicked = true;
          console.log(`[IFRAME][SEARCH] clicked ${sel}`);
          break;
        } catch {}
      }

      await this.waitForAvailabilityResults(page);
      const screenshot_base64 = await this.takeAvailabilityScreenshot(page);

      return {
        ok: searchClicked,
        message: searchClicked ? 'iframe_availability_ready' : 'iframe_availability_partial',
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

  // ═══════════════════════════════════════════════════════════════════
  // UNIVERSAL WIDGET ENGINE v1.0
  // Works with ANY booking widget: Clock PMS, Beds24, Cloudbeds, Mews,
  // SabeeApp, LittleHotelier, HotelRunner, Bookero, Amelia, RMS, etc.
  // DOM-first — no hardcoded vendor selectors, no Gemini Vision for fields.
  // ═══════════════════════════════════════════════════════════════════

  /**
   * universalScanWidgetDOM — scan ANY widget context for visible form fields.
   * Returns semantically labeled required and optional fields.
   * Works in iframes, shadow DOM, Quasar, React, Vue, Bootstrap, Tailwind.
   */
  private async universalScanWidgetDOM(ctx: any): Promise<{
    required: Array<{ label: string; type: string; selector: string; current_value: string }>;
    optional: Array<{ label: string; type: string; selector: string; current_value: string }>;
    dropdowns: Array<{ label: string; selector: string; options: string[]; current_value: string; required: boolean }>;
    checkboxes: Array<{ label: string; selector: string; checked: boolean; required: boolean }>;
    step_title: string;
    is_checkout_step: boolean;
    is_payment_step: boolean;
  }> {
    try {
      return await ctx.evaluate(() => {
        // ── helpers ──────────────────────────────────────────────
        const isVisible = (el: Element): boolean => {
          if (!el) return false;
          const s = window.getComputedStyle(el as any);
          if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) < 0.05) return false;
          const r = (el as any).getBoundingClientRect?.();
          return !!r && r.width > 0 && r.height > 0;
        };

        const getLabel = (el: Element): string => {
          const any = el as any;
          // 1. Quasar q-field__label (covers q-input, q-select, q-date)
          let p: Element | null = el;
          for (let i = 0; i < 7; i++) {
            if (!p) break;
            const qLbl = p.querySelector?.("[class*='q-field__label'], [class*='q-floating-label']") as HTMLElement | null;
            if (qLbl?.textContent?.trim()) return qLbl.textContent.trim();
            p = p.parentElement;
          }
          // 2. <label for="id">
          const id = any.id ? String(any.id) : "";
          if (id) {
            const lbl = document.querySelector(`label[for="${id}"]`) as HTMLElement | null;
            if (lbl?.textContent?.trim()) return lbl.textContent.trim();
          }
          // 3. aria-label
          const aria = any.getAttribute?.("aria-label") || "";
          if (aria.trim()) return aria.trim();
          // 4. aria-labelledby
          const lblby = any.getAttribute?.("aria-labelledby") || "";
          if (lblby) {
            const t = lblby.split(/\s+/).map((i: string) => document.getElementById(i)?.textContent?.trim() || "").filter(Boolean).join(" ");
            if (t) return t;
          }
          // 5. placeholder
          if (any.placeholder?.trim()) return any.placeholder.trim();
          // 6. Ancestor label
          let anc: Element | null = el;
          for (let i = 0; i < 5; i++) {
            if (!anc) break;
            const lbl = anc.querySelector?.("label") as HTMLElement | null;
            if (lbl?.textContent?.trim()) return lbl.textContent.trim();
            anc = anc.parentElement;
          }
          // 7. Previous sibling text (common in custom widgets)
          const prev = (el as any).parentElement?.previousElementSibling as HTMLElement | null;
          if (prev?.textContent?.trim() && prev.textContent.trim().length < 60) return prev.textContent.trim();
          return "";
        };

        const isRequired = (el: Element, label: string): boolean => {
          const any = el as any;
          if (any.required) return true;
          if ((any.getAttribute?.("aria-required") || "").toLowerCase() === "true") return true;
          if ((any.getAttribute?.("data-required") || "").toLowerCase() === "true") return true;
          if (label.includes("*")) return true;
          // Quasar q-field--required class on ancestor
          let anc: Element | null = el;
          for (let i = 0; i < 5; i++) {
            if (!anc) break;
            const cls = String((anc as any).className || "");
            if (cls.includes("q-field--required") || cls.includes("required")) return true;
            anc = anc.parentElement;
          }
          return false;
        };

        const getSelector = (el: Element): string => {
          const any = el as any;
          if (any.id) return `#${CSS.escape ? CSS.escape(any.id) : any.id}`;
          if (any.name) return `${el.tagName.toLowerCase()}[name="${any.name}"]`;
          if (any.getAttribute?.("aria-label")) return `${el.tagName.toLowerCase()}[aria-label="${any.getAttribute("aria-label")}"]`;
          if (any.placeholder) return `${el.tagName.toLowerCase()}[placeholder="${any.placeholder}"]`;
          // nth-of-type path
          const parts: string[] = [];
          let cur: Element | null = el;
          for (let d = 0; d < 6 && cur; d++) {
            const tag = cur.tagName.toLowerCase();
            const par: Element | null = cur.parentElement;
            if (!par) break;
            const siblings = Array.from(par.children as HTMLCollectionOf<Element>).filter((c: Element) => c.tagName === cur!.tagName);
            parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(cur) + 1})`);
            cur = par;
            if (tag === "form" || tag === "main" || tag === "body") break;
          }
          return parts.join(" > ") || el.tagName.toLowerCase();
        };

        const cleanLabel = (s: string): string =>
          s.replace(/^(edit|email|phone|person|event|lock|search|info|check|done|warning|error|public|badge|fingerprint|date_range|calendar_today|schedule)\s*/i, "")
           .replace(/\s*(arrow_drop_down|expand_more|expand_less|chevron_right|chevron_left)\s*$/i, "")
           .replace(/\s*\*\s*$/, "").trim();

        // ── scan ─────────────────────────────────────────────────
        const body = document.body;
        const bodyText = (body?.innerText || "").toLowerCase();

        const is_payment_step = /cvv|cvc|expir|card\s*number|credit\s*card|stripe|номер\s*на\s*карта|валидна\s*до/i.test(bodyText);
        const is_checkout_step = !is_payment_step && (
          /данни\s*за\s*контакт|guest\s*details|contact\s*details|your\s*details/i.test(bodyText) ||
          /собствено\s*им|first\s*name/i.test(bodyText)
        );

        // Detect step title from heading or wizard step indicator
        let step_title = "";
        const headings = document.querySelectorAll("h1,h2,h3,[class*='step-title'],[class*='step__title'],[class*='wizard__title']");
        for (const h of Array.from(headings)) {
          if (!isVisible(h)) continue;
          const t = (h.textContent || "").trim();
          if (t.length > 2 && t.length < 80) { step_title = t; break; }
        }

        const required: Array<{ label: string; type: string; selector: string; current_value: string }> = [];
        const optional: Array<{ label: string; type: string; selector: string; current_value: string }> = [];
        const dropdowns: Array<{ label: string; selector: string; options: string[]; current_value: string; required: boolean }> = [];
        const checkboxes: Array<{ label: string; selector: string; checked: boolean; required: boolean }> = [];

        const seenSels = new Set<string>();

        // ── text/email/tel/date inputs + textareas ────────────────
        const inputs = Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=checkbox]):not([type=radio]), textarea"));
        for (const el of inputs) {
          if (!isVisible(el)) continue;
          if ((el as any).disabled) continue;
          if ((el as any).getAttribute?.("aria-hidden") === "true") continue;
          const rawLabel = getLabel(el);
          const label = cleanLabel(rawLabel);
          // Skip navigation-noise labels
          if (/^(бонус|bonus|прод|next|back|назад|напред|close|затвор|cancel|отказ|search|търс|bg\b|en\b)/i.test(label)) continue;
          if (!label && !(el as any).placeholder) continue;
          const type = ((el as any).type || el.tagName.toLowerCase()).toLowerCase();
          const sel = getSelector(el);
          if (seenSels.has(sel)) continue;
          seenSels.add(sel);
          const current_value = String((el as any).value || "").trim();
          const req = isRequired(el, rawLabel);
          const entry = { label: label || cleanLabel((el as any).placeholder || ""), type, selector: sel, current_value };
          if (req) required.push(entry);
          else optional.push(entry);
        }

        // ── native <select> ───────────────────────────────────────
        const selects = Array.from(document.querySelectorAll("select"));
        for (const el of selects) {
          if (!isVisible(el)) continue;
          if ((el as any).disabled) continue;
          const rawLabel = getLabel(el);
          const label = cleanLabel(rawLabel);
          const sel = getSelector(el);
          if (seenSels.has(sel)) continue;
          seenSels.add(sel);
          const opts = Array.from((el as HTMLSelectElement).options).map((o: any) => (o.label || o.text || "").trim()).filter(Boolean);
          const current_value = (el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex]?.label?.trim() || "";
          dropdowns.push({ label, selector: sel, options: opts.slice(0, 30), current_value, required: isRequired(el, rawLabel) });
        }

        // ── Quasar q-select / styled dropdowns ───────────────────
        // Detect by: has q-field__label AND has q-select or role=listbox ancestor
        const qSelects = Array.from(document.querySelectorAll('[class*="q-select"], [class*="q-field"][class*="select"]'));
        for (const qSel of qSelects) {
          if (!isVisible(qSel)) continue;
          const rawLabel = getLabel(qSel.querySelector("[class*='q-field__native'], input") || qSel);
          const label = cleanLabel(rawLabel || (qSel.querySelector("[class*='q-field__label']") as HTMLElement | null)?.textContent?.trim() || "");
          if (!label) continue;
          const nativeInput = qSel.querySelector("input") as HTMLInputElement | null;
          const sel = nativeInput ? getSelector(nativeInput) : getSelector(qSel);
          if (seenSels.has(sel)) continue;
          seenSels.add(sel);
          const current_value = (nativeInput?.value || (qSel as any).innerText || "").trim();
          dropdowns.push({ label, selector: sel, options: [], current_value, required: isRequired(qSel, rawLabel) });
        }

        // ── checkboxes ────────────────────────────────────────────
        const cbs = Array.from(document.querySelectorAll("input[type=checkbox]"));
        for (const cb of cbs) {
          if (!isVisible(cb) && !(cb as any).closest?.("[class*='terms'], [class*='agree'], [class*='policy']")) continue;
          const rawLabel = getLabel(cb);
          const label = cleanLabel(rawLabel);
          const sel = getSelector(cb);
          if (seenSels.has(sel)) continue;
          seenSels.add(sel);
          checkboxes.push({ label, selector: sel, checked: !!(cb as any).checked, required: isRequired(cb, rawLabel) });
        }

        return { required, optional, dropdowns, checkboxes, step_title, is_checkout_step, is_payment_step };
      });
    } catch (e) {
      console.log(`[UNIVERSAL_SCAN] Error: ${e instanceof Error ? e.message : String(e)}`);
      return { required: [], optional: [], dropdowns: [], checkboxes: [], step_title: "", is_checkout_step: false, is_payment_step: false };
    }
  }

  /**
   * universalFillKnownFields — fill ANY widget field by semantic label matching.
   * Handles: standard inputs, Quasar selects, native selects, date fields, checkboxes.
   * Returns list of filled field labels.
   */
  private async universalFillKnownFields(
    ctx: any,
    page: Page,
    guestData: {
      first_name?: string; last_name?: string; full_name?: string;
      email?: string; phone?: string; message?: string;
      egn?: string; birthdate?: string; gender?: string;
      country?: string; doc_type?: string; doc_number?: string;
    }
  ): Promise<string[]> {
    const filled: string[] = [];

    // Build semantic mapping: label keyword → value
    const NAME_PARTS = (guestData.full_name || "").trim().split(/\s+/);
    const FIRST = guestData.first_name || NAME_PARTS[0] || "";
    const LAST  = guestData.last_name  || NAME_PARTS.slice(1).join(" ") || NAME_PARTS[0] || "";

    const FIELD_MAP: Array<{ patterns: RegExp; value: string; is_select?: boolean }> = [
      { patterns: /собствено\s*им|first\s*name|given\s*name|ime\b/i,    value: FIRST },
      { patterns: /фамил|last\s*name|family\s*name|surname/i,           value: LAST  },
      { patterns: /три\s*им|full\s*name|пълно\s*им/i,                   value: guestData.full_name || `${FIRST} ${LAST}`.trim() },
      { patterns: /e.?mail|имейл|поща/i,                                 value: guestData.email || "" },
      { patterns: /телефон|phone|tel\b|gsm|mobile|мобил/i,              value: guestData.phone || "" },
      { patterns: /егн|egn|лична\s*карта.*номер|personal\s*id/i,        value: guestData.egn || "" },
      { patterns: /дата.*ражд|birth.*date|date.*birth/i,                 value: guestData.birthdate || "" },
      { patterns: /пол\b|sex\b|gender/i,                                 value: guestData.gender || "", is_select: true },
      { patterns: /държав|country/i,                                     value: guestData.country || "", is_select: true },
      { patterns: /тип.*документ|document.*type|doc.*type/i,            value: guestData.doc_type || "", is_select: true },
      { patterns: /номер.*документ|document.*number|passport.*number/i, value: guestData.doc_number || "" },
      { patterns: /забел|бележк|note|message|коментар|comment/i,        value: guestData.message || "" },
    ];

    // Normalize gender value for common widget options
    const normalizeGender = (g: string): string => {
      const gl = g.toLowerCase().trim();
      if (/^(м|m|male|мъж|мъжки|man)$/.test(gl)) return "М";
      if (/^(ж|f|female|жена|женски|woman)$/.test(gl)) return "Ж";
      return g;
    };

    // ── Fill a Quasar or styled dropdown by clicking and picking option ──
    const fillStyledDropdown = async (ctxEl: any, selector: string, value: string, labelHint: string): Promise<boolean> => {
      if (!value) return false;
      try {
        // Find the q-field wrapper that contains this input
        const qWrapper = await ctxEl.locator(selector).first().evaluate((el: any) => {
          let p: Element | null = el;
          for (let i = 0; i < 6; i++) {
            if (!p) break;
            const cls = String((p as any).className || "");
            if (cls.includes("q-field") || cls.includes("q-select")) {
              return `[class*="q-field"]:has(${el.id ? "#" + el.id : el.tagName.toLowerCase()})`;
            }
            p = p.parentElement;
          }
          return null;
        }).catch(() => null);

        // Click the field or its input
        const clickTarget = ctxEl.locator(selector).first();
        if (await clickTarget.isVisible().catch(() => false)) {
          await clickTarget.click({ timeout: 1500 }).catch(() => {});
        } else if (qWrapper) {
          await ctxEl.locator(qWrapper).first().click({ timeout: 1500 }).catch(() => {});
        }
        await page.waitForTimeout(500);

        // Look for dropdown options on main page or in iframe
        const normVal = value.toLowerCase().trim();
        // Search contexts: main page DOM first (Quasar teleports menus), then iframe
        const searchCtxs = [page, ctxEl];
        for (const sc of searchCtxs) {
          const optSels = [
            `[role="option"]:has-text("${value}")`,
            `.q-item:has-text("${value}")`,
            `li[class*="option"]:has-text("${value}")`,
            `li:has-text("${value}")`,
          ];
          for (const os of optSels) {
            const opt = sc.locator(os).first();
            if (await opt.isVisible().catch(() => false)) {
              await opt.click({ timeout: 1500 }).catch(() => {});
              console.log(`[UNIVERSAL_FILL][DROPDOWN] "${labelHint}" = "${value}"`);
              await page.waitForTimeout(300);
              return true;
            }
          }
          // Partial / normalized match
          const allOpts = await sc.locator('[role="option"], .q-item').all().catch(() => []);
          for (const o of allOpts) {
            const t = (await o.textContent().catch(() => "")).trim().toLowerCase();
            if (!t) continue;
            if (t.includes(normVal) || normVal.includes(t) || t === normVal) {
              await o.click({ timeout: 1500 }).catch(() => {});
              console.log(`[UNIVERSAL_FILL][DROPDOWN][PARTIAL] "${labelHint}" = "${t}" (wanted "${value}")`);
              await page.waitForTimeout(300);
              return true;
            }
          }
        }
        // Close dropdown if nothing matched
        await page.keyboard.press("Escape").catch(() => {});
        return false;
      } catch { return false; }
    };

    // ── Fill a standard text/email/tel input ──
    const fillTextInput = async (ctxEl: any, selector: string, value: string, labelHint: string): Promise<boolean> => {
      if (!value) return false;
      try {
        const loc = ctxEl.locator(selector).first();
        if (await loc.count().catch(() => 0) === 0) return false;
        if (!(await loc.isVisible().catch(() => false))) return false;
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ clickCount: 3, timeout: 1500 }).catch(() => {});
        await loc.fill(value, { timeout: 1500 }).catch(() => {});
        // Trigger React/Vue reactivity
        await ctxEl.evaluate(({ sel, val }: { sel: string; val: string }) => {
          const el = document.querySelector(sel) as HTMLInputElement | null;
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(el, val);
          el.dispatchEvent(new Event("input",  { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
        }, { sel: selector, val: value }).catch(() => {});
        await page.waitForTimeout(80);
        console.log(`[UNIVERSAL_FILL][TEXT] "${labelHint}" = "${value.slice(0, 30)}"`);
        return true;
      } catch { return false; }
    };

    // ── Scan and fill ──
    const scan = await this.universalScanWidgetDOM(ctx);

    // Fill text/date/email/tel inputs
    for (const field of [...scan.required, ...scan.optional]) {
      for (const mapping of FIELD_MAP) {
        if (mapping.is_select) continue; // handled separately
        if (!mapping.patterns.test(field.label)) continue;
        if (!mapping.value) continue;
        if (field.current_value) continue; // already filled
        const ok = await fillTextInput(ctx, field.selector, mapping.value, field.label);
        if (ok) { filled.push(field.label); break; }
      }
    }

    // Fill dropdowns (native + Quasar)
    for (const dd of scan.dropdowns) {
      for (const mapping of FIELD_MAP) {
        if (!mapping.patterns.test(dd.label)) continue;
        if (!mapping.value) continue;
        if (dd.current_value && dd.current_value !== "-") continue; // already selected
        const val = /пол|gender|sex/i.test(dd.label) ? normalizeGender(mapping.value) : mapping.value;
        // Try native select first
        try {
          const natSel = ctx.locator(`select`).filter({ has: ctx.locator(`option`) }).first();
          const natCount = await ctx.locator(`select[name]`).count().catch(() => 0);
          if (natCount > 0) {
            const selOk = await ctx.locator(`select`).evaluateAll(
              (selects: HTMLSelectElement[], { label, val }: { label: string; val: string }) => {
                for (const s of selects) {
                  if (!s.offsetParent) continue;
                  // Find closest label text
                  const lbl = s.previousElementSibling?.textContent?.trim() || s.getAttribute("aria-label") || "";
                  if (!label || lbl.toLowerCase().includes(label.toLowerCase().replace(/\*/g, "").trim())) {
                    for (const o of Array.from(s.options)) {
                      if (o.label.toLowerCase().includes(val.toLowerCase()) || val.toLowerCase().includes(o.label.toLowerCase())) {
                        s.value = o.value;
                        s.dispatchEvent(new Event("change", { bubbles: true }));
                        return true;
                      }
                    }
                  }
                }
                return false;
              },
              { label: dd.label, val }
            ).catch(() => false);
            if (selOk) { filled.push(dd.label); continue; }
          }
        } catch {}
        // Styled/Quasar dropdown
        const ok = await fillStyledDropdown(ctx, dd.selector, val, dd.label);
        if (ok) { filled.push(dd.label); break; }
      }
    }

    // Accept unchecked required checkboxes (terms/policy)
    for (const cb of scan.checkboxes) {
      if (!cb.checked && /умови|terms|policy|политик|съглас|agree/i.test(cb.label || "")) {
        try {
          await ctx.locator(cb.selector).first().check({ timeout: 1500, force: true }).catch(() => {});
          console.log(`[UNIVERSAL_FILL][CHECKBOX] Checked: "${cb.label}"`);
          filled.push(cb.label || "terms");
        } catch {}
      }
    }

    if (filled.length > 0) {
      console.log(`[UNIVERSAL_FILL] Filled ${filled.length} fields: ${filled.join(" | ")}`);
    } else {
      console.log(`[UNIVERSAL_FILL] No fields matched — scan found req=${scan.required.length} opt=${scan.optional.length} dd=${scan.dropdowns.length}`);
    }
    return filled;
  }

  /**
   * universalGetMissingRequired — returns human-readable list of unfilled required fields
   * from ANY widget, using DOM scan. Replaces inferCurrentBookingStepNeeds for the
   * missing_required array returned to NEO.
   */
  private async universalGetMissingRequired(page: Page): Promise<{
    missing_required: string[];
    current_step: string;
    payment_required: boolean;
    can_continue: boolean;
    is_checkout_step: boolean;
  }> {
    try {
      const bf = await this.findBookingFrameWithContent(page, 2000).catch(() => this.findBookingFrame(page));
      const ctx = (bf as any) || page;

      const scan = await this.universalScanWidgetDOM(ctx);

      // Filter out already filled fields
      const missing = scan.required
        .filter(f => !f.current_value || f.current_value.trim() === "")
        .map(f => cleanFieldLabel(f.label))
        .filter(Boolean);

      // Also include required dropdowns that haven't been selected
      const missingDropdowns = scan.dropdowns
        .filter(dd => dd.required && (!dd.current_value || dd.current_value === "-"))
        .map(dd => cleanFieldLabel(dd.label))
        .filter(Boolean);

      // Required unchecked checkboxes (terms)
      const missingCbs = scan.checkboxes
        .filter(cb => cb.required && !cb.checked && /умови|terms|policy|политик|съглас/i.test(cb.label))
        .map(cb => cleanFieldLabel(cb.label))
        .filter(Boolean);

      const allMissing = [...new Set([...missing, ...missingDropdowns, ...missingCbs])]
        .map(s => cleanFieldLabel(s))
        .filter(s => s.length > 1)
        .filter(s => !/^(бонус|bonus|прод|next|back|назад|напред|close|bg\b|en\b|arrow|grid|event\b|sell\b)/i.test(s))
        .slice(0, 15);

      console.log(`[UNIVERSAL_SCAN] step="${scan.step_title}" checkout=${scan.is_checkout_step} payment=${scan.is_payment_step} missing=${allMissing.join(" | ") || "none"}`);

      return {
        missing_required: allMissing,
        current_step: scan.is_payment_step ? "payment" : scan.is_checkout_step ? "checkout" : "reserve",
        payment_required: scan.is_payment_step,
        can_continue: allMissing.length === 0,
        is_checkout_step: scan.is_checkout_step,
      };
    } catch (e) {
      console.log(`[UNIVERSAL_SCAN][ERROR] ${e instanceof Error ? e.message : String(e)}`);
      // ✅ Fallback 1: опитай директно в iframe (Clock PMS)
      try {
        const _bf = this.findBookingFrame(page);
        if (_bf) {
          const _scan = await this.universalScanWidgetDOM(_bf);
          const _missingInputs = _scan.required
            .filter(f => !f.current_value || f.current_value.trim() === "")
            .map(f => cleanFieldLabel(f.label)).filter(s => s.length > 1);
          const _missingDDs = _scan.dropdowns
            .filter(d => d.required && (!d.current_value || d.current_value === "-"))
            .map(d => cleanFieldLabel(d.label)).filter(s => s.length > 1);
          const _allMissing = [...new Set([..._missingInputs, ..._missingDDs])].slice(0, 15);
          console.log(`[UNIVERSAL_SCAN][IFRAME_FALLBACK] found=${_allMissing.join(" | ") || "none"}`);
          return {
            missing_required: _allMissing,
            current_step: _scan.is_payment_step ? "payment" : _scan.is_checkout_step ? "checkout" : "reserve",
            payment_required: _scan.is_payment_step,
            can_continue: _allMissing.length === 0,
            is_checkout_step: _scan.is_checkout_step,
          };
        }
      } catch (_innerE) {
        console.log(`[UNIVERSAL_SCAN][IFRAME_FALLBACK_ERROR] ${_innerE instanceof Error ? _innerE.message : String(_innerE)}`);
      }
      // Fallback 2: legacy method
      const fb = await this.inferCurrentBookingStepNeeds(page);
      return { ...fb, is_checkout_step: false };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // END UNIVERSAL WIDGET ENGINE
  // ═══════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────
  // makeReservation — full hotel booking workflow
  // Phase "check": fills dates, gets screenshot with prices
  // Phase "reserve": fills guest details, stops before payment, returns URL
  // ─────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────
  // Universal booking frame finder — works for ANY iframe-based widget
  // ─────────────────────────────────────────────────────────
  private findBookingFrame(page: Page) {
    // Priority: known booking widget patterns in name or URL
    const knownPatterns = [
      "clock", "wbe", "beds24", "cloudbeds", "mews", "sabee", "littlehotelier",
      "hotelrunner", "bookero", "amelia", "quendoo", "booking", "reserv", "hotel",
      "checkout", "availability", "widget",
    ];
    const analyticsPattern = /google\.com\/maps|google\.com\/recaptcha|facebook\.com|youtube\.com|analytics|gtm\.|pixel\.|adsbygoogle|doubleclick|trustpilot/i;
    const frames = page.frames().filter(f => f !== page.mainFrame());
    // First pass: known booking patterns
    for (const f of frames) {
      const n = String(f.name?.() || "").toLowerCase();
      const u = f.url().toLowerCase();
      if (analyticsPattern.test(u)) continue; // skip analytics/maps
      const hay = n + " " + u;
      if (knownPatterns.some(p => hay.includes(p))) return f;
    }
    // Second pass: any non-analytics/non-maps iframe
    for (const f of frames) {
      const u = f.url().toLowerCase();
      if (analyticsPattern.test(u)) continue;
      if (u === "" || u === "about:blank") continue;
      return f;
    }
    return undefined;
  }

  // findBookingFrame with retry — waits up to maxWaitMs for a frame with actual content
  private async findBookingFrameWithContent(page: Page, maxWaitMs = 12000): Promise<any> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const frames = page.frames().filter(f => f !== page.mainFrame());
      const analyticsPattern = /google\.com\/maps|google\.com\/recaptcha|facebook\.com|youtube\.com|analytics|gtm\.|pixel\.|adsbygoogle|doubleclick|trustpilot/i;
      const knownPatterns = ["clock", "wbe", "beds24", "cloudbeds", "mews", "sabee", "littlehotelier", "hotelrunner", "bookero", "amelia", "quendoo", "booking", "reserv", "hotel", "checkout", "availability", "widget"];
      // Look for a frame that: matches known patterns AND has text content
      for (const f of frames) {
        const n = String(f.name?.() || "").toLowerCase();
        const u = f.url().toLowerCase();
        if (analyticsPattern.test(u)) continue;
        const hay = n + " " + u;
        if (!knownPatterns.some(p => hay.includes(p))) continue;
        try {
          const text = await f.locator("body").innerText({ timeout: 1000 }).catch(() => "");
          if (text.trim().length > 30) {
            console.log(`[BOOKING_NAV] Found loaded booking frame: name="${n || u.slice(0,40)}" len=${text.length}`);
            return f;
          }
        } catch {}
      }
      await page.waitForTimeout(400);
    }
    // Fallback: return any non-analytics frame even if empty
    const fb = this.findBookingFrame(page);
    if (fb) console.log("[BOOKING_NAV] Returning frame without content (timeout) — keeping frame for retry");
    return fb;
  }

  // ─────────────────────────────────────────────────────────
  // Universal checkout step detector
  // ─────────────────────────────────────────────────────────
  private async isAtCheckoutStep(frameOrPage: any): Promise<boolean> {
    try {
      const text = (await frameOrPage.locator("body").innerText().catch(() => "")).toLowerCase();

      // IMPORTANT: Clock PMS shows "Завършване" tab on EVERY step — do NOT match it alone.
      // We require STRONG signals: actual input fields for guest data present.

      // 1. Strong text signal: guest data section heading (NOT just nav tab)
      const hasStrongText = (
        /данни\s*за\s*контакт/i.test(text) ||          // БГ section heading
        /guest\s*details|your\s*details|personal\s*details|contact\s*details/i.test(text) ||
        /собствено\s*име.*фамил/i.test(text) ||         // both first+last name labels together
        /first.?name.*last.?name/i.test(text)
      );
      if (hasStrongText) return true;

      // 2. Actual input fields present for guest data (most reliable)
      const hasEmailInput = await frameOrPage.locator(
        "input[type='email'], input[placeholder*='mail'], input[placeholder*='Mail'], input[name*='email'], input[id*='email']"
      ).count().catch(() => 0) > 0;

      const hasNameInput = await frameOrPage.locator(
        "input[placeholder*='Собствено'], input[placeholder*='Фамил'], input[placeholder*='First'], input[placeholder*='Last'], input[name*='first'], input[name*='last'], input[id*='first'], input[id*='last']"
      ).count().catch(() => 0) > 0;

      if (hasEmailInput && hasNameInput) return true;
      if (hasEmailInput) {
        // email input alone is a strong signal IF we also have the step indicator active
        const isOnLastStep = /завършване.*active|active.*завършване/i.test(text) ||
          await frameOrPage.locator('[class*="active"]:has-text("Завършване"), [class*="current"]:has-text("Завършване")').count().catch(() => 0) > 0;
        if (isOnLastStep) return true;
      }

      return false;
    } catch { return false; }
  }


  // ═══════════════════════════════════════════════════════════════════
  // readWidgetStepIndicator — чете хронологичната стъпкова лента
  // на ВСЯКАКЪВ booking widget (Clock PMS, Beds24, Mews, Cloudbeds...)
  // Пример Clock PMS: "СТАИ → ТАРИФИ → ЗАВЪРШВАНЕ"
  // Пример Beds24:    "1. Search 2. Select 3. Details 4. Payment"
  // Пример Mews:      стъпки с числа и активен клас
  // ═══════════════════════════════════════════════════════════════════
  private async readWidgetStepIndicator(ctx: any): Promise<{
    steps: string[];           // всички стъпки в ред
    current_step: string;      // текуща активна стъпка (lowercased)
    current_index: number;     // индекс на текущата стъпка (0-based)
    next_step: string;         // следваща стъпка
    total_steps: number;
    is_last_step: boolean;     // checkout/завършване/payment = последна
    is_checkout: boolean;      // дали сме на checkout стъпка
    raw_text: string;
  }> {
    const EMPTY = { steps: [], current_step: "", current_index: -1, next_step: "", total_steps: 0, is_last_step: false, is_checkout: false, raw_text: "" };
    try {
      return await ctx.evaluate(() => {
        // ── Детектори за step bar ──────────────────────────────────────
        // Стратегия: намери хоризонтален списък от стъпки, 2-8 на брой,
        // кратък текст (≤40 chars), поне 1 е активен/current.
        
        const CHECKOUT_KEYWORDS = /завършв|checkout|payment|плащ|details|данни\s*за\s*к|your\s*details|guest\s*details|contact|контакт/i;
        const TARIFF_KEYWORDS   = /тариф|rates?|price|цена|стаи\s*и|room\s*sel|select\s*room/i;
        const ROOMS_KEYWORDS    = /стаи|rooms?|accommodation|настанявне|нощувки/i;
        // Noise filter — reject strings that look like dates, login buttons, or icon garbage
        const isStepNoise = (s: string): boolean => {
          const t = s.toLowerCase().trim();
          if (!t || t.length < 2) return true;
          if (t.length > 35) return true; // too long for a step label
          if (/\d{1,2}\s+(яну|фев|мар|апр|май|юни|юли|авг|сеп|окт|ное|дек|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true; // date string
          if (/arrow_back|arrow_forward|arrow_drop|chevron|expand_more|expand_less/i.test(t)) return true; // icon
          if (/вход|sign.?in|log.?in|регистр|имейл|email.*вход|login/i.test(t)) return true; // login
          if (/резервирам за|book for|reserve for/i.test(t)) return true; // toggle
          if (/\d{4}/.test(t)) return true; // year in step label = it's a date
          return false;
        };

        const isVisible = (el: Element): boolean => {
          const s = window.getComputedStyle(el as any);
          if (s.display === "none" || s.visibility === "hidden") return false;
          const r = (el as any).getBoundingClientRect?.();
          return !!r && r.width > 1 && r.height > 1;
        };

        const getActiveClass = (el: Element): boolean => {
          const cls = String((el as any).className || "").toLowerCase();
          const aria = (el as any).getAttribute?.("aria-current") || (el as any).getAttribute?.("aria-selected") || "";
          const dataState = (el as any).getAttribute?.("data-state") || "";
          return /active|current|selected|on|step--active|q-tab--active|is-active/.test(cls) ||
                 aria === "step" || aria === "true" || dataState === "active" || dataState === "current";
        };

        const extractStepText = (el: Element): string => {
          // Игнорирай Material icon текст в Clock PMS (q-tab)
          let text = "";
          const children = Array.from(el.childNodes);
          for (const ch of children) {
            if (ch.nodeType === 3) { // TextNode
              const t = ch.textContent?.trim() || "";
              if (t && t.length > 1 && t.length < 40) text += t + " ";
            } else if ((ch as Element).tagName) {
              const tag = (ch as Element).tagName.toLowerCase();
              // Skip icon-only elements (Material Icons, Font Awesome)
              const cls = String((ch as any).className || "").toLowerCase();
              if (tag === "i" || cls.includes("icon") || cls.includes("material")) continue;
              // For q-tab__label — this is the real text
              if (cls.includes("label") || cls.includes("tab__label")) {
                const t = ((ch as HTMLElement).textContent || "").trim();
                if (t) return t;
              }
              const t = ((ch as HTMLElement).innerText || (ch as HTMLElement).textContent || "").trim();
              if (t && t.length > 1 && t.length < 40) text += t + " ";
            }
          }
          return text.trim() || ((el as HTMLElement).innerText || (el as HTMLElement).textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
        };

        // Стратегия 1: Quasar q-tabs (Clock PMS)
        const qTabs = Array.from(document.querySelectorAll(".q-tab, [class*='q-tab']")).filter(isVisible);
        if (qTabs.length >= 2 && qTabs.length <= 8) {
          const steps = qTabs.map(t => extractStepText(t)).filter(s => s.length > 1 && !isStepNoise(s));
          const currentIdx = qTabs.findIndex(t => getActiveClass(t) && !isStepNoise(extractStepText(t)));
          if (steps.length >= 2) {
            const cur = currentIdx >= 0 ? steps[currentIdx] : steps[0];
            const nxt = currentIdx >= 0 && currentIdx < steps.length - 1 ? steps[currentIdx + 1] : "";
            const isLast = currentIdx === steps.length - 1;
            const isCheckout = CHECKOUT_KEYWORDS.test(cur) || isLast;
            return { steps, current_step: cur.toLowerCase(), current_index: currentIdx, next_step: nxt, total_steps: steps.length, is_last_step: isLast, is_checkout: isCheckout, raw_text: steps.join(" → ") };
          }
        }

        // Стратегия 2: ol/ul.steps или [class*=step] или [role=tablist]
        const stepContainers = [
          ...Array.from(document.querySelectorAll("ol.steps, ul.steps, .wizard-steps, .step-indicator, .booking-steps, .checkout-steps, [class*='step-bar'], [class*='stepbar'], [class*='booking-wizard']")),
          ...Array.from(document.querySelectorAll("[role='tablist'], [role='progressbar']")),
          ...Array.from(document.querySelectorAll("nav[class*='step'], div[class*='steps']")),
        ];
        for (const container of stepContainers) {
          if (!isVisible(container)) continue;
          const items = Array.from(container.querySelectorAll("li, .step, [class*='-step'], [role='tab'], a, span[class*='step']")).filter(isVisible);
          if (items.length < 2 || items.length > 8) continue;
          const steps = items.map(it => extractStepText(it)).filter(s => s.length > 1 && s.length < 40);
          if (steps.length < 2) continue;
          const currentIdx = items.findIndex(it => getActiveClass(it));
          const cur = currentIdx >= 0 ? steps[currentIdx] : steps[0];
          const nxt = currentIdx >= 0 && currentIdx < steps.length - 1 ? steps[currentIdx + 1] : "";
          const isLast = currentIdx === steps.length - 1;
          const isCheckout = CHECKOUT_KEYWORDS.test(cur) || isLast;
          return { steps, current_step: cur.toLowerCase(), current_index: currentIdx, next_step: nxt, total_steps: steps.length, is_last_step: isLast, is_checkout: isCheckout, raw_text: steps.join(" → ") };
        }

        // Стратегия 3: Numbered steps (1. Стаи 2. Тарифи 3. Завършване)
        const numberedRe = /^[1-9][.)]\s*\S/;
        const allDivs = Array.from(document.querySelectorAll("div, span, a")).filter(el => {
          if (!isVisible(el)) return false;
          const t = (el as HTMLElement).innerText?.trim() || "";
          return numberedRe.test(t) && t.length < 40;
        });
        if (allDivs.length >= 2 && allDivs.length <= 8) {
          const steps = allDivs.map(el => extractStepText(el)).filter(s => s.length > 1);
          const currentIdx = allDivs.findIndex(el => getActiveClass(el));
          const cur = currentIdx >= 0 ? steps[currentIdx] : "";
          const nxt = currentIdx >= 0 && currentIdx < steps.length - 1 ? steps[currentIdx + 1] : "";
          const isLast = currentIdx === steps.length - 1;
          const isCheckout = CHECKOUT_KEYWORDS.test(cur) || isLast;
          if (steps.length >= 2) {
            return { steps, current_step: cur.toLowerCase(), current_index: currentIdx, next_step: nxt, total_steps: steps.length, is_last_step: isLast, is_checkout: isCheckout, raw_text: steps.join(" → ") };
          }
        }

        // Стратегия 4: Намери активен елемент и съседи (по-общ подход)
        const activeEls = Array.from(document.querySelectorAll("[aria-current='step'], [class*='step'][class*='active'], [class*='active'][class*='step']")).filter(isVisible);
        if (activeEls.length > 0) {
          const active = activeEls[0];
          const parent = active.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(isVisible);
            if (siblings.length >= 2 && siblings.length <= 8) {
              const steps = siblings.map(s => extractStepText(s)).filter(s => s.length > 1);
              const currentIdx = siblings.indexOf(active);
              const cur = currentIdx >= 0 ? steps[currentIdx] : "";
              const nxt = currentIdx >= 0 && currentIdx < steps.length - 1 ? steps[currentIdx + 1] : "";
              const isLast = currentIdx === steps.length - 1;
              const isCheckout = CHECKOUT_KEYWORDS.test(cur) || isLast;
              return { steps, current_step: cur.toLowerCase(), current_index: currentIdx, next_step: nxt, total_steps: steps.length, is_last_step: isLast, is_checkout: isCheckout, raw_text: steps.join(" → ") };
            }
          }
        }

        return { steps: [], current_step: "", current_index: -1, next_step: "", total_steps: 0, is_last_step: false, is_checkout: false, raw_text: "" };
      });
    } catch (e) {
      console.log(`[STEP_INDICATOR] Error: ${e instanceof Error ? e.message : String(e)}`);
      return EMPTY;
    }
  }

  // ─────────────────────────────────────────────────────────
  // Universal booking widget navigator (replaces clockPmsNavigateToCheckout)
  // Works for: Clock PMS, Beds24, Cloudbeds, Mews, SabeeApp, LittleHotelier,
  //            HotelRunner, Bookero, Amelia, Quendoo, and generic multi-step widgets
  // ─────────────────────────────────────────────────────────
  private async navigateBookingWidgetToCheckout(page: Page, guests: string): Promise<boolean> {
    // Use async frame finder — waits up to 8s for a frame with actual content
    const bf = await this.findBookingFrameWithContent(page, 4000);

    // Apply a zoom-out on the main page to improve visibility of the booking widget.
    // Many hotel sites display the Clock PMS or other widgets in a small area,
    // requiring excessive scrolling.  By zooming out we can see both the
    // tariffs and the checkout button without scrolling, which reduces the
    // chance of the navigator getting "stuck".  The zoom factor is set to
    // 80% (i.e. scale down by 20%), but this can be tuned as needed.  We only
    // apply the zoom once per page using a marker on the window object.
    try {
      await page.evaluate(() => {
        const w: any = window;
        if (!w.__neoZoomApplied) {
          const zoomFactor = 0.8;
          document.body.style.zoom = String(zoomFactor);
          (document.documentElement as HTMLElement).style.zoom = String(zoomFactor);
          w.__neoZoomApplied = true;
        }
      });
    } catch {
      // ignore zoom errors
    }
    if (!bf) {
      if (await this.isAtCheckoutStep(page)) return true;
      console.log("[BOOKING_NAV] No booking iframe found — trying main page navigation");
    }
    let ctx: any = bf || page;
    const guestNum = parseInt(guests || "2") || 2;
    console.log(`[BOOKING_NAV] Starting universal checkout navigator guests=${guestNum} iframe=${!!bf}`);

    let _prevFrameText = "";
    let _sameTextCount = 0;

    for (let step = 0; step < 14; step++) {
      await page.waitForTimeout(500);
      // Re-find frame each step in case it changed (e.g. new iframe opened)
      if (bf) {
        const freshFrame = await this.findBookingFrameWithContent(page, 800);
        if (freshFrame) ctx = freshFrame;
      }
      const frameText = (await ctx.locator("body").innerText().catch(() => "")).toLowerCase();
      console.log(`[BOOKING_NAV] step=${step} len=${frameText.length} preview="${frameText.slice(0, 120).replace(/\s+/g, " ")}"`);

      // ── Четем step indicator на widget-а (Clock PMS q-tabs, Beds24, Mews и т.н.) ──
      // Това е най-надеждният начин да разберем на коя стъпка сме и накъде да вървим
      const stepInfo = await this.readWidgetStepIndicator(ctx).catch(() => null);
      // ✅ v12 FIX: StepBar now ROUTES to the correct handler — overrides text detection
      let _stepBarForceTariff = false;
      let _stepBarForceRoom   = false;
      if (stepInfo && stepInfo.steps.length >= 2) {
        console.log(`[BOOKING_NAV] StepBar: [${stepInfo.steps.join(" → ")}] current="${stepInfo.current_step}" idx=${stepInfo.current_index}/${stepInfo.total_steps-1}`);

        // Ако сме на checkout → готово
        if (stepInfo.is_checkout || stepInfo.is_last_step) {
          console.log("[BOOKING_NAV] StepBar indicates CHECKOUT step ✓"); return true;
        }

        const _curStep = stepInfo.current_step || "";
        // StepBar "rates"/"тарифи"/"sell"/"price" → tariff handler
        if (/rates?|тариф|sell|price|цен/i.test(_curStep)) {
          _stepBarForceTariff = true;
          console.log(`[BOOKING_NAV] StepBar ROUTES → TARIFF handler (current="${_curStep}")`);
        }
        // StepBar "rooms"/"стаи"/"accommodation" → room handler
        else if (/rooms?|стаи|accommodation|grid_view/i.test(_curStep)) {
          _stepBarForceRoom = true;
          console.log(`[BOOKING_NAV] StepBar ROUTES → ROOM handler (current="${_curStep}")`);
        }
        // StepBar "stay"/"престой" → we're on dates step, need to click next room
        else if (/stay|престой/i.test(_curStep)) {
          _stepBarForceRoom = true;
          console.log(`[BOOKING_NAV] StepBar ROUTES → ROOM handler via stay step (current="${_curStep}")`);
        }
      }
      if (frameText.trim().length < 20) {
        console.log("[BOOKING_NAV] iframe content empty — waiting");
        await page.waitForTimeout(800); continue;
      }

      // ── Infinite loop detection ──────────────────────────
      if (frameText === _prevFrameText) {
        _sameTextCount++;
        if (_sameTextCount >= 2) {
          console.log(`[BOOKING_NAV] Frame text unchanged for ${_sameTextCount} steps — trying modal/overlay detection`);

          // ✅ Use direct element visibility — Quasar dialogs are in portals, invisible to innerText
          const _toggleVisible = await page.locator('.q-toggle__thumb, .q-toggle__inner').first().isVisible().catch(() => false);
          const _loginVisible = await page.locator('button:has-text("Вход с Google"), button:has-text("Вход с имейл")').first().isVisible().catch(() => false);
          const _reserveVisible = await page.locator('label:has-text("Резервирам за някой друг")').first().isVisible().catch(() => false);
          const _hasOverlay = _toggleVisible || _loginVisible || _reserveVisible;
          console.log(`[BOOKING_NAV] stuck overlay check: toggle=${_toggleVisible} login=${_loginVisible} reserve=${_reserveVisible}`);

          if (_hasOverlay) {
            console.log("[BOOKING_NAV] Clock PMS overlay detected — clicking Резервирам за някой друг toggle");

            const _toggleSelectors = [
              '.q-toggle__thumb',
              '.q-toggle__inner',
              '[class*="q-toggle__track"]',
              '[class*="toggle__thumb"]',
              '[class*="toggle__inner"]',
              'label:has-text("Резервирам за някой друг")',
              'label:has-text("Резервирам")',
              '[class*="q-toggle"]',
            ];

            let _didToggle = false;
            for (const _ts of _toggleSelectors) {
              try {
                const _tel = page.locator(_ts).first();
                if (await _tel.count().catch(() => 0) === 0) continue;
                if (!(await _tel.isVisible({ timeout: 500 }).catch(() => false))) continue;
                await _tel.scrollIntoViewIfNeeded().catch(() => {});
                await _tel.click({ timeout: 1500, force: true }).catch(() => {});
                console.log(`[BOOKING_NAV] Clicked toggle: "${_ts}"`);
                _didToggle = true;
                break;
              } catch {}
            }

            if (_didToggle) {
              for (let _cw = 0; _cw < 8; _cw++) {
                await page.waitForTimeout(600);
                if (await this.isAtCheckoutStep(page)) {
                  console.log("[BOOKING_NAV] Checkout appeared on main page after toggle ✓");
                  return true;
                }
                if (await this.isAtCheckoutStep(ctx)) {
                  console.log("[BOOKING_NAV] Checkout appeared in iframe after toggle ✓");
                  return true;
                }
                const _newFt = (await ctx.locator("body").innerText().catch(() => "")).toLowerCase();
                if (_newFt !== frameText && _newFt.length > 100) {
                  console.log("[BOOKING_NAV] iframe changed after toggle — continuing");
                  _sameTextCount = 0; _prevFrameText = "";
                  break;
                }
              }
              _sameTextCount = 0; _prevFrameText = "";
              continue;
            }
          }

          // Check for Quasar dialog/overlay even without specific text
          const modalVisible = await page.locator(
            '.q-dialog__backdrop, .q-overlay, [class*="q-dialog"]'
          ).first().isVisible().catch(() => false);
          if (modalVisible) {
            console.log("[BOOKING_NAV] Quasar dialog detected — checking for any action buttons");
            const _dlgBtns = await page.locator('.q-dialog button, [class*="q-dialog"] button').all().catch(() => []);
            for (const _db of _dlgBtns) {
              const _dt = (await _db.innerText().catch(() => "")).trim();
              if (!_dt || isBadClickableLabel(_dt)) continue;
              if (await _db.isVisible().catch(() => false)) {
                await _db.click({ timeout: 1500 }).catch(() => {});
                console.log(`[BOOKING_NAV] Clicked dialog button: "${_dt}"`);
                _sameTextCount = 0; await page.waitForTimeout(800);
                break;
              }
            }
          }

          // Re-check checkout
          if (await this.isAtCheckoutStep(page) || await this.isAtCheckoutStep(ctx)) {
            console.log("[BOOKING_NAV] Checkout reached after modal handling ✓"); return true;
          }

          // ✅ If stuck on tariff step with no ИЗБЕРИ found, try scrolling frame
          // and searching for ИЗБЕРИ with force approach
          const _stuckOnTariff = /standard.?rate|standard.?rate.?bb|meal\s*plan|rate\s*name|bb\s*plan|нощувка\s*с\s*закуска|закуска\s*включен/i.test(frameText);
          if (_sameTextCount >= 2 && _stuckOnTariff) {
            console.log("[BOOKING_NAV] Stuck on tariff step — trying frame-wide ИЗБЕРИ search");
            const _stuckBtns = await ctx.locator("button, [role='button']").all().catch(() => []);
            for (const _sb of _stuckBtns) {
              const _st = (await _sb.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
              if (!/избери|ИЗБЕРИ|select|reserve/i.test(_st) || _st.length > 60) continue;
              await _sb.scrollIntoViewIfNeeded().catch(() => {});
              await page.waitForTimeout(200);
              await _sb.click({ timeout: 2000, force: true }).catch(() => {});
              console.log(`[BOOKING_NAV] Stuck-recovery clicked: "${_st}"`);
              _sameTextCount = 0; _prevFrameText = "";
              await page.waitForTimeout(800);
              break;
            }
          }

          if (_sameTextCount >= 4) {
            console.log("[BOOKING_NAV] Stuck — same frame text 4+ times, stopping");
            break;
          }
          continue;
        }
      } else {
        _sameTextCount = 0;
      }
      _prevFrameText = frameText;

      // ── Already at checkout ──────────────────────────────
      if (await this.isAtCheckoutStep(ctx)) {
        console.log("[BOOKING_NAV] Reached checkout step ✓"); return true;
      }

      // ── Room/accommodation selection step ────────────────
      // NOTE: "нощувка с" appears in BOTH rooms descriptions AND tariff pages.
      // We must only match ACTUAL tariff/rates page indicators.
      const hasTariffContent = (
        /standard.?rate|standard.?rate.?bb|meal\s*plan|bb\s*plan|rate\s*name/i.test(frameText) ||
        /breakfast\s*included|нощувка\s*с\s*закуска|закуска\s*включен/i.test(frameText) ||
        /\d+[\.,]\d+\s*(лв|bgn|eur|€|\$)\s*[\/на]\s*нощ/i.test(frameText)
      );
      const isRoomStep = _stepBarForceRoom || (
        !_stepBarForceTariff &&
        /апартамент|единична|двойна|студио|suite|room|стая|accommodation|камер/i.test(frameText) &&
        !hasTariffContent
      );
      if (isRoomStep) {
        console.log("[BOOKING_NAV] On room selection step — searching for available CTA in frame");

        // Search for "ПОКАЖИ ТАРИФИТЕ" (or equivalent) in ANY available card
        // STRICTLY inside ctx (booking iframe) — no main page interaction
        let roomClicked = false;

        const _roomCTASels = [
          'button:has-text("ПОКАЖИ ТАРИФИТЕ")',
          '[role="button"]:has-text("ПОКАЖИ ТАРИФИТЕ")',
          'button:has-text("Покажи тарифите")',
          'button:has-text("Check rates")',
          'button:has-text("Show rates")',
        ];
        for (const _rSel of _roomCTASels) {
          const _rBtns = await ctx.locator(_rSel).all().catch(() => []);
          for (const _rb of _rBtns) {
            if (!(await _rb.isVisible().catch(() => false))) continue;
            // Skip if button is inside an "Не е налично" card
            const _unavail = await _rb.evaluate((el: any): boolean => {
              let p: Element | null = el;
              for (let i = 0; i < 8 && p; i++) {
                if (/не\s*е\s*налично|not\s*available|sold.?out/i.test(
                  ((p as any).innerText || "").slice(0, 400))) return true;
                p = p.parentElement;
              }
              return false;
            }).catch(() => false);
            if (_unavail) continue;
            await _rb.scrollIntoViewIfNeeded().catch(() => {});
            await _rb.click({ timeout: 2000 }).catch(() => {});
            console.log(`[BOOKING_NAV] ✓ Clicked room CTA: "${_rSel}"`);
            roomClicked = true; break;
          }
          if (roomClicked) break;
        }

        if (!roomClicked) {
          // Fallback: any visible non-icon, non-calendar button not in unavailable card
          const _allBtns = await ctx.locator("button, [role='button']").all().catch(() => []);
          for (const _btn of _allBtns) {
            const _t = (await _btn.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
            if (!_t || isBadClickableLabel(_t)) continue;
            if (/календар|заетост|calendar/i.test(_t)) continue;
            if (!(await _btn.isVisible().catch(() => false))) continue;
            const _unavail = await _btn.evaluate((el: any): boolean => {
              let p: Element | null = el;
              for (let i = 0; i < 8 && p; i++) {
                if (/не\s*е\s*налично|not\s*available|sold.?out/i.test(
                  ((p as any).innerText || "").slice(0, 400))) return true;
                p = p.parentElement;
              }
              return false;
            }).catch(() => false);
            if (_unavail) continue;
            await _btn.scrollIntoViewIfNeeded().catch(() => {});
            await _btn.click({ timeout: 2000 }).catch(() => {});
            console.log(`[BOOKING_NAV] ✓ Clicked fallback room btn: "${_t}"`);
            roomClicked = true; break;
          }
        }

        await page.waitForTimeout(900); continue;
      }

      // ── Tariff/rate selection step ───────────────────────
      // Clock PMS specific flow (works for other widgets too):
      //   1st ИЗБЕРИ click → opens guests/rooms dropdown IN iframe
      //   Select guests value
      //   2nd ИЗБЕРИ click → triggers main page overlay (login/guest toggle)
      //   Click "Резервирам за някой друг" → checkout form appears on main page
      const hasIzberiBtn = await ctx.locator(
        'button:has-text("ИЗБЕРИ"), button:has-text("Избери"), [role="button"]:has-text("ИЗБЕРИ")'
      ).count().catch(() => 0) > 0;
      const isTariffStep = _stepBarForceTariff || hasTariffContent || hasIzberiBtn ||
        /standard.?rate|standard.?rate.?bb|meal\s*plan|rate\s*name|bb\s*plan|нощувка\s*с\s*закуска|закуска\s*включен/i.test(frameText);
      if (isTariffStep) {
        console.log(`[BOOKING_NAV] On tariff/rate step hasIzberi=${hasIzberiBtn} hasTariffContent=${hasTariffContent}`);

        // ── Step A: Set guest count via select/dropdown/stepper ──
        let _guestsSet = false;
        // 1. Native <select>
        const _selEl = ctx.locator("select").first();
        if (await _selEl.count().catch(() => 0) > 0) {
          await _selEl.selectOption(String(guestNum)).catch(async () => {
            await _selEl.selectOption({ index: Math.min(guestNum - 1, 2) }).catch(() => {});
          });
          await page.waitForTimeout(300);
          _guestsSet = true;
          console.log(`[BOOKING_NAV] Set guests via <select> to ${guestNum}`);
        }

        // 2. Clock PMS Quasar dropdown — click to open "Възрастни/Adults" specifically
        if (!_guestsSet) {
          // Only target the Adults/Guests dropdown by label — NOT any q-field (would open language/other dropdowns)
          const _qDropLabel = ctx.locator('[class*="q-field"], [class*="q-select"]').filter({ hasText: /Възрастни|Adults|Гости|Guests/i }).first();
          if (await _qDropLabel.count().catch(() => 0) > 0 && await _qDropLabel.isVisible().catch(() => false)) {
            await _qDropLabel.click({ timeout: 1500 }).catch(() => {});
            await page.waitForTimeout(400);
            // Pick the right option from the opened list
            const _optSel = `[role="option"]:has-text("${guestNum}"), li:has-text("${guestNum}"), .q-item:has-text("${guestNum}")`;
            const _opt = page.locator(_optSel).first(); // options appear on main page DOM
            const _optInCtx = ctx.locator(_optSel).first();
            if (await _opt.isVisible().catch(() => false)) {
              await _opt.click({ timeout: 1500 }).catch(() => {});
              _guestsSet = true;
              console.log(`[BOOKING_NAV] Set guests via Quasar dropdown (main page) to ${guestNum}`);
            } else if (await _optInCtx.isVisible().catch(() => false)) {
              await _optInCtx.click({ timeout: 1500 }).catch(() => {});
              _guestsSet = true;
              console.log(`[BOOKING_NAV] Set guests via Quasar dropdown (iframe) to ${guestNum}`);
            } else {
              // Close the dropdown if no matching option found
              await page.keyboard.press("Escape").catch(() => {});
            }
            await page.waitForTimeout(300);
          }
        }

        // 3. Stepper +/- (Mews, Beds24 style)
        if (!_guestsSet) {
          const _plusBtn = ctx.locator('[class*="plus"], [class*="increment"], button:has-text("+"), [aria-label*="add"], [aria-label*="increase"]').first();
          if (await _plusBtn.isVisible().catch(() => false)) {
            const _curVal = parseInt(await ctx.locator('input[type="number"]').first().inputValue().catch(() => "1")) || 1;
            for (let _p = _curVal; _p < guestNum; _p++) {
              await _plusBtn.click({ timeout: 1000 }).catch(() => {});
              await page.waitForTimeout(150);
            }
            _guestsSet = true;
          }
        }

        // ── Step B: Click ИЗБЕРИ / rate CTA — strictly inside ctx (booking iframe) ──
        // ✅ IMPORTANT: Clock PMS has TWO versions of ИЗБЕРИ:
        //   1st click: "arrow_downward ИЗБЕРИ" (↓) → opens guests/rooms popup
        //   2nd click: "arrow_forward ИЗБЕРИ" (→) → submits and triggers main overlay
        // After setting guests, PREFER arrow_forward over arrow_downward.
        await page.waitForTimeout(300);
        let _izberiClicked = false;

        const _ctaBtns = await ctx.locator("button, [role='button']").all().catch(() => []);

        // Pass 1: prefer arrow_forward / arrow_right ИЗБЕРИ (submits after guests set)
        if (_guestsSet) {
          for (const _btn of _ctaBtns) {
            const _t = (await _btn.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
            if (!_t) continue;
            if (/избери|select|reserve/i.test(_t) && /arrow_forward|arrow_right|→/i.test(_t) && _t.length <= 60) {
              await _btn.scrollIntoViewIfNeeded().catch(() => {});
              await page.waitForTimeout(100);
              if (await _btn.isVisible().catch(() => false)) {
                await _btn.click({ timeout: 2000 }).catch(() => {});
                console.log(`[BOOKING_NAV] Clicked SUBMIT rate CTA (→): "${_t.replace(/\s+/g, " ")}"`);
                _izberiClicked = true;
                break;
              }
            }
          }
        }

        // Pass 2: any ИЗБЕРИ (including arrow_downward on first step)
        if (!_izberiClicked) {
          for (const _btn of _ctaBtns) {
            const _t = (await _btn.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
            if (!_t) continue;
            if (/избери|select|book|резерв|choose|reserve/i.test(_t) && _t.length <= 60) {
              await _btn.scrollIntoViewIfNeeded().catch(() => {});
              await page.waitForTimeout(100);
              if (await _btn.isVisible().catch(() => false)) {
                await _btn.click({ timeout: 2000 }).catch(() => {});
                console.log(`[BOOKING_NAV] Clicked rate CTA: "${_t.replace(/\s+/g, " ")}"`);
                _izberiClicked = true;
                break;
              }
            }
          }
        }
        if (!_izberiClicked) {
          console.log(`[BOOKING_NAV] ИЗБЕРИ not found on tariff step — hasTariffContent=${hasTariffContent}`);
        }

        // ── Step C: After ИЗБЕРИ, handle Clock PMS main page overlay OR proceed to arrow_forward ──
        // ✅ v12 FIX: Also check if arrow_forward SELECT is now available (guest qty may have auto-set)
        // ✅ CRITICAL FIX: DO NOT use body.innerText() — Quasar dialogs are in aria-hidden
        // portals and are invisible to innerText(). Use direct element visibility instead.
        await page.waitForTimeout(1400);

        // Check main page for Clock PMS checkout overlay
        for (let _od = 0; _od < 8; _od++) {
          await page.waitForTimeout(500);

          // Did checkout form appear? (on main page)
          if (await this.isAtCheckoutStep(page)) {
            console.log("[BOOKING_NAV] Checkout form appeared on main page ✓");
            return true;
          }
          if (await this.isAtCheckoutStep(ctx)) {
            console.log("[BOOKING_NAV] Checkout form appeared in iframe ✓");
            return true;
          }

          // ✅ Use direct element visibility — not innerText — to detect Clock PMS overlay
          const _toggleEl = page.locator('.q-toggle__thumb, .q-toggle__inner').first();
          const _loginBtn = page.locator('button:has-text("Вход с Google"), button:has-text("Вход с имейл")').first();
          const _reserveLabel = page.locator('label:has-text("Резервирам за някой друг"), [class*="q-toggle"]:has-text("Резервирам")').first();

          const _hasOverlay =
            await _toggleEl.isVisible().catch(() => false) ||
            await _loginBtn.isVisible().catch(() => false) ||
            await _reserveLabel.isVisible().catch(() => false);

          console.log(`[BOOKING_NAV] overlay check _od=${_od} hasOverlay=${_hasOverlay}`);

          if (_hasOverlay) {
            console.log(`[BOOKING_NAV] Clock PMS overlay detected (attempt ${_od + 1})`);

            const _toggleSelectors = [
              '.q-toggle__thumb',
              '.q-toggle__inner',
              '[class*="q-toggle__track"]',
              'label:has-text("Резервирам за някой друг")',
              '[class*="q-toggle"]:has-text("Резервирам")',
              'label:has-text("Резервирам")',
            ];
            let _toggled = false;
            for (const _tSel of _toggleSelectors) {
              try {
                const _tEl = page.locator(_tSel).first();
                if (await _tEl.count().catch(() => 0) === 0) continue;
                if (!(await _tEl.isVisible({ timeout: 800 }).catch(() => false))) continue;
                await _tEl.scrollIntoViewIfNeeded().catch(() => {});
                await _tEl.click({ timeout: 1500, force: true }).catch(() => {});
                console.log(`[BOOKING_NAV] ✓ Clicked guest toggle: "${_tSel}"`);
                _toggled = true;
                break;
              } catch {}
            }

            if (_toggled) {
              _sameTextCount = 0; _prevFrameText = "";
              for (let _cw2 = 0; _cw2 < 8; _cw2++) {
                await page.waitForTimeout(600);
                if (await this.isAtCheckoutStep(page)) {
                  console.log("[BOOKING_NAV] Checkout appeared on main page after toggle ✓");
                  return true;
                }
                if (await this.isAtCheckoutStep(ctx)) {
                  console.log("[BOOKING_NAV] Checkout appeared in iframe after toggle ✓");
                  return true;
                }
              }
              break;
            }
            break;
          }

          // Check if a guests/adults dropdown opened (after first arrow_downward click)
          // Must check BOTH iframe and main page — Quasar teleports menus to document root
          const _ddSelectors = [
            '[class*="q-menu"], [class*="q-list"], .q-virtual-scroll, [role="listbox"]',
            '[class*="dropdown"][class*="open"], [class*="select"][class*="open"]',
            '.q-popup-container, [aria-haspopup="listbox"][aria-expanded="true"]',
          ];
          let _openDropdown = false;
          let _listCtx: any = page;
          for (const _dds of _ddSelectors) {
            const _inPage = await page.locator(_dds).first().isVisible().catch(() => false);
            const _inCtx  = await ctx.locator(_dds).first().isVisible().catch(() => false);
            if (_inPage) { _openDropdown = true; _listCtx = page; break; }
            if (_inCtx)  { _openDropdown = true; _listCtx = ctx;  break; }
          }

          if (_openDropdown) {
            console.log("[BOOKING_NAV] Dropdown is open — selecting guest count");
            const _optSels = [
              `[role="option"]:has-text("${guestNum}")`,
              `.q-item:has-text("${guestNum}")`,
              `li:has-text("${guestNum}")`,
              `option:has-text("${guestNum}")`,
            ];
            let _optClicked = false;
            for (const _os of _optSels) {
              const _optEl = _listCtx.locator(_os).first();
              if (await _optEl.isVisible().catch(() => false)) {
                await _optEl.click({ timeout: 1500 }).catch(() => {});
                console.log(`[BOOKING_NAV] Selected ${guestNum} guests from dropdown`);
                await page.waitForTimeout(400);
                _sameTextCount = 0; _prevFrameText = "";
                _optClicked = true;
                break;
              }
            }
            if (_optClicked) {
              // Now try arrow_forward SELECT to proceed to checkout
              await page.waitForTimeout(300);
              const _fwdBtns = await ctx.locator("button, [role='button']").all().catch(() => []);
              for (const _fb of _fwdBtns) {
                const _ft = (await _fb.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
                if (/избери|select|reserve/i.test(_ft) && /arrow_forward|arrow_right|→/i.test(_ft) && _ft.length <= 60) {
                  await _fb.scrollIntoViewIfNeeded().catch(() => {});
                  await _fb.click({ timeout: 2000 }).catch(() => {});
                  console.log(`[BOOKING_NAV] Clicked → SELECT after guest selection: "${_ft}"`);
                  break;
                }
              }
            }
            break;
          }
        }
        // ✅ v12: If no overlay found and dropdown didn't open — try arrow_forward SELECT as last resort
        if (_izberiClicked) {
          const _fwdBtns2 = await ctx.locator("button, [role='button']").all().catch(() => []);
          for (const _fb2 of _fwdBtns2) {
            const _ft2 = (await _fb2.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
            if (/избери|select|reserve/i.test(_ft2) && /arrow_forward|arrow_right|→/i.test(_ft2) && _ft2.length <= 60) {
              if (await _fb2.isVisible().catch(() => false)) {
                await _fb2.scrollIntoViewIfNeeded().catch(() => {});
                await _fb2.click({ timeout: 2000 }).catch(() => {});
                console.log(`[BOOKING_NAV] Last resort → SELECT: "${_ft2}"`);
                await page.waitForTimeout(1200);
                if (await this.isAtCheckoutStep(page) || await this.isAtCheckoutStep(ctx)) {
                  console.log("[BOOKING_NAV] Checkout reached after → SELECT ✓"); return true;
                }
                break;
              }
            }
          }
        }
        continue;
      }

      // ── Login/auth prompt — use direct visibility (not innerText) ────
      const _loginInFrame = /вход\s*с|login|sign.?in|google|имейл.*влез|create\s*account/i.test(frameText);
      const _loginOnPage =
        await page.locator('button:has-text("Вход с Google"), button:has-text("Вход с имейл")').first().isVisible().catch(() => false) ||
        await page.locator('label:has-text("Резервирам за някой друг"), .q-toggle__thumb').first().isVisible().catch(() => false);
      if (_loginInFrame || _loginOnPage) {
        console.log(`[BOOKING_NAV] Login/auth prompt detected inFrame=${_loginInFrame} onPage=${_loginOnPage}`);
        // Try "Резервирам за някой друг" on MAIN page (Clock PMS)
        const _guestToggleSelectors = [
          'label:has-text("Резервирам за някой друг")',
          '[class*="q-toggle"]:has-text("Резервирам")',
          'label:has-text("Резервирам")',
        ];
        let _handled = false;
        for (const _s of _guestToggleSelectors) {
          const _el = page.locator(_s).first();
          if (await _el.isVisible().catch(() => false)) {
            await _el.click().catch(() => {});
            console.log(`[BOOKING_NAV] Clicked guest toggle on main page: "${_s}"`);
            _handled = true;
            _sameTextCount = 0; _prevFrameText = "";
            await page.waitForTimeout(800);
            if (await this.isAtCheckoutStep(page)) {
              console.log("[BOOKING_NAV] Checkout appeared after login bypass ✓"); return true;
            }
            break;
          }
        }
        if (!_handled) {
          // Try in iframe
          const _ctxLbl = ctx.locator("label, button").filter({ hasText: /резервирам|guest|без регистрация/i }).first();
          if (await _ctxLbl.isVisible().catch(() => false)) {
            await _ctxLbl.click().catch(() => {});
            _sameTextCount = 0; _prevFrameText = "";
            await page.waitForTimeout(600);
          }
        }
        continue;
      }

      // ── Generic forward navigation ───────────────────────
      const fwdSelectors = [
        'button:has-text("Продължи")', 'button:has-text("Напред")',
        'button:has-text("Next")', 'button:has-text("Continue")',
        'button:has-text("Proceed")', '[class*="next-step"]',
        'button[class*="next"]', 'a[class*="next"]',
      ];
      let fwdClicked = false;
      for (const sel of fwdSelectors) {
        try {
          const btn = ctx.locator(sel).first();
          if (await btn.count().catch(() => 0) === 0) continue;
          if (!(await btn.isVisible().catch(() => false))) continue;
          await btn.click({ timeout: 1500 }).catch(() => {});
          console.log(`[BOOKING_NAV] Forwarded with: "${sel}"`);
          fwdClicked = true; break;
        } catch {}
      }
      if (!fwdClicked) {
        // Catch-all: try any visible non-icon button in the iframe
        console.log(`[BOOKING_NAV] No named forward button at step=${step} — trying any action button`);
        const anyBtns = await ctx.locator("button, [role='button']").all().catch(() => []);
        for (const btn of anyBtns) {
          const t = (await btn.innerText().catch(() => "")).trim();
          if (!t || isBadClickableLabel(t)) continue;
          if (!(await btn.isVisible().catch(() => false))) continue;
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn.click({ timeout: 1500 }).catch(() => {});
          console.log(`[BOOKING_NAV] Catch-all clicked: "${t}"`);
          fwdClicked = true; break;
        }
        if (!fwdClicked) {
          console.log(`[BOOKING_NAV] No clickable button at step=${step} — stopping`);
          break;
        }
      }
    }
    // Final check
    return await this.isAtCheckoutStep(ctx);
  }

  async makeReservation(req: MakeReservationRequest): Promise<{
    ok: boolean;
    phase: string;
    message: string;
    screenshot_base64?: string | null;
    booking_url?: string | null;
    prices_found?: string;
    observation?: JsonObj;
    // v9: top-level fields for easier frontend consumption
    stage?: string;
    needs_input?: boolean;
    missing_required?: string[];
    selected_room_type?: string;
    current_step?: string;
    payment_required?: boolean;
    can_continue?: boolean;
    check_in?: string;
    check_out?: string;
    guests?: string;
    room_type?: string;
    worker_message?: string;
    worker_result?: JsonObj;
    timing_ms?: number;
    build_id?: string;
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

          // ✅ v11 FIX: Navigate intelligently — same logic as checkAvailability
          const _mrkHasFrame = !!this.findBookingFrame(page);
          const _mrkCurUrl = page.url();
          const _mrkSchemaUrl = availSchema.url || "";
          let _mrkShouldNav = !_mrkHasFrame;
          if (!_mrkShouldNav && _mrkSchemaUrl) {
            try {
              const _sp = new URL(_mrkSchemaUrl).pathname;
              const _cp = new URL(_mrkCurUrl).pathname;
              if (_sp !== "/" && _sp !== _cp && !_sp.includes("%")) _mrkShouldNav = true;
            } catch {}
          }
          if (_mrkShouldNav) {
            await this.ensureOnSchemaUrl(page, _mrkSchemaUrl);
            await page.waitForTimeout(1200);
            if (!this.findBookingFrame(page) && _mrkSchemaUrl) {
              try {
                const _siteRoot = new URL(_mrkSchemaUrl).origin + "/";
                if (_siteRoot !== page.url()) {
                  console.log(`[RESERVATION][CHECK] No iframe at schema URL → trying site root: ${_siteRoot}`);
                  await page.goto(_siteRoot, { waitUntil: "domcontentloaded", timeout: 12000 });
                  await page.waitForTimeout(1800);
                }
              } catch {}
            }
          } else {
            console.log(`[RESERVATION][CHECK] Using current page (correct, has iframe): ${_mrkCurUrl}`);
            await page.waitForTimeout(800);
          }

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
          // Bulgarian Clock PMS specific
          egn: req.guest_egn || "",
          birthdate: req.guest_birthdate || "",
          gender: req.guest_gender || "",
          country: req.guest_country || "",
          doc_type: req.guest_doc_type || "",
          doc_number: req.guest_doc_number || "",
        };

        const beforeUrl = page.url();
        console.log(`[RESERVATION][RESERVE] staying on current booking step url=${beforeUrl}`);
        await page.waitForTimeout(400);

        // Early exit: if Clock PMS iframe is already at checkout, skip ALL room selection
        // Wait briefly for iframe content before checking checkout state
        const _earlyBookingFrame = await this.findBookingFrameWithContent(page, 2000);
        let _alreadyAtCheckoutEarly = false;
        if (_earlyBookingFrame) {
          if (await this.isAtCheckoutStep(_earlyBookingFrame)) {
            _alreadyAtCheckoutEarly = true;
            console.log("[RESERVATION][RESERVE] iframe already at checkout — skipping room selection");
          }
        }
        if (_alreadyAtCheckoutEarly) {
          // Fill checkout form directly if we have guest data
          const _hasGuestEarly = !!String(req.guest_name || "").trim() && !!String(req.guest_email || "").trim();
          if (_hasGuestEarly && _earlyBookingFrame) {
            console.log("[RESERVATION][STEP3-EARLY] Filling checkout form in booking widget iframe");
            const _checkoutFieldsEarly: Array<{ sel: string[]; val: string; label: string }> = [
              { label: "Собствено име", sel: ["input[placeholder*='Собствено']","input[name*='first']","input[id*='first']","input[placeholder*='First']"], val: String(req.guest_name || "").split(" ")[0] },
              { label: "Фамилия",       sel: ["input[placeholder*='Фамил']","input[name*='last']","input[id*='last']","input[placeholder*='Last']"], val: String(req.guest_name || "").split(" ").slice(1).join(" ") || String(req.guest_name || "") },
              { label: "ЕГН",           sel: ["input[placeholder*='ЕГН']","input[placeholder*='EGN']","input[name*='egn']","input[id*='egn']","input[name*='pid']","input[id*='pid']"], val: req.guest_egn || "" },
              { label: "Дата на раждане", sel: ["input[placeholder*='Дата']","input[placeholder*='Date']","input[name*='birth']","input[id*='birth']","input[name*='dob']"], val: req.guest_birthdate || "" },
              { label: "Номер на документ", sel: ["input[placeholder*='Номер на документ']","input[placeholder*='Document']","input[name*='doc']","input[id*='doc']","input[name*='passport']"], val: req.guest_doc_number || "" },
              { label: "E-mail",        sel: ["input[type='email']","input[placeholder*='mail']","input[name*='email']","input[id*='email']"], val: req.guest_email || "" },
              { label: "Телефон",       sel: ["input[type='tel']","input[placeholder*='елефон']","input[placeholder*='Phone']","input[name*='phone']","input[name*='tel']"], val: req.guest_phone || "" },
            ];
            for (const fld of _checkoutFieldsEarly) {
              if (!fld.val) continue;
              for (const sel of fld.sel) {
                try {
                  const loc = _earlyBookingFrame.locator(sel).first();
                  if (await loc.count().catch(() => 0) === 0) continue;
                  if (!(await loc.isVisible().catch(() => false))) continue;
                  await loc.scrollIntoViewIfNeeded().catch(() => {});
                  await loc.click({ timeout: 1500 }).catch(() => {});
                  await loc.fill(fld.val, { timeout: 1500 }).catch(() => {});
                  console.log(`[RESERVATION][STEP3-EARLY] Filled ${fld.label}`);
                  break;
                } catch {}
              }
            }
            // Check terms checkbox
            try {
              const chk = _earlyBookingFrame.locator("input[type='checkbox']").first();
              if (await chk.count().catch(() => 0) > 0 && !(await chk.isChecked().catch(() => false))) {
                await chk.check({ timeout: 1500 }).catch(() => {});
                console.log("[RESERVATION][STEP3-EARLY] Checked terms checkbox");
              }
            } catch {}
            const _ssEarly = await this.takeAvailabilityScreenshot(page);
            return {
              ok: true,
              stage: "reservation_reserve_checkout_filled",
              needs_input: false,
              missing_required: [],
              phase: "reserve",
              message: "reserve_checkout_filled",
              booking_url: page.url(),
              screenshot_base64: _ssEarly,
              observation: {
                url: page.url(),
                before_url: beforeUrl,
                room_type: req.room_type || "",
                room_selection_succeeded: true,
                current_step: "checkout_filled",
                missing_required: [],
                can_continue: true,
                payment_required: false,
                finalized: false,
              },
            };
          }
          // No guest data yet — ask for it
          const _ssE = await this.takeAvailabilityScreenshot(page);
          const _snE = await this.inferCurrentBookingStepNeeds(page);
          return {
            ok: true,
            phase: "reserve",
            message: "reserve_current_step_needs_input",
            booking_url: null as any,
            screenshot_base64: _ssE,
            observation: {
              url: beforeUrl,
              before_url: beforeUrl,
              room_type: req.room_type || "",
              room_selection_attempted: false,
              room_selection_succeeded: true,
              current_step: _snE.current_step,
              missing_required: _snE.missing_required,
              can_continue: _snE.can_continue,
              payment_required: _snE.payment_required,
              finalized: false,
            },
          };
        }


        // STEP 1: first select the chosen room on the CURRENT booking page / iframe context
        let roomSelectionAttempted = false;
        let roomSelectionSucceeded = false;

        if (req.room_type) {
          roomSelectionAttempted = true;

          const normRoom = String(req.room_type || "")
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[“”"']/g, " ")
            .replace(/[(){}\[\]:;,.!?/\\|<>+=_-]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

          const isBadRoomNavigation = (fromUrl: string, toUrl: string) => {
            if (!toUrl || toUrl === fromUrl) return false;
            // If booking widget query param was present and now gone → widget closed
            const hadWidget = /clock-pms-wbe|[?&]wbe=/.test(fromUrl);
            const hasWidget = /clock-pms-wbe|[?&]wbe=/.test(toUrl);
            if (hadWidget && !hasWidget) return true;
            // Navigation to room detail or accommodation listing pages
            const lower = toUrl.toLowerCase();
            return /\/room\//.test(lower) || /\/accommodation\//.test(lower);
          };

          // Capture Clock PMS iframe body BEFORE any clicks for change detection
          const _findBookingFrame = () => this.findBookingFrame(page);
          const _iframeSnapBefore = await (async () => {
            try {
              const bf = _findBookingFrame();
              return bf ? (await bf.locator("body").innerText().catch(() => "")).slice(0, 1200) : "";
            } catch { return ""; }
          })();

          const indicatesBookingProgress = async () => {
            const afterUrl = page.url();

            if (isBadRoomNavigation(beforeUrl, afterUrl)) {
              console.log(`[RESERVATION][ROOM] ignored navigation outside booking flow: ${afterUrl}`);
              try { await page.goBack({ waitUntil: "domcontentloaded", timeout: 5000 }); } catch {}
              await page.waitForTimeout(800).catch(() => {});
              return false;
            }

            // URL changed to a valid booking step → progress
            if (afterUrl !== beforeUrl && !isBadRoomNavigation(beforeUrl, afterUrl)) return true;

            // ✅ NEW: Check step indicator — if current step changed, we progressed
            try {
              const _bf2 = _findBookingFrame();
              const _ctx2 = (_bf2 as any) || page;
              const _newStepInfo = await this.readWidgetStepIndicator(_ctx2).catch(() => null);
              if (_newStepInfo && _newStepInfo.steps.length >= 2 && _newStepInfo.current_index > 0) {
                console.log(`[RESERVATION][ROOM] step indicator shows step ${_newStepInfo.current_index}/${_newStepInfo.total_steps-1}: "${_newStepInfo.current_step}" — booking progressed`);
                return true;
              }
            } catch {}

            // Primary: did the Clock PMS iframe content change?
            try {
              const bf = _findBookingFrame();
              if (bf) {
                const newSnap = (await bf.locator("body").innerText().catch(() => "")).slice(0, 1200);
                if (newSnap && _iframeSnapBefore && newSnap !== _iframeSnapBefore && newSnap.length > 100) {
                  console.log("[RESERVATION][ROOM] iframe content changed — booking progressed");
                  return true;
                }
                const newSnapLower = newSnap.toLowerCase();
                if (/тариф|standard.?rate|bb|нощувка\s*с\s*закуска|plan|покажи тарифите/i.test(newSnapLower) &&
                    !/апартамент.*апартамент.*апартамент/i.test(newSnapLower)) {
                  console.log("[RESERVATION][ROOM] tariff step detected in iframe — booking progressed");
                  return true;
                }
                if (/данни\s*за\s*контакт|guest\s*details|your\s*details/i.test(newSnapLower)) {
                  console.log("[RESERVATION][ROOM] checkout step detected in iframe — booking progressed");
                  return true;
                }
              }
            } catch {}

            // Fallback: guest input form appeared in main page (not iframe)
            const formVisible = await page.locator(
              'input[type="email"], input[name*="email"], input[name*="phone"], input[name*="tel"]'
            ).first().isVisible().catch(() => false);
            return formVisible;
          };

          const clickRoomInContext = async (ctx: any, label: string) => {
            const ctaSelectors = [
              `button:has-text("ПОКАЖИ ТАРИФИТЕ")`,
              `button:has-text("Покажи тарифите")`,
              `button:has-text("Тарифи")`,
              `button:has-text("Резервирай")`,
              `button:has-text("Избери")`,
              `button:has-text("Book")`,
              `button:has-text("Reserve")`,
              `button:has-text("Select")`,
              `button:has-text("Check rates")`,
              `button:has-text("Show rates")`,
              `[role="button"]:has-text("ПОКАЖИ ТАРИФИТЕ")`,
              `[role="button"]:has-text("Покажи тарифите")`,
              `[role="button"]:has-text("Резервирай")`,
              `[role="button"]:has-text("Избери")`,
              `[role="button"]:has-text("Book")`,
              `[role="button"]:has-text("Reserve")`,
              `[role="button"]:has-text("Select")`,
              `input[type="submit"]`,
              `input[type="button"]`,
              `button`,
              `[role="button"]`,
            ];

            const containerSelectors = [
              `article:has-text("${req.room_type}")`,
              `[class*="room"]:has-text("${req.room_type}")`,
              `[class*="rate"]:has-text("${req.room_type}")`,
              `[class*="card"]:has-text("${req.room_type}")`,
              `[class*="item"]:has-text("${req.room_type}")`,
              `li:has-text("${req.room_type}")`,
            ];


            for (const containerSel of containerSelectors) {
              const containers = ctx.locator(containerSel);
              const containerCount = Math.min(await containers.count().catch(() => 0), 4);
              for (let i = 0; i < containerCount; i++) {
                const container = containers.nth(i);
                const rawText = String(await container.innerText().catch(() => ""));
                const text = rawText.toLowerCase().replace(/\s+/g, " ").trim();

                console.log(
                  `[RESERVATION][ROOM][SCAN] label=${label} containerSel=${containerSel} idx=${i} text="${rawText.slice(0, 300).replace(/\s+/g, " ")}"`
                );

                if (!text || !roomTextMatches(rawText, String(req.room_type || ""))) continue;


                console.log(
                  `[RESERVATION][ROOM][MATCH] label=${label} containerSel=${containerSel} idx=${i} matched_room="${req.room_type}"`
                );


                for (const ctaSel of ctaSelectors) {
                  const ctas = container.locator(ctaSel);
                  const ctaCount = Math.min(await ctas.count().catch(() => 0), 4);
                  for (let j = 0; j < ctaCount; j++) {
                    const cta = ctas.nth(j);
                    const tag = await cta.evaluate((el: any) => el.tagName?.toLowerCase?.() || "").catch(() => "");
                    const debugLabel = await getClickableDebugLabel(cta);

                    if (tag === "a") {
                      console.log(
                        `[RESERVATION][ROOM][CTA][SKIP] label=${label} containerSel=${containerSel} ctaSel=${ctaSel} idx=${j} reason=anchor ${debugLabel}`
                      );
                      continue;
                    }

                    if (!(await cta.isVisible().catch(() => false))) {
                      console.log(
                        `[RESERVATION][ROOM][CTA][SKIP] label=${label} containerSel=${containerSel} ctaSel=${ctaSel} idx=${j} reason=hidden ${debugLabel}`
                      );
                      continue;
                    }

                    if (isBadClickableLabel(debugLabel)) {
                      console.log(
                        `[RESERVATION][ROOM][CTA][SKIP] label=${label} containerSel=${containerSel} ctaSel=${ctaSel} idx=${j} reason=bad_label ${debugLabel}`
                      );
                      continue;
                    }

                    console.log(
                      `[RESERVATION][ROOM][CTA][TRY] label=${label} containerSel=${containerSel} ctaSel=${ctaSel} idx=${j} ${debugLabel}`
                    );

                    await cta.scrollIntoViewIfNeeded().catch(() => {});
                    await cta.click({ timeout: 1800 }).catch(async () => {
                      console.log(
                        `[RESERVATION][ROOM][CTA][FALLBACK_DISPATCH] label=${label} containerSel=${containerSel} ctaSel=${ctaSel} idx=${j} ${debugLabel}`
                      );
                      await cta.dispatchEvent("click").catch(() => {});
                    });
                    // Wait longer for Clock PMS async view transition, then retry up to 4x
                    let progressed = false;
                    for (let _w = 0; _w < 3; _w++) {
                      await page.waitForTimeout(1000);
                      progressed = await indicatesBookingProgress();
                      if (progressed) break;
                      // Extra: check if iframe text changed since _iframeSnapBefore
                      try {
                        const _bf = _findBookingFrame();
                        if (_bf) {
                          const _snap = (await _bf.locator("body").innerText().catch(() => "")).slice(0, 2000);
                          if (_snap && _snap !== _iframeSnapBefore && _snap.length > 100) { progressed = true; break; }
                          // Clock PMS specific: after ПОКАЖИ ТАРИФИТЕ, ИЗБЕРИ button appears in the card
                          const _hasIzberi = await _bf.locator('button:has-text("ИЗБЕРИ"), button:has-text("Избери"), button:has-text("Choose"), button:has-text("Select rate")').count().catch(() => 0);
                          if (_hasIzberi > 0) { console.log("[RESERVATION][ROOM] ИЗБЕРИ button appeared — tariff loaded, progressed"); progressed = true; break; }
                        }
                      } catch {}
                    }
                    console.log(
                      `[RESERVATION][ROOM][CTA][RESULT] label=${label} containerSel=${containerSel} ctaSel=${ctaSel} idx=${j} progressed=${progressed} url="${page.url()}" ${debugLabel}`
                    );

                    if (progressed) {
                      console.log(`[RESERVATION][ROOM] selected via ${label} -> ${containerSel} :: ${ctaSel} ${debugLabel}`);
                      return true;
                    }
                  }
                }

                const fallbackButtons = container.locator(`button, [role="button"], a, input[type="button"], input[type="submit"]`);
                const fallbackCount = Math.min(await fallbackButtons.count().catch(() => 0), 5);

                for (let j = 0; j < fallbackCount; j++) {
                  const btn = fallbackButtons.nth(j);
                  const btnTag = await btn.evaluate((el: any) => el.tagName?.toLowerCase?.() || "").catch(() => "");
                  const debugLabel = await getClickableDebugLabel(btn);

                  if (!(await btn.isVisible().catch(() => false))) {
                    console.log(
                      `[RESERVATION][ROOM][FALLBACK][SKIP] label=${label} idx=${j} reason=hidden ${debugLabel}`
                    );
                    continue;
                  }

                  if (btnTag === "a") {
                    console.log(
                      `[RESERVATION][ROOM][FALLBACK][SKIP] label=${label} idx=${j} reason=anchor ${debugLabel}`
                    );
                    continue;
                  }

                  if (isBadClickableLabel(debugLabel)) {
                    console.log(
                      `[RESERVATION][ROOM][FALLBACK][SKIP] label=${label} idx=${j} reason=bad_label ${debugLabel}`
                    );
                    continue;
                  }

                  console.log(
                    `[RESERVATION][ROOM][FALLBACK][TRY] label=${label} idx=${j} ${debugLabel}`
                  );

                  await btn.scrollIntoViewIfNeeded().catch(() => {});
                  await btn.click({ timeout: 1800 }).catch(async () => {
                    console.log(`[RESERVATION][ROOM][FALLBACK][DISPATCH] label=${label} idx=${j} ${debugLabel}`);
                    await btn.dispatchEvent("click").catch(() => {});
                  });
                  let progressed = false;
                  for (let _w = 0; _w < 3; _w++) {
                    await page.waitForTimeout(900);
                    progressed = await indicatesBookingProgress();
                    if (progressed) break;
                    try {
                      const _bf = _findBookingFrame();
                      if (_bf) {
                        const _snap = (await _bf.locator("body").innerText().catch(() => "")).slice(0, 1200);
                        if (_snap && _snap !== _iframeSnapBefore && _snap.length > 100) { progressed = true; break; }
                      }
                    } catch {}
                  }
                  console.log(
                    `[RESERVATION][ROOM][FALLBACK][RESULT] label=${label} idx=${j} progressed=${progressed} url="${page.url()}" ${debugLabel}`
                  );

                  if (progressed) {
                    console.log(`[RESERVATION][ROOM] selected via ${label} -> fallback button in container ${debugLabel}`);
                    return true;
                  }
                }


              }
            }

            const directSelectors = [
              `button:has-text("${req.room_type}")`,
              `[role="button"]:has-text("${req.room_type}")`,
              `label:has-text("${req.room_type}")`,
              `a:has-text("${req.room_type}")`,
              `text="${req.room_type}"`,
            ];

            for (const sel of directSelectors) {
              const loc = ctx.locator(sel).first();
              const count = await ctx.locator(sel).count().catch(() => 0);
              console.log(`[RESERVATION][ROOM][DIRECT][SCAN] label=${label} sel=${sel} count=${count}`);
              if (!count) continue;
              if (!(await loc.isVisible().catch(() => false))) {
                console.log(`[RESERVATION][ROOM][DIRECT][SKIP] label=${label} sel=${sel} reason=hidden`);
                continue;
              }

              const directText = String(await loc.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
              console.log(`[RESERVATION][ROOM][DIRECT][TRY] label=${label} sel=${sel} text="${directText}"`);

              await loc.scrollIntoViewIfNeeded().catch(() => {});
              await loc.click({ timeout: 1500 }).catch(async () => {
                console.log(`[RESERVATION][ROOM][DIRECT][DISPATCH] label=${label} sel=${sel}`);
                await loc.dispatchEvent("click").catch(() => {});
              });
              let progressed = false;
              for (let _w = 0; _w < 3; _w++) {
                await page.waitForTimeout(1200);
                progressed = await indicatesBookingProgress();
                if (progressed) break;
                try {
                  const _bf = _findBookingFrame();
                  if (_bf) {
                    const _snap = (await _bf.locator("body").innerText().catch(() => "")).slice(0, 1200);
                    if (_snap && _snap !== _iframeSnapBefore && _snap.length > 100) { progressed = true; break; }
                  }
                } catch {}
              }
              console.log(`[RESERVATION][ROOM][DIRECT][RESULT] label=${label} sel=${sel} progressed=${progressed} url="${page.url()}"`);

              if (progressed) {
                console.log(`[RESERVATION][ROOM] selected via ${label} -> ${sel}`);
                return true;
              }
            }

            // ── FRAME-WIDE CTA SEARCH ────────────────────────────────────────
            // The target room may be unavailable — its card has no CTA buttons.
            // Search the ENTIRE booking frame for ANY available CTA button.
            // STRICTLY inside ctx (booking iframe) — never touches main page.
            console.log(`[RESERVATION][ROOM][FRAME_WIDE] label=${label} searching frame for available CTA`);

            // Priority 1: explicit "ПОКАЖИ ТАРИФИТЕ" in ANY available card
            const _pokażiSels = [
              'button:has-text("ПОКАЖИ ТАРИФИТЕ")',
              '[role="button"]:has-text("ПОКАЖИ ТАРИФИТЕ")',
              'button:has-text("Покажи тарифите")',
              'button:has-text("SHOW RATES")',
              'button:has-text("Check rates")',
            ];
            for (const _ps of _pokażiSels) {
              const _pbBtns = await ctx.locator(_ps).all().catch(() => []);
              for (const _pb of _pbBtns) {
                if (!(await _pb.isVisible().catch(() => false))) continue;
                // Ensure it's NOT inside an "Не е налично" card
                const _unavail = await _pb.evaluate((el: any): boolean => {
                  let p: Element | null = el;
                  for (let i = 0; i < 8 && p; i++) {
                    if (/не\s*е\s*налично|not\s*available|sold.?out/i.test(
                      ((p as any).innerText || "").slice(0, 400))) return true;
                    p = p.parentElement;
                  }
                  return false;
                }).catch(() => false);
                if (_unavail) continue;
                await _pb.scrollIntoViewIfNeeded().catch(() => {});
                await _pb.click({ timeout: 2000 }).catch(async () => {
                  await _pb.dispatchEvent("click").catch(() => {});
                });
                console.log(`[RESERVATION][ROOM][FRAME_WIDE] ✓ Clicked "${_ps}" in available card`);
                await page.waitForTimeout(1500);
                // optimistic: navigateBookingWidgetToCheckout takes it from here
                return true;
              }
            }

            // Priority 2: ANY visible non-icon non-calendar button in the frame
            // that is NOT inside an unavailable card
            const _allFrameBtns = await ctx.locator("button, [role='button']").all().catch(() => []);
            for (const _fb of _allFrameBtns) {
              const _ft = (await _fb.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
              if (!_ft || isBadClickableLabel(_ft)) continue;
              if (/календар|заетост|calendar/i.test(_ft)) continue;
              if (!(await _fb.isVisible().catch(() => false))) continue;
              const _unavail = await _fb.evaluate((el: any): boolean => {
                let p: Element | null = el;
                for (let i = 0; i < 8 && p; i++) {
                  if (/не\s*е\s*налично|not\s*available|sold.?out/i.test(
                    ((p as any).innerText || "").slice(0, 400))) return true;
                  p = p.parentElement;
                }
                return false;
              }).catch(() => false);
              if (_unavail) continue;
              await _fb.scrollIntoViewIfNeeded().catch(() => {});
              await _fb.click({ timeout: 2000 }).catch(async () => {
                await _fb.dispatchEvent("click").catch(() => {});
              });
              console.log(`[RESERVATION][ROOM][FRAME_WIDE] ✓ Clicked fallback btn: "${_ft}"`);
              await page.waitForTimeout(1500);
              return true;
            }

            return false;
          };

          const frames = page.frames().filter((f) => f !== page.mainFrame());

          // Try ALL non-analytics frames, prioritizing known booking patterns
          const _analyticsPattern = /google\.com\/maps|google\.com\/recaptcha|facebook\.com|youtube\.com|analytics|gtm\.|pixel\.|adsbygoogle|doubleclick/i;
          const _knownPatterns = ["clock", "wbe", "beds24", "cloudbeds", "mews", "sabee", "littlehotelier", "hotelrunner", "bookero", "amelia", "quendoo", "booking", "reserv", "checkout", "availability", "widget"];
          const bookingFrames = frames
            .filter(f => !_analyticsPattern.test(f.url()))
            .sort((a, b) => {
              const aHay = (String(a.name?.() || "") + " " + a.url()).toLowerCase();
              const bHay = (String(b.name?.() || "") + " " + b.url()).toLowerCase();
              const aScore = _knownPatterns.some(p => aHay.includes(p)) ? 1 : 0;
              const bScore = _knownPatterns.some(p => bHay.includes(p)) ? 1 : 0;
              return bScore - aScore; // known patterns first
            });

          for (const frame of bookingFrames) {
            const frameUrl = String(frame.url() || "");
            const frameName = String((frame as any).name?.() || "");
            const label = `frame(${frameName || frameUrl.slice(0, 60) || "unknown"})`;
            if (await clickRoomInContext(frame as any, label)) {
              roomSelectionSucceeded = true;
              break;
            }
          }

          if (!roomSelectionSucceeded && bookingFrames.length === 0) {
            const bookingLikeContainers = [
              'form',
              '[class*="booking"]',
              '[class*="reservation"]',
              '[class*="widget"]',
              '[id*="booking"]',
              '[id*="reservation"]',
            ];

            for (const rootSel of bookingLikeContainers) {
              const root = page.locator(rootSel).first();
              const count = await page.locator(rootSel).count().catch(() => 0);
              if (!count) continue;
              const visible = await root.isVisible().catch(() => false);
              if (!visible) continue;

              const scopedCtx = {
                locator: (sel: string) => root.locator(sel),
              };

              if (await clickRoomInContext(scopedCtx, `page-root(${rootSel})`)) {
                roomSelectionSucceeded = true;
                break;
              }
            }
          }



          if (!roomSelectionSucceeded) {
            console.log("[RESERVATION][ROOM] safe room click not confirmed inside booking context");
          }
        }

        const currentUrlAfterRoom = page.url();
        const bodySnippetAfterRoom = String(await page.locator("body").innerText().catch(() => ""))
          .replace(/\s+/g, " ")
          .slice(0, 1200);
        console.log(`[RESERVATION][AFTER_ROOM] url=${currentUrlAfterRoom} body="${bodySnippetAfterRoom}"`);

        // NOTE: Do NOT call inferCurrentBookingStepNeeds here — checkout form is not yet loaded.
        // We take screenshot early for error paths only.

        if (roomSelectionAttempted && !roomSelectionSucceeded) {
          // For Clock PMS iframes: attempt full navigation regardless —
          // the room click may have changed the iframe state without triggering indicatesBookingProgress
          const hasBookingFrame = !!this.findBookingFrame(page);
          if (hasBookingFrame) {
            console.log("[RESERVATION][ROOM] room click unconfirmed but booking iframe present — attempting navigateBookingWidgetToCheckout");
            const reachedCheckout = await this.navigateBookingWidgetToCheckout(page, guests);
            console.log(`[RESERVATION] Clock PMS navigator result: reachedCheckout=${reachedCheckout}`);
            if (reachedCheckout) roomSelectionSucceeded = true;
            await page.waitForTimeout(500);
          }

          if (!roomSelectionSucceeded) {
            const screenshotRoomFail = await this.takeAvailabilityScreenshot(page);
            const stepNeedsRoomFail = await this.inferCurrentBookingStepNeeds(page);
            return {
              ok: false,
              phase: "reserve",
              message: "room_selection_not_confirmed",
              booking_url: "",
              screenshot_base64: screenshotRoomFail,
              observation: {
                url: page.url(),
                before_url: beforeUrl,
                room_type: req.room_type || "",
                current_step: stepNeedsRoomFail.current_step,
                missing_required: stepNeedsRoomFail.missing_required,
                can_continue: stepNeedsRoomFail.can_continue,
                payment_required: stepNeedsRoomFail.payment_required,
                finalized: false,
              },
            };
          }
        }

        // Navigate Clock PMS through Tariff step to Checkout step (only if not already navigated via fallback gate)
        if (roomSelectionSucceeded) {
          const _alreadyAtCheckout = await (async () => {
            const _bf2 = this.findBookingFrame(page);
            if (!_bf2) return false;
            return await this.isAtCheckoutStep(_bf2);
          })();
          if (!_alreadyAtCheckout) {
            const reachedCheckout = await this.navigateBookingWidgetToCheckout(page, guests);
            console.log(`[RESERVATION] Clock PMS navigator (2nd call guard): reachedCheckout=${reachedCheckout}`);
            await page.waitForTimeout(500);
          } else {
            console.log('[RESERVATION] Already at checkout — skipping duplicate navigateBookingWidgetToCheckout');
          }
        }

        // ✅ FIX v9: Scan AFTER checkout navigation using universalGetMissingRequired (scans iframe!)
        await page.waitForTimeout(800); // allow checkout form to fully render
        const screenshotAfterRoom = await this.takeAvailabilityScreenshot(page);

        // ✅ universalGetMissingRequired сканира Clock PMS iframe правилно
        const stepNeedsAfterRoom = await this.universalGetMissingRequired(page);
        console.log(`[RESERVATION][STEP-NEEDS-POST-NAV] missing=${stepNeedsAfterRoom.missing_required.join(" | ") || "none"} step=${stepNeedsAfterRoom.current_step} checkout=${stepNeedsAfterRoom.is_checkout_step}`);

        // Ако scan-ът не намери нищо (e.g. iframe още не е зареден), използвай fallback от step indicator
        const _stepBar = await this.readWidgetStepIndicator(this.findBookingFrame(page) || page).catch(() => null);
        if (_stepBar) console.log(`[RESERVATION][STEP-BAR] ${_stepBar.raw_text} current="${_stepBar.current_step}"`);

        // Ако missing_required е празен НО checkout формата още не е там — значи сме на стъпка ПРЕДИ checkout
        // В Clock PMS: ако stepBar показва "СТАИ" или "ТАРИФИ" → still navigating
        const _stillNavigating = _stepBar && _stepBar.steps.length >= 2 && !_stepBar.is_checkout && !_stepBar.is_last_step;
        const _missingToReport = stepNeedsAfterRoom.missing_required.length > 0
          ? stepNeedsAfterRoom.missing_required
          : (_stillNavigating
            // Не сме стигнали до checkout — ще опитаме пак при следващо reserve повикване
            ? []
            // Стигнали сме до checkout но scan е върнал [] — правим explicit списък с ЗАДЪЛЖИТЕЛНИ гост полета
            : ["Собствено иme", "Фамилия", "Имейл", "Телефон"]);

        // STEP 2: after room selection, return the REAL missing fields from the current booking step
        const hasGuestIdentity =
          !!String(req.guest_name || "").trim() &&
          !!String(req.guest_email || "").trim() &&
          !!String(req.guest_phone || "").trim();

        if (req.room_type && !hasGuestIdentity) {
          return {
            ok: true,
            // ✅ top-level fields — frontend ги чете директно (не само от observation)
            stage: "reservation_reserve_needs_input",
            needs_input: true,
            missing_required: _missingToReport,
            selected_room_type: req.room_type || "",
            phase: "reserve",
            message: "reserve_current_step_needs_input",
            booking_url: stepNeedsAfterRoom.payment_required ? currentUrlAfterRoom : null,
            screenshot_base64: screenshotAfterRoom,
            observation: {
              stage: "reservation_reserve_needs_input",
              needs_input: true,
              url: currentUrlAfterRoom,
              before_url: beforeUrl,
              room_type: req.room_type || "",
              room_selection_attempted: roomSelectionAttempted,
              room_selection_succeeded: roomSelectionSucceeded,
              current_step: stepNeedsAfterRoom.current_step,
              missing_required: _missingToReport,
              can_continue: false,
              payment_required: stepNeedsAfterRoom.payment_required,
              finalized: false,
            },
          };
        }

        // STEP 3: fill personal data — UNIVERSAL ENGINE FIRST, then Clock PMS iframe fallback
        const _clockFrame = this.findBookingFrame(page);
        let _iframeCheckoutFilled = false;

        // ✅ PRIMARY: Universal fill engine — works with ANY widget
        if (_clockFrame || req.guest_name || req.guest_email) {
          const _fillCtx = _clockFrame || page;
          console.log("[RESERVATION][STEP3] Using universal fill engine");

          const guestPayload = {
            full_name:  req.guest_name || "",
            email:      req.guest_email || "",
            phone:      req.guest_phone || "",
            egn:        req.guest_egn || "",
            birthdate:  req.guest_birthdate || "",
            gender:     req.guest_gender || "",
            country:    req.guest_country || "",
            doc_type:   req.guest_doc_type || "",
            doc_number: req.guest_doc_number || "",
            message:    req.guest_message || "",
          };

          const filledFields = await this.universalFillKnownFields(_fillCtx, page, guestPayload);

          if (filledFields.length > 0) {
            _iframeCheckoutFilled = true;
            console.log(`[RESERVATION][STEP3][UNIVERSAL] Filled ${filledFields.length} fields: ${filledFields.join(" | ")}`);
          }

          // Check for terms checkbox if not filled
          if (_clockFrame) {
            try {
              const chk = _clockFrame.locator("input[type='checkbox']").first();
              if (await chk.count().catch(() => 0) > 0 && !(await chk.isChecked().catch(() => false))) {
                await chk.check({ timeout: 1500 }).catch(() => {});
                console.log("[RESERVATION][STEP3][UNIVERSAL] Checked terms checkbox");
              }
            } catch {}
          }

          // After universal fill — check what's still missing using universalGetMissingRequired
          if (filledFields.length > 0 || req.guest_name) {
            await page.waitForTimeout(500);
            const _stepAfterFill = await this.universalGetMissingRequired(page);
            console.log(`[RESERVATION][STEP3][AFTER_FILL] missing=${_stepAfterFill.missing_required.join(" | ") || "none"}`);

            if (_stepAfterFill.missing_required.length > 0) {
              return {
                ok: true,
                stage: "reservation_reserve_needs_input",
                needs_input: true,
                missing_required: _stepAfterFill.missing_required,
                phase: "reserve",
                message: "reserve_current_step_needs_input",
                booking_url: null,
                screenshot_base64: screenshotAfterRoom,
                observation: {
                  stage: "reservation_reserve_needs_input",
                  needs_input: true,
                  missing_required: _stepAfterFill.missing_required,
                  current_step: _stepAfterFill.current_step,
                  can_continue: false,
                },
              };
            }

            const _finalUrl = page.url();
            return {
              ok: true,
              stage: "reservation_reserve_checkout_filled",
              needs_input: false,
              missing_required: [],
              selected_room_type: req.room_type || "",
              phase: "reserve",
              message: "reserve_checkout_filled",
              booking_url: _finalUrl,
              observation: {
                stage: "reservation_reserve_checkout_filled",
                needs_input: false,
                missing_required: [],
                current_step: "checkout_filled",
                can_continue: true,
              },
            };
          }
        }
          // ── FALLBACK: Clock PMS specific selector-based fill (if universal engine filled nothing) ──
          if (!_iframeCheckoutFilled && _clockFrame && req.guest_name) {
          console.log("[RESERVATION][STEP3][FALLBACK] Using Clock PMS selector-based fill");
          const _checkoutFields: Array<{ sel: string[]; val: string; label: string }> = [
            { label: "Собствено име",  sel: ["input[placeholder*='Собствено']", "input[name*='first']", "input[name*='given']", "input[id*='first']", "input[placeholder*='First']"], val: String(req.guest_name || "").split(" ")[0] },
            { label: "Фамилия",        sel: ["input[placeholder*='Фамил']", "input[name*='last']", "input[name*='family']", "input[id*='last']", "input[placeholder*='Last']"], val: String(req.guest_name || "").split(" ").slice(1).join(" ") || String(req.guest_name || "") },
            { label: "ЕГН",            sel: ["input[placeholder*='ЕГН']", "input[placeholder*='EGN']", "input[name*='egn']", "input[id*='egn']", "input[name*='pid']", "input[id*='pid']"], val: req.guest_egn || "" },
            { label: "Дата на раждане", sel: ["input[placeholder*='Дата']", "input[placeholder*='Date of birth']", "input[name*='birth']", "input[id*='birth']", "input[name*='dob']"], val: req.guest_birthdate || "" },
            { label: "Номер на документ", sel: ["input[placeholder*='Номер на документ']", "input[placeholder*='Document']", "input[name*='doc']", "input[id*='doc']", "input[name*='passport']", "input[placeholder*='Passport']"], val: req.guest_doc_number || "" },
            { label: "E-mail",         sel: ["input[type='email']", "input[placeholder*='mail']", "input[placeholder*='Mail']", "input[name*='email']", "input[id*='email']"], val: req.guest_email || "" },
            { label: "Телефон",        sel: ["input[type='tel']", "input[placeholder*='елефон']", "input[placeholder*='Phone']", "input[name*='phone']", "input[name*='tel']", "input[id*='phone']"], val: req.guest_phone || "" },
          ];
          let _filledCount = 0;
          for (const fld of _checkoutFields) {
            if (!fld.val) continue;
            for (const sel of fld.sel) {
              try {
                const loc = _clockFrame.locator(sel).first();
                if (await loc.count().catch(() => 0) === 0) continue;
                if (!(await loc.isVisible().catch(() => false))) continue;
                await loc.scrollIntoViewIfNeeded().catch(() => {});
                await loc.click({ clickCount: 3, timeout: 1500 }).catch(() => {});
                await loc.fill(fld.val, { timeout: 1500 }).catch(() => {});
                await _clockFrame.evaluate(({ sel, val }: { sel: string; val: string }) => {
                  const el = document.querySelector(sel) as HTMLInputElement | null;
                  if (!el) return;
                  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
                  if (nativeInputValueSetter) nativeInputValueSetter.call(el, val);
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
                }, { sel, val: fld.val }).catch(() => {});
                await page.waitForTimeout(100);
                console.log(`[RESERVATION][STEP3][FALLBACK] Filled ${fld.label}: ${fld.val.slice(0,20)}`);
                _filledCount++;
                break;
              } catch {}
            }
          }
          // Accept terms checkbox if present
          try {
            const chk = _clockFrame.locator("input[type='checkbox']").first();
            if (await chk.count().catch(() => 0) > 0 && !(await chk.isChecked().catch(() => false))) {
              await chk.check({ timeout: 1500 }).catch(() => {});
              console.log("[RESERVATION][STEP3][FALLBACK] Checked terms checkbox");
            }
          } catch {}
          if (_filledCount > 0) {
            _iframeCheckoutFilled = true;
            console.log(`[RESERVATION][STEP3][FALLBACK] Filled ${_filledCount} fields`);
          }

          if (_iframeCheckoutFilled) {
            await page.waitForTimeout(400);
            const _stepAfterFill = await this.inferCurrentBookingStepNeeds(page);
            console.log(`[RESERVATION][STEP3][FALLBACK] After fill: missing=${_stepAfterFill.missing_required.join(" | ") || "none"}`);
            if (_stepAfterFill.missing_required.length > 0) {
              return {
                ok: true, phase: "reserve",
                message: "reserve_current_step_needs_input",
                booking_url: "", screenshot_base64: screenshotAfterRoom,
                observation: {
                  stage: "reservation_reserve_needs_input",
                  needs_input: true,
                  missing_required: _stepAfterFill.missing_required,
                  current_step: "reserve", can_continue: false,
                },
              };
            }
            const _finalUrl = page.url();
            return {
              ok: true, phase: "reserve",
              message: "reserve_checkout_filled",
              booking_url: _finalUrl,
              observation: {
                stage: "reservation_reserve_checkout_filled",
                needs_input: false, missing_required: [],
                current_step: "checkout_filled", can_continue: true,
              },
            };
          }
          }

        const formSchema = session.formSchemas.find(
          (s) => s.kind === "form" || s.kind === "wizard"
        );

        // Only use schema-based fill if all above fill methods did not work
        if (!_iframeCheckoutFilled && formSchema) {
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
        // ✅ v9: use universalGetMissingRequired (scans iframe)
        const stepNeeds = await this.universalGetMissingRequired(page);

        return {
          ok: true,
          stage: stepNeeds.missing_required.length > 0 ? "reservation_reserve_needs_input" : "reservation_reserve_result",
          needs_input: stepNeeds.missing_required.length > 0,
          missing_required: stepNeeds.missing_required,
          phase: "reserve",
          message: "no_form_schema_found_current_step_preserved",
          booking_url: stepNeeds.payment_required ? currentUrl : null,
          screenshot_base64,
          observation: {
            ...(obs || {}),
            url: currentUrl,
            confirmed_price: req.confirmed_price || "",
            room_type: req.room_type || "",
            current_step: stepNeeds.current_step,
            missing_required: stepNeeds.missing_required,
            can_continue: stepNeeds.can_continue,
            payment_required: stepNeeds.payment_required,
            finalized: false,
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
      version: "10.0.0",
      build: "neo-worker_v13-0_form-only_2026-03-20",
      mode: "form-fill-only",
      has_make_reservation: false,
      has_universal_widget_engine: false,
      reservations: "google-calendar",
    });
  });

   app.get("/health", (_, res) => {
    res.json({
      status: "ok",
      version: "10.0.0",
      build: "neo-worker_v13-0_form-only_2026-03-20",
      has_make_reservation: false,
      has_universal_widget_engine: false,
      reservations: "google-calendar",
      ...manager.getStatus()
    });
  });

  app.get("/__routes", (_, res) => {
    res.json({
      success: true,
      version: "10.0.0",
      build: "neo-worker_v12-1_ts_fixes_2026-03-15",
      routes: [
        "GET /",
        "GET /health",
        "GET /__routes",
        "POST /prepare-session",
        "POST /fill-form",
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

  // ── /check-availability: DISABLED — reservations now handled via Google Calendar ──
  app.post("/check-availability", (_req: Request, res: Response) => {
    console.log("[HTTP][/check-availability] DISABLED — reservations via Google Calendar");
    res.status(410).json({
      success: false,
      disabled: true,
      message: "check-availability is disabled. Reservations are now managed via Google Calendar.",
    });
  });

  // ── /make-reservation: DISABLED — reservations now handled via Google Calendar ──
  app.post("/make-reservation", (_req: Request, res: Response) => {
    console.log("[HTTP][/make-reservation] DISABLED — reservations via Google Calendar");
    res.status(410).json({
      success: false,
      disabled: true,
      message: "make-reservation is disabled. Reservations are now managed via Google Calendar.",
    });
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
    console.log(`🚀 NEO Worker v13.0.0 listening on :${PORT}`);
    console.log(`[BOOT] build=neo-worker_v13-0_form-only_2026-03-20 port=${PORT}`);
    console.log(`[BOOT] mode=form-fill-only reservations=google-calendar`);
    console.log(`[BOOT] routes=GET /, GET /health, GET /__routes, POST /prepare-session, POST /fill-form, POST /execute, GET /forms/:sessionId, POST /refresh-forms, POST /close-session`);
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
