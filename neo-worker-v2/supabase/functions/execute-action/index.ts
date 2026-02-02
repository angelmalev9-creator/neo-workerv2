/**
 * EXECUTE-ACTION v2 - Supabase Edge Function
 * 
 * Комуникира с NEO Worker на Render за browser автоматизация.
 * 
 * ENV VARIABLES (Supabase Secrets):
 * - NEO_WORKER_URL = https://твоя-app.onrender.com
 * - NEO_WORKER_SECRET = същата-парола-като-в-render
 * 
 * Вече са налични автоматично:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ═══════════════════════════════════════════════════════════════
// CORS
// ═══════════════════════════════════════════════════════════════

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const NEO_WORKER_URL = Deno.env.get("NEO_WORKER_URL") || "https://neo-worker.onrender.com";
const NEO_WORKER_SECRET = Deno.env.get("NEO_WORKER_SECRET") || "";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface CommandRequest {
  // Нов формат - прости команди
  command?: "open" | "look" | "click" | "fill" | "submit" | "screenshot" | "close" | "status" | "refresh";
  url?: string;
  target?: string;
  value?: string;
  sessionId?: string;

  // Стар формат - за обратна съвместимост
  type?: string;
  payload?: Record<string, unknown>;

  // Мета
  meta?: {
    owner_id?: string;
    conversation_id?: string;
    session_id?: string;
    site_url?: string;
    log?: boolean; // дали да записва в базата
  };
}

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const body: CommandRequest = await req.json();
    
    console.log(`[execute-action] Received:`, body.command || body.type);

    // ═══════════════════════════════════════════════════════════
    // НОВ ФОРМАТ - Прости команди (препоръчителен)
    // ═══════════════════════════════════════════════════════════
    
    if (body.command) {
      const workerCommand = {
        action: body.command,
        url: body.url,
        target: body.target,
        value: body.value,
        sessionId: body.sessionId || body.meta?.session_id
      };

      const result = await callWorker(workerCommand);
      result.timing = Date.now() - startTime;

      // Опционално логване
      if (body.meta?.log !== false && body.meta?.session_id) {
        await logToDatabase(body, result);
      }

      return jsonResponse(result);
    }

    // ═══════════════════════════════════════════════════════════
    // СТАР ФОРМАТ - За обратна съвместимост
    // ═══════════════════════════════════════════════════════════
    
    if (body.type) {
      const result = await handleLegacyAction(body.type, body.payload || {}, body.meta);
      result.timing = Date.now() - startTime;
      return jsonResponse(result);
    }

    return jsonResponse({
      success: false,
      error: "Missing 'command' or 'type' in request body"
    }, 400);

  } catch (error) {
    console.error("[execute-action] Error:", error);
    return jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      timing: Date.now() - startTime
    }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════
// WORKER COMMUNICATION
// ═══════════════════════════════════════════════════════════════

async function callWorker(command: any): Promise<any> {
  console.log(`[execute-action] Calling worker: ${command.action}`);

  const response = await fetch(`${NEO_WORKER_URL}/command`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${NEO_WORKER_SECRET}`
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ═══════════════════════════════════════════════════════════════
// LEGACY ACTION HANDLING (стар формат)
// ═══════════════════════════════════════════════════════════════

async function handleLegacyAction(
  type: string, 
  payload: Record<string, unknown>,
  meta?: CommandRequest["meta"]
): Promise<any> {
  const url = payload.url as string;
  const sessionId = meta?.session_id;
  
  console.log(`[execute-action] Legacy action: ${type}`);

  switch (type) {
    // ─────────────────────────────────────────────────────────
    // AVAILABILITY CHECK
    // ─────────────────────────────────────────────────────────
    case "autoAvailability":
    case "availability":
    case "checkAvailability": {
      // 1. Отвори сайта
      const openResult = await callWorker({ action: "open", url, sessionId });
      if (!openResult.success) return openResult;

      // 2. Виж какво има
      const lookResult = await callWorker({ action: "look", sessionId });
      if (!lookResult.success) return lookResult;

      // 3. Ако има бутон за наличност - кликни
      const buttons = lookResult.data?.buttons || [];
      const availBtn = buttons.find((b: any) => 
        /наличност|availability|check|провери|search|търси|show|покажи|rates|цени/i.test(b.text)
      );

      if (availBtn) {
        const clickResult = await callWorker({ 
          action: "click", 
          target: availBtn.selector,
          sessionId 
        });
        
        // Сканирай отново
        const afterClick = await callWorker({ action: "look", sessionId });
        
        return {
          success: true,
          actionType: type,
          steps: [openResult, lookResult, clickResult, afterClick],
          result: afterClick,
          facts: {
            slotsAvailable: (afterClick.data?.prices?.length || 0) > 0 || 
                           (afterClick.data?.rooms?.length || 0) > 0,
            pricesFound: afterClick.data?.prices || [],
            roomsFound: afterClick.data?.rooms || []
          }
        };
      }

      return {
        success: true,
        actionType: type,
        steps: [openResult, lookResult],
        result: lookResult,
        facts: {
          slotsAvailable: (lookResult.data?.prices?.length || 0) > 0,
          pricesFound: lookResult.data?.prices || [],
          roomsFound: lookResult.data?.rooms || []
        }
      };
    }

    // ─────────────────────────────────────────────────────────
    // EXPLORE BOOKING
    // ─────────────────────────────────────────────────────────
    case "exploreBooking":
    case "explore_booking": {
      const openResult = await callWorker({ action: "open", url, sessionId });
      if (!openResult.success) return openResult;

      const lookResult = await callWorker({ action: "look", sessionId });
      
      return {
        success: true,
        actionType: type,
        steps: [openResult, lookResult],
        result: lookResult,
        facts: {
          hasForm: (lookResult.data?.forms || 0) > 0,
          hasInputs: (lookResult.data?.inputs?.length || 0) > 0,
          hasExternalSystem: (lookResult.data?.iframes?.length || 0) > 0
        }
      };
    }

    // ─────────────────────────────────────────────────────────
    // ASSISTED BOOKING
    // ─────────────────────────────────────────────────────────
    case "assistedBooking":
    case "assisted_booking": {
      const steps: any[] = [];
      
      // 1. Отвори
      const openResult = await callWorker({ action: "open", url, sessionId });
      steps.push(openResult);
      if (!openResult.success) return { success: false, steps, error: openResult.error };

      // 2. Сканирай
      const lookResult = await callWorker({ action: "look", sessionId });
      steps.push(lookResult);

      // 3. Попълни полета ако има
      const fieldsToFill = [
        { key: "name", targets: ["name", "име", "full_name", "fullname", "guest"] },
        { key: "email", targets: ["email", "имейл", "e-mail", "mail"] },
        { key: "phone", targets: ["phone", "телефон", "tel", "mobile"] },
        { key: "guests", targets: ["guests", "гости", "adults", "възрастни"] },
        { key: "checkin", targets: ["checkin", "check-in", "arrival", "от", "from"] },
        { key: "checkout", targets: ["checkout", "check-out", "departure", "до", "to"] },
      ];

      for (const field of fieldsToFill) {
        const value = payload[field.key] as string;
        if (value) {
          // Намери подходящо поле
          const inputs = lookResult.data?.inputs || [];
          const matchingInput = inputs.find((inp: any) => 
            field.targets.some(t => 
              inp.name?.toLowerCase().includes(t) || 
              inp.placeholder?.toLowerCase().includes(t)
            )
          );

          if (matchingInput) {
            const fillResult = await callWorker({ 
              action: "fill", 
              target: matchingInput.selector,
              value,
              sessionId 
            });
            steps.push(fillResult);
          }
        }
      }

      // 4. Submit ако е execute mode
      if (payload.mode === "execute") {
        const submitResult = await callWorker({ action: "submit", sessionId });
        steps.push(submitResult);

        // Сканирай за потвърждение
        const afterSubmit = await callWorker({ action: "look", sessionId });
        steps.push(afterSubmit);

        return {
          success: submitResult.success,
          actionType: type,
          steps,
          result: afterSubmit,
          facts: {
            submitted: submitResult.success,
            possibleConfirmation: submitResult.data?.possibleSuccess || false
          }
        };
      }

      // Preview mode
      return {
        success: true,
        actionType: type,
        mode: "preview",
        steps,
        result: lookResult,
        facts: {
          formReady: true,
          fieldsFound: lookResult.data?.inputs?.length || 0
        }
      };
    }

    // ─────────────────────────────────────────────────────────
    // DEFAULT
    // ─────────────────────────────────────────────────────────
    default: {
      // Просто отвори и сканирай
      const openResult = await callWorker({ action: "open", url, sessionId });
      if (!openResult.success) return openResult;

      const lookResult = await callWorker({ action: "look", sessionId });
      
      return {
        success: true,
        actionType: type,
        steps: [openResult, lookResult],
        result: lookResult
      };
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

async function logToDatabase(request: CommandRequest, result: any): Promise<void> {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    await supabase.from("actions_log").insert({
      action_type: request.command || request.type,
      session_id: request.meta?.session_id,
      owner_id: request.meta?.owner_id,
      conversation_id: request.meta?.conversation_id,
      status: result.success ? "success" : "failed",
      payload: { command: request.command, url: request.url, target: request.target },
      result: result
    });
  } catch (e) {
    console.error("[execute-action] Failed to log:", e);
  }
}
