// Vercel serverless function: POST /api/correct
// Sends the journal entry to OpenRouter and returns corrections + flashcards as JSON.
// Environment variables (set them in Vercel → Project → Settings → Environment Variables):
//   OPENROUTER_API_KEY  (required)  your OpenRouter key — it never reaches the browser
//   APP_PASSCODE        (required)  any word you choose; the app asks for it once
//   OPENROUTER_MODEL    (optional)  defaults to anthropic/claude-haiku-5.5

const { jsonrepair } = require("jsonrepair");

const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const MAX_TEXT = 8000;

const LANG_NAMES = { en: "English", fr: "French", es: "Spanish" };

function buildSystemPrompt({ nCards, level, feedbackLang }) {
  const fb = LANG_NAMES[feedbackLang] || "English";
  return `You are an excellent, demanding Spanish teacher. Your student is a native French speaker who also speaks English, currently living in Guadalajara, Mexico. Their Spanish level is about ${level}. Every day they write a short journal entry in Spanish. Sometimes they write a word in English or French because they don't know it in Spanish.

Return ONLY a JSON object (no markdown, no code fences) with exactly this shape:
{
  "summary": string,            // one honest sentence about today's entry, in ${fb}
  "corrected": string,          // the full entry rewritten in correct, natural Mexican/Latin American Spanish, keeping the student's meaning and voice; every English/French word replaced by Spanish
  "mistakes": [                 // the most important mistakes first, max 12
    { "original": string, "correction": string, "explanation": string /* short, in ${fb} */, "category": "grammar"|"vocabulary"|"spelling"|"accents"|"word order"|"false friend"|"word not in Spanish" }
  ],
  "improvements": [string],     // 2 to 4 concrete tips in ${fb} to sound more natural or fix recurring patterns
  "study": [                    // 2 or 3 things worth looking up today (grammar points or vocabulary areas behind the mistakes)
    { "topic": string /* short name, in Spanish, e.g. "Pretérito vs. imperfecto" */, "why": string /* one sentence in ${fb} linking it to today's mistakes */, "query": string /* a precise web search query in Spanish to learn it, e.g. "pretérito vs imperfecto explicación ejercicios" */ }
  ],
  "cards": [                    // EXACTLY ${nCards} flashcards
    {
      "sentence": string,       // see card rules
      "answer": string,         // the exact word or short expression that fills the blank, inflected as in the sentence
      "lemma": string,          // dictionary form (infinitive, masculine singular...)
      "pos": string,            // part of speech in Spanish, e.g. "verbo", "sustantivo (f.)", "adjetivo", "expresión"
      "translation": string,    // meaning in ${fb}
      "examples": [string, string], // two MORE natural everyday Spanish sentences using the word
      "note": string            // in ${fb}: why this card (e.g. "you wrote 'traffic' in English", "you used X instead", "basic vocabulary for this topic")
    }
  ]
}

How to choose the ${nCards} card targets, in this priority order:
1. Words or expressions the student wrote in English or French because they did not know them in Spanish.
2. Words they used wrongly (wrong word, false friend, wrong preposition, wrong verb form worth drilling).
3. Basic everyday vocabulary they clearly lack for the topics they wrote about.
4. Very common, natural expressions or collocations a native would use for those topics.
Never pick anything in the "already learned" list given by the user. Prefer high-frequency, useful words over rare ones.

Card rules (very important — the cards must be HARD but FAIR):
- "sentence" is a NEW, realistic, everyday sentence that a native speaker in Mexico would actually say or text (not copied from the journal, no textbook tone).
- The target appears exactly once, replaced by "____" (four underscores). Nothing else is blanked.
- The sentence must NOT give the answer away: no translation, no definition, no synonym next to the blank, no parentheses, no hints, no English or French words, no first letter, no word-type label.
- The context must still make the intended answer the most natural choice, so someone who truly knows the word can recall it. Avoid sentences where many different words would fit equally well.
- "answer" must be exactly what fills the blank (correct accents, correct conjugation).`;
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const end = cleaned.lastIndexOf("}");
  if (end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) {}
  }
  // repair common problems: unescaped quotes inside strings ("escargot"), cut-off answers, trailing commas
  try { return JSON.parse(jsonrepair(cleaned.slice(start))); } catch (_) {}
  return null;
}

// The answer is requested as a "tool call": the provider then returns properly escaped JSON.
const REVIEW_TOOL = {
  type: "function",
  function: {
    name: "submit_review",
    description: "Submit the review of the journal entry and today's flashcards.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        corrected: { type: "string" },
        mistakes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              original: { type: "string" }, correction: { type: "string" },
              explanation: { type: "string" }, category: { type: "string" }
            },
            required: ["original", "correction", "explanation"]
          }
        },
        improvements: { type: "array", items: { type: "string" } },
        study: {
          type: "array",
          items: {
            type: "object",
            properties: { topic: { type: "string" }, why: { type: "string" }, query: { type: "string" } },
            required: ["topic", "query"]
          }
        },
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sentence: { type: "string" }, answer: { type: "string" }, lemma: { type: "string" },
              pos: { type: "string" }, translation: { type: "string" },
              examples: { type: "array", items: { type: "string" } }, note: { type: "string" }
            },
            required: ["sentence", "answer", "translation"]
          }
        }
      },
      required: ["summary", "corrected", "mistakes", "improvements", "study", "cards"]
    }
  }
};

// Make sure every card is usable: one blank, no empty answer.
function cleanCards(cards, nCards) {
  if (!Array.isArray(cards)) return [];
  const out = [];
  for (const c of cards) {
    if (!c || typeof c.sentence !== "string" || typeof c.answer !== "string") continue;
    let sentence = c.sentence.trim();
    const answer = c.answer.trim();
    if (!answer) continue;
    sentence = sentence.replace(/_{2,}/g, "____");
    if (!sentence.includes("____")) {
      // the model forgot the blank: blank the answer if we can find it
      const idx = sentence.toLowerCase().indexOf(answer.toLowerCase());
      if (idx < 0) continue;
      sentence = sentence.slice(0, idx) + "____" + sentence.slice(idx + answer.length);
    }
    if (sentence.split("____").length !== 2) continue;
    out.push({
      sentence,
      answer,
      lemma: String(c.lemma || "").trim(),
      pos: String(c.pos || "").trim(),
      translation: String(c.translation || "").trim(),
      examples: Array.isArray(c.examples) ? c.examples.map(String).filter(Boolean).slice(0, 3) : [],
      note: String(c.note || "").trim()
    });
  }
  return out.slice(0, nCards);
}

async function postOpenRouter(payload) {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Diario ES"
    },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

// Returns { parsed, raw, finish }
async function callOpenRouter(messages) {
  const base = {
    model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    messages,
    temperature: 0.5,
    max_tokens: 8000
  };
  let r = await postOpenRouter(Object.assign({}, base, {
    tools: [REVIEW_TOOL],
    tool_choice: { type: "function", function: { name: "submit_review" } }
  }));
  if (!r.ok) {
    // some models do not support tools: try once without
    r = await postOpenRouter(base);
  }
  if (!r.ok) {
    const msg = (r.data && r.data.error && r.data.error.message) || `OpenRouter error ${r.status}`;
    throw new Error(msg);
  }
  const choice = (r.data.choices && r.data.choices[0]) || {};
  const msg = choice.message || {};
  const finish = choice.finish_reason || "";
  const call = msg.tool_calls && msg.tool_calls[0];
  if (call && call.function) {
    const args = call.function.arguments;
    const parsed = typeof args === "object" ? args : extractJson(args);
    if (parsed) return { parsed, raw: String(args), finish };
  }
  const raw = msg.content || "";
  return { parsed: extractJson(raw), raw, finish };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }
  if (!process.env.OPENROUTER_API_KEY || !process.env.APP_PASSCODE) {
    res.status(500).json({ error: "Server not configured: set OPENROUTER_API_KEY and APP_PASSCODE in Vercel." });
    return;
  }
  if (req.headers["x-passcode"] !== process.env.APP_PASSCODE) {
    res.status(401).json({ error: "Wrong passcode" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const text = String(body.text || "").trim();
  if (text.length < 20) {
    res.status(400).json({ error: "Write a bit more first (at least a couple of sentences)." });
    return;
  }
  const nCards = Math.min(10, Math.max(1, parseInt(body.nCards, 10) || 5));
  const level = ["A2", "B1", "B2", "C1"].includes(body.level) ? body.level : "B1";
  const feedbackLang = ["en", "fr", "es"].includes(body.feedbackLang) ? body.feedbackLang : "en";
  const known = Array.isArray(body.knownWords) ? body.knownWords.map(String).slice(-400) : [];

  const messages = [
    { role: "system", content: buildSystemPrompt({ nCards, level, feedbackLang }) },
    {
      role: "user",
      content:
        `Already learned (do not make cards for these): ${known.length ? known.join(", ") : "(none yet)"}\n\n` +
        `Today's journal entry:\n"""\n${text.slice(0, MAX_TEXT)}\n"""`
    }
  ];

  try {
    let out = await callOpenRouter(messages);
    if (!out.parsed) {
      console.log("Unreadable answer (finish:", out.finish, "):", out.raw.slice(0, 500));
      out = await callOpenRouter(messages); // one silent retry
    }
    const parsed = out.parsed;
    if (!parsed) {
      console.log("Unreadable answer again (finish:", out.finish, "):", out.raw.slice(0, 500));
      const why = out.finish === "length" ? " (the answer was too long and got cut)" : "";
      res.status(502).json({ error: "The AI answer could not be read" + why + ". Try again, or send me the Vercel log." });
      return;
    }
    res.status(200).json({
      summary: String(parsed.summary || ""),
      corrected: String(parsed.corrected || ""),
      mistakes: Array.isArray(parsed.mistakes) ? parsed.mistakes.slice(0, 15) : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements.map(String).slice(0, 5) : [],
      study: Array.isArray(parsed.study)
        ? parsed.study.filter(function (x) { return x && x.topic; }).slice(0, 4).map(function (x) {
            return { topic: String(x.topic), why: String(x.why || ""), query: String(x.query || x.topic) };
          })
        : [],
      cards: cleanCards(parsed.cards, nCards),
      model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};

// exported for local tests
module.exports.cleanCards = cleanCards;
module.exports.extractJson = extractJson;
