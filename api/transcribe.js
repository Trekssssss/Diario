// Vercel serverless function: POST /api/transcribe
// Turns a short voice recording (base64 mp3 from the browser) into text, keeping the
// student's mistakes (that is the whole point). The shared AI layer does the work:
// Infomaniak Whisper first (Swiss, green hosting), OpenRouter (Gemini) as automatic fallback.

const ai = require("./_ai.js");

// ~1.8 MB of 48 kbps mono mp3 (5 min) ≈ 2.4 MB once base64-encoded;
// this cap stays under Vercel's 4.5 MB request-body limit.
const MAX_AUDIO_BASE64_LENGTH = 4 * 1024 * 1024;

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
    // language "es": the student speaks Spanish, so Whisper transcribes with Spanish spelling/accents.
    const result = await ai.transcribeAudio({ base64: audioBase64, format: audioFormat, language: "es" });
    res.status(200).json({ text: result.text, provider: result.provider });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};
