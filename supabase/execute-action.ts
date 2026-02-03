/**
 * EXECUTE-ACTION (Supabase Edge Function)
 * 
 * Нова версия - комуникира с persistent worker
 * Вместо да пали браузър всеки път, праща команди към вече отворен браузър
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Worker URL (Render)
const WORKER_URL = Deno.env.get("NEO_WORKER_URL") || "https://neo-worker.onrender.com";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface ActionRequest {
  // Нов формат - прости команди
  command?: "open" | "look" | "click" | "fill" | "submit" | "screenshot" | "close";
  target?: string;
  value?: string;
  url?: string;
  
  // Стар формат - за обратна съвместимост
  type?: string;
  payload?: Record<string, unknown>;
  
  // Мета информация
  meta?: {
    session_id?: string;
    owner_id?: string;
    conversation_id?: string;
  };
}

// ═══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const body: ActionRequest = await req.json();
    
    // ═══════════════════════════════════════════════════════════
    // НОВИЯТ НАЧИН - Прости команди
    // ═══════════════════════════════════════════════════════════
    
    if (body.command) {
      console.log(`[execute-action] Command: ${body.command}`);
      
      // Построй команда за worker-а
      const workerCommand = buildWorkerCommand(body);
      
      // Изпрати към worker-а
      const response = await fetch(`${WORKER_URL}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workerCommand),
      });
      
      const result = await response.json();
      
      // Логвай в базата (по желание)
      if (body.meta?.session_id) {
        await logAction(supabase, {
          session_id: body.meta.session_id,
          command: body.command,
          result: result.success ? "success" : "failed",
          data: result.data
        });
      }
      
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    
    // ═══════════════════════════════════════════════════════════
    // СТАРИЯТ НАЧИН - За обратна съвместимост
    // ═══════════════════════════════════════════════════════════
    
    if (body.type) {
      console.log(`[execute-action] Legacy type: ${body.type}`);
      
      // Конвертирай стария формат към нов
      const commands = convertLegacyAction(body.type, body.payload || {});
      
      // Изпълни всички команди последователно
      const results = [];
      for (const cmd of commands) {
        const response = await fetch(`${WORKER_URL}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cmd),
        });
        results.push(await response.json());
        
        // Ако някоя команда се провали, спри
        if (!results[results.length - 1].success) break;
      }
      
      const lastResult = results[results.length - 1];
      
      return new Response(JSON.stringify({
        success: lastResult.success,
        actionType: body.type,
        steps: results,
        result: lastResult
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    
    return new Response(JSON.stringify({
      success: false,
      error: "Missing 'command' or 'type'"
    }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[execute-action] Error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function buildWorkerCommand(body: ActionRequest) {
  switch (body.command) {
    case "open":
      return { action: "open", url: body.url };
    case "look":
      return { action: "look" };
    case "click":
      return { action: "click", target: body.target };
    case "fill":
      return { action: "fill", target: body.target, value: body.value };
    case "submit":
      return { action: "submit" };
    case "screenshot":
      return { action: "screenshot" };
    case "close":
      return { action: "close" };
    default:
      return { action: body.command };
  }
}

// Конвертирай старите action типове към нови команди
function convertLegacyAction(type: string, payload: Record<string, unknown>) {
  const url = payload.url as string;
  
  switch (type) {
    case "autoAvailability":
    case "availability":
      // Стара логика: отвори → сканирай → кликни ако има бутон
      return [
        { action: "open", url },
        { action: "look" }
      ];
    
    case "exploreBooking":
    case "explore_booking":
      return [
        { action: "open", url },
        { action: "look" }
      ];
    
    case "assistedBooking":
    case "assisted_booking":
      // Ако има данни за попълване
      const commands: any[] = [
        { action: "open", url },
        { action: "look" }
      ];
      
      if (payload.name) {
        commands.push({ action: "fill", target: "name", value: payload.name });
      }
      if (payload.email) {
        commands.push({ action: "fill", target: "email", value: payload.email });
      }
      if (payload.mode === "execute") {
        commands.push({ action: "submit" });
      }
      
      return commands;
    
    default:
      return [{ action: "open", url }, { action: "look" }];
  }
}

async function logAction(supabase: any, data: {
  session_id: string;
  command: string;
  result: string;
  data?: any;
}) {
  try {
    await supabase.from("actions_log").insert({
      session_id: data.session_id,
      action_type: data.command,
      status: data.result,
      result: data.data || {}
    });
  } catch (e) {
    console.error("Failed to log action:", e);
  }
}
