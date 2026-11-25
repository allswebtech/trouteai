import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@trouteai/open-sse/translator/index.ts";
import { transformToOllama } from "@trouteai/open-sse/utils/ollamaTransform.ts";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized");
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request) {
  await ensureInitialized();

  const clonedReq = request.clone();
  let modelName = "llama3.2";
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await clonedReq.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed;
      modelName = (typeof parsed.model === "string" && parsed.model) || "llama3.2";
    }
  } catch {}

  // The Ollama chat API streams unless the body says `stream: false`, the opposite of the
  // OpenAI default the pipeline applies. Make that default explicit so the pipeline streams.
  if (body && body.stream === undefined) body = { ...body, stream: true };

  const response = await handleChat(request, null, body);
  return transformToOllama(response, modelName);
}
