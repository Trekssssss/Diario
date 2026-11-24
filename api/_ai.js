// Shared AI layer for Diario's serverless functions.
// Files starting with "_" are NOT exposed as routes by Vercel, so this is a plain helper module.
//
// Two providers, both OpenAI-compatible:
//   - "infomaniak" : Swiss, green hosting (the datacenter's heat warms ~6,000 homes). Primary by default.
//   - "openrouter" : the original provider, kept as an automatic fallback.
//
// Which one runs is decided by env vars, so you can switch without touching code:
//   AI_PROVIDER                 "infomaniak" (default) or "openrouter" — which to TRY FIRST
//   APP_PASSCODE                the shared passcode (unchanged)
//
//   Infomaniak:
//     INFOMANIAK_API_TOKEN      your Infomaniak API token
//     INFOMANIAK_PRODUCT_ID     the AI product id from manager.infomaniak.com
//     INFOMANIAK_MODEL          chat model id, e.g. "mistralai/Mistral-Small-4-119B-2603"
//                               (for a 100% Swiss model use "swiss-ai/Apertus-v1.5-70B")
//     INFOMANIAK_TRANSCRIBE_MODEL  speech-to-text model id, default "whisper"
//     INFOMANIAK_BASE_URL       default "https://api.infomaniak.com"
//
//   OpenRouter (fallback):
//     OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_TRANSCRIBE_MODEL
//
// A provider is only used when its keys are present, so the app keeps working on OpenRouter
// alone until the Infomaniak variables are set.

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULTS = {
  openrouterChat: "anthropic/claude-haiku-5.5",
  openrouterTranscribe: "google/gemini-2.5-flash",
  infomaniakChat: "mistralai/Mistral-Small-4-119B-2603",
  infomaniakTranscribe: "whisper"
};

function infomaniakBaseUrl() {
  return (process.env.INFOMANIAK_BASE_URL || "https://api.infomaniak.com").replace(/\/+$/, "");
}

function isConfigured(providerName) {
  if (providerName === "openrouter") return !!process.env.OPENROUTER_API_KEY;
  if (providerName === "infomaniak") return !!(process.env.INFOMANIAK_API_TOKEN && process.env.INFOMANIAK_PRODUCT_ID);
  return false;
}

// The providers to try, best first, keeping only those that are actually configured.
function providerOrder() {
  const preferred = (process.env.AI_PROVIDER || "infomaniak").toLowerCase();
  const ordered = preferred === "openrouter"
    ? ["openrouter", "infomaniak"]
    : ["infomaniak", "openrouter"];
  return ordered.filter(isConfigured);
}

// Everything a chat call needs for one provider.
function chatTarget(providerName) {
  if (providerName === "openrouter") {
    return {
      name: "openrouter",
      url: OPENROUTER_CHAT_URL,
      token: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || DEFAULTS.openrouterChat
    };
  }
  return {
    name: "infomaniak",
    url: `${infomaniakBaseUrl()}/1/ai/${process.env.INFOMANIAK_PRODUCT_ID}/openai/chat/completions`,
    token: process.env.INFOMANIAK_API_TOKEN,
    model: process.env.INFOMANIAK_MODEL || DEFAULTS.infomaniakChat
  };
}

// The chat targets to try, in order.
function chatTargets() {
  return providerOrder().map(chatTarget);
}

// Low-level POST. The caller passes an OpenAI-style payload WITHOUT "model"; we add it here.
async function postChatRaw(target, payload) {
  const resp = await fetch(target.url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${target.token}`,
      "Content-Type": "application/json",
      "X-Title": "Diario ES"
    },
    body: JSON.stringify(Object.assign({ model: target.model }, payload))
  });
  const data = await resp.json().catch(function () { return {}; });
  return { ok: resp.ok, status: resp.status, data };
}

function errorMessage(data, status, providerName) {
  const fromData = data && data.error && (data.error.message || data.error);
  return String(fromData || `${providerName} error ${status}`);
}

// Simple chat for plain-text answers (used by /api/followup).
// Tries each provider in order; returns the first success as { content, provider }.
async function chatText(payload) {
  const targets = chatTargets();
  let lastError = new Error("No AI provider configured.");
  for (const target of targets) {
    try {
      const r = await postChatRaw(target, payload);
      if (!r.ok) { lastError = new Error(errorMessage(r.data, r.status, target.name)); continue; }
      const choice = (r.data.choices && r.data.choices[0]) || {};
      const content = String((choice.message && choice.message.content) || "").trim();
      if (!content) { lastError = new Error(`${target.name} returned an empty answer`); continue; }
      return { content: content, provider: target.name };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// ----- transcription -----

const TRANSCRIBE_INSTRUCTIONS = `Transcribe this audio recording.
The speaker is a French student learning Spanish, talking about their day. Their Spanish contains mistakes, and sometimes a French or English word slips in.
Rules:
- Write exactly what they say, INCLUDING every mistake. Never fix grammar, never swap a foreign word for the Spanish one, never translate.
- Add normal punctuation and paragraph breaks. Use Spanish spelling and accents for words clearly spoken in Spanish.
- Drop fillers ("eh", "um", "este...") and abandoned false starts, nothing else.
- Return ONLY the transcript: no introduction, no quotes, no notes.`;

// Infomaniak speech-to-text: a real OpenAI-style /audio/transcriptions endpoint (multipart upload).
async function transcribeInfomaniak(audioBuffer, format, language) {
  const url = `${infomaniakBaseUrl()}/1/ai/${process.env.INFOMANIAK_PRODUCT_ID}/openai/audio/transcriptions`;
  const mime = format === "wav" ? "audio/wav" : "audio/mpeg";
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mime }), `audio.${format}`);
  form.append("model", process.env.INFOMANIAK_TRANSCRIBE_MODEL || DEFAULTS.infomaniakTranscribe);
  if (language) form.append("language", language);
  form.append("response_format", "json");

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.INFOMANIAK_API_TOKEN}` }, // let fetch set the multipart boundary
    body: form
  });
  const data = await resp.json().catch(function () { return {}; });
  if (!resp.ok) throw new Error(errorMessage(data, resp.status, "infomaniak"));
  const text = String(data.text || "").trim();
  if (!text) throw new Error("Infomaniak returned an empty transcript");
  return text;
}

// OpenRouter fallback: send the audio as base64 inside a multimodal chat message.
async function transcribeOpenRouter(audioBase64, format) {
  const r = await postChatRaw(
    { name: "openrouter", url: OPENROUTER_CHAT_URL, token: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_TRANSCRIBE_MODEL || DEFAULTS.openrouterTranscribe },
    {
      temperature: 0,
      max_tokens: 6000,
      messages: [
        { role: "user", content: [
          { type: "text", text: TRANSCRIBE_INSTRUCTIONS },
          { type: "input_audio", input_audio: { data: audioBase64, format: format } }
        ] }
      ]
    }
  );
  if (!r.ok) throw new Error(errorMessage(r.data, r.status, "openrouter"));
  const choice = (r.data.choices && r.data.choices[0]) || {};
  let transcript = String((choice.message && choice.message.content) || "").trim();
  transcript = transcript.replace(/^```[a-z]*\n?/, "").replace(/```$/, "").trim();
  if (!transcript) throw new Error("OpenRouter returned an empty transcript");
  return transcript;
}

// Transcribe, trying providers in order. Returns { text, provider }.
async function transcribeAudio({ base64, format, language }) {
  const audioBuffer = Buffer.from(base64, "base64");
  let lastError = new Error("No AI provider configured.");
  for (const name of providerOrder()) {
    try {
      if (name === "infomaniak") {
        return { text: await transcribeInfomaniak(audioBuffer, format, language), provider: "infomaniak" };
      }
      return { text: await transcribeOpenRouter(base64, format), provider: "openrouter" };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// null when the server is ready, otherwise a message explaining what env var is missing.
function configError() {
  if (!process.env.APP_PASSCODE) return "Server not configured: set APP_PASSCODE in Vercel.";
  if (providerOrder().length === 0) {
    return "Server not configured: set INFOMANIAK_API_TOKEN and INFOMANIAK_PRODUCT_ID (or OPENROUTER_API_KEY) in Vercel.";
  }
  return null;
}

module.exports = {
  chatTargets: chatTargets,
  postChatRaw: postChatRaw,
  chatText: chatText,
  transcribeAudio: transcribeAudio,
  configError: configError,
  errorMessage: errorMessage,
  providerOrder: providerOrder
};
