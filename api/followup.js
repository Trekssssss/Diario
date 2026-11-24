// Vercel serverless function: POST /api/followup
// The student taps "Preguntar" under one correction and asks a question about it.
// Returns { answer }: short plain text in the feedback language.
// Same passcode and OpenRouter key as /api/correct.

const ai = require("./_ai.js");
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish" };

// Small copy of the variety names so the answer matches the country chosen in settings.
const VARIETY_NAMES = {
  mx: "Mexican Spanish",
  es: "European Spanish (Spain)",
  ar: "Rioplatense Spanish (Argentina)",
  co: "Colombian Spanish",
  pe: "Peruvian Spanish",
  cl: "Chilean Spanish",
  neutral: "neutral Latin American Spanish"
};

function buildSystemPrompt({ level, feedbackLang, country }) {
  const fb = LANG_NAMES[feedbackLang] || "English";
  const variety = VARIETY_NAMES[country] || VARIETY_NAMES.mx;
  return `You are an excellent, patient Spanish teacher. Your student is a native French speaker, level about ${level}, learning ${variety}. You corrected their journal entry today, and they are asking a question about ONE of those corrections.

Answer in ${fb}. Rules:
- Under 130 words, plain text only (no markdown, no headings).
- Answer the question directly first, in simple words.
- If it helps, add 1 or 2 short Spanish example sentences, each followed by a ${fb} translation in parentheses.
- All advice must match ${variety}.
- If the question has nothing to do with Spanish, say so kindly in one sentence.`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }
  const configErr = ai.configError();
  if (configErr) {
    res.status(500).json({ error: configErr });
    return;
  }
  if (req.headers["x-passcode"] !== process.env.APP_PASSCODE) {
    res.status(401).json({ error: "Wrong passcode" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const question = String(body.question || "").trim().slice(0, 500);
  const mistake = body.mistake || {};
  if (question.length < 3) {
    res.status(400).json({ error: "Ask a real question first." });
    return;
  }

  const level = ["A2", "B1", "B2", "C1"].includes(body.level) ? body.level : "B1";
  const feedbackLang = ["en", "fr", "es"].includes(body.feedbackLang) ? body.feedbackLang : "en";
  const country = VARIETY_NAMES[body.country] ? body.country : "mx";

  // Give the model the correction, the entry for context, and any earlier Q&A on this mistake.
  let userContent =
    "The correction the student is asking about:\n" +
    `- they wrote: "${String(mistake.original || "")}"\n` +
    `- correct form: "${String(mistake.correction || "")}"\n` +
    `- category: ${String(mistake.category || "?")}\n` +
    `- your explanation was: "${String(mistake.explanation || "")}"\n\n` +
    `Their journal entry (context):\n"""\n${String(body.entryText || "").slice(0, 1500)}\n"""\n\n`;

  const previous = Array.isArray(body.previous) ? body.previous.slice(-4) : [];
  if (previous.length) {
    userContent += "Earlier questions on this same correction:\n";
    previous.forEach(function (qa) {
      userContent += `Q: ${String(qa.q || "").slice(0, 300)}\nA: ${String(qa.a || "").slice(0, 500)}\n`;
    });
    userContent += "\n";
  }
  userContent += `The student now asks:\n"${question}"`;

  try {
    const result = await ai.chatText({
      temperature: 0.4,
      max_tokens: 700,
      messages: [
        { role: "system", content: buildSystemPrompt({ level, feedbackLang, country }) },
        { role: "user", content: userContent }
      ]
    });
    res.status(200).json({ answer: result.content });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};
