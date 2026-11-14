// Vercel serverless function: POST /api/transcribe
// Turns a short voice recording (base64 mp3, recorded in the browser) into text.
// The transcript must keep the student's mistakes — that is the whole point —
// so the prompt forbids the model from correcting anything.
// Uses the same OpenRouter key as /api/correct.
//   optional OPENROUTER_TRANSCRIBE_MODEL   defaults to google/gemini-2.5-flash
//   (audio-capable and cheap: a 3-minute recording costs well under one cent)

const DEFAULT_TRANSCRIBE_MODEL = "google/gemini-2.5-flash";

// Base64 length cap. 5 minutes of 48 kbps mono mp3 is ~1.8 MB of audio,
// ~2.4 MB once base64-encoded — this cap leaves room while staying under
// Vercel's request body limit (4.5 MB).
const MAX_AUDIO_BASE64_LENGTH = 4 * 1024 * 1024;

const TRANSCRIBE_INSTRUCTIONS = `Transcribe this audio recording.
The speaker is a French student learning Spanish, talking about their day. Their Spanish contains mistakes, and sometimes a French or English word slips in.
Rules:
- Write exactly what they say, INCLUDING every mistake. Never fix grammar, never swap a foreign word for the Spanish one, never translate.
- Add normal punctuation and paragraph breaks. Use Spanish spelling and accents for words clearly spoken in Spanish.
- Drop fillers ("eh", "um", "este...") and abandoned false starts, nothing else.
- Return ONLY the transcript: no introduction, no quotes, no notes.`;

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
  const audioBase64 = String(body.audio || "");
  const audioFormat = body.format === "wav" ? "wav" : "mp3";
  if (!audioBase64) {
    res.status(400).json({ error: "No audio received." });
    return;
  }
  if (audioBase64.length > MAX_AUDIO_BASE64_LENGTH) {
    res.status(413).json({ error: "Recording too long. Keep it under 5 minutes." });
    return;
  }

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "Diario ES"
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL,
        temperature: 0,
        max_tokens: 6000,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: TRANSCRIBE_INSTRUCTIONS },
              { type: "input_audio", input_audio: { data: audioBase64, format: audioFormat } }
            ]
          }
        ]
      })
    });
    const data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      const message = (data.error && data.error.message) || ("OpenRouter error " + resp.status);
      throw new Error(message);
    }

    const choice = (data.choices && data.choices[0]) || {};
    let transcript = String((choice.message && choice.message.content) || "").trim();
    transcript = transcript.replace(/^```[a-z]*\n?/, "").replace(/```$/, "").trim();
    if (!transcript) {
      throw new Error("Empty transcript. Try again, closer to the microphone.");
    }
    res.status(200).json({ text: transcript });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};
