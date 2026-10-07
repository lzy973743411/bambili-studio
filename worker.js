// Tossy — Cloudflare Worker: serves the site from ./public and the AI reply line at /api/tossy-line
// The dice has ALREADY picked the answer at random in the browser. This function only writes
// the one-line reaction under it, in the current tone. It never decides anything.
//
// Setup (Cloudflare → Workers & Pages → tossy-cloudflare → Settings → Variables and Secrets):
//   GEMINI_API_KEY  (required, add it as a Secret)   TOSSY_MODEL (optional)
// The API key stays on the server. Never put it in index.html.

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const GEMINI = "https://generativelanguage.googleapis.com";

const VOICES = {
  bestie: "Bestie: warm, hyped, supportive best friend. Calls the user babe. Cheerleader energy.",
  savage: "Savage: dry, teasing, a little rude but never cruel. Short and punchy roasts.",
  rational: "Rational: calm, deadpan, a bit nerdy. Talks about odds and information, no fluff.",
  gentle: "Gentle: soft, reassuring, low pressure. Reminds the user they can go easy on themselves."
};

function systemPrompt(lang) {
  const format = lang === "zh"
    ? "Write in Simplified Chinese, casual and natural, at most 18 Chinese characters."
    : "Write in English, at most 10 words. Plain text; it will be shown in capitals.";
  return [
    "You write ONE short reaction line for Tossy, a playful pixel dice that answers small everyday decisions AT RANDOM.",
    "The verdict is already shown in big letters above your line. Do not repeat it: never start with yes, no, nope, yep, 要, 不 or similar.",
    "Never change or argue with the verdict, never hint at the opposite, never add a second option, never claim you analyzed anything.",
    "Make it specific to what the question is about (a cat, a text, dinner, a job application).",
    "Tease the situation, the overthinking or the dice itself. NEVER put the user down: nothing about their abilities, looks, worth,",
    "chances, embarrassment or failure. When the verdict is no on something hopeful (applying, asking someone out, a trip),",
    "frame it as 'not this time', never as 'you would fail'. Even the savage tone is a friend roasting, never mean.",
    format,
    "No emojis, hashtags, quotation marks, or line breaks. Output only the line.",
    "If the question is about something serious (health, safety, self-harm, money, legal trouble, a big life decision), do not joke:",
    "say kindly that this one deserves a real person, in the same language and length limit.",
    "",
    "Good examples (style only, do not copy):",
    "savage, should I get a cat, YES → THE CAT ALREADY DECIDED. YOU'RE JUST STAFF NOW.",
    "savage, should I apply, NO → SKIP THIS ONE. KEEP THE COVER LETTER ENERGY.",
    "bestie, should I text him back, NO → LET HIM WONDER A LITTLE, BABE.",
    "gentle, gym or couch, COUCH → YOUR MUSCLES CAN REST TODAY TOO.",
    "rational, coffee or tea, TEA → LESS CAFFEINE, SAME WARM MUG.",
    "毒舌, 要不要养猫, 要 → 猫已经选好你了，你只是来打工的。",
    "闺蜜, 要不要投简历, 不要 → 这份先放放，更好的在后面。",
    "Bad examples (never write like this):",
    "NOPE, SAVE EVERYONE THE EMBARRASSMENT AND CLOSE THE TAB.  (puts the user down, repeats the verdict)",
    "YES! YOU SHOULD DEFINITELY GET A CAT.  (repeats the verdict, generic)"
  ].join("\n");
}

function userPrompt(b) {
  const verdict = b.kind === "yesno" ? `The dice said ${b.verdict === "yes" ? "YES" : "NO"} ("${b.answer}").` : `The dice picked: "${b.answer}".`;
  const toss = b.toss >= 3 ? ` This is toss #${b.toss} of the same question, so the user keeps re-tossing.` : "";
  return `Tone: ${VOICES[b.mode] || VOICES.savage}\nQuestion: "${b.question}"\n${verdict}${toss}\nWrite the line.`;
}

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// Only the Tossy site may call this (plus workers.dev preview URLs and local dev).
function allowedOrigin(req) {
  const o = req.headers.get("origin") || req.headers.get("referer") || "";
  let host = "";
  try { host = new URL(o).hostname; } catch { return false; }
  return host === "tossy.me" || host === "www.tossy.me" || host.endsWith(".workers.dev") || host.endsWith(".pages.dev") || host === "localhost" || host === "127.0.0.1";
}

// Best-effort rate limit per visitor IP (in memory, per Cloudflare isolate).
// It stops casual abuse; set a quota/budget alert in Google AI Studio as the real safety net.
const LIMITS = { perMinute: 12, perDay: 150 };
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), h = hits.get(ip) || { min: [], day: [] };
  h.min = h.min.filter((t) => now - t < 60e3);
  h.day = h.day.filter((t) => now - t < 864e5);
  if (h.min.length >= LIMITS.perMinute || h.day.length >= LIMITS.perDay) { hits.set(ip, h); return true; }
  h.min.push(now); h.day.push(now); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return false;
}

function ideasPrompt(lang) {
  const size = lang === "zh"
    ? "Answers: Simplified Chinese, at most 8 characters each. Lines: casual Simplified Chinese, at most 18 characters."
    : "Answers: English, at most 4 words each. Lines: English, at most 10 words. Plain text; shown in capitals.";
  return [
    "You help Tossy, a playful pixel dice that answers small everyday questions AT RANDOM.",
    "You never decide. You only write the possible answers; the dice then picks one of them at random.",
    "",
    "STEP 1. Read the question carefully and work out what it is really asking, whatever the wording, slang or typos.",
    "",
    "STEP 2. Choose the kind:",
    'kind "yesno": the question can be answered with yes or no. Examples: should I..., do I..., is he..., does she..., will it...,',
    "  要不要..., 该不该..., 有没有..., 是不是..., 会不会..., 能不能..., 喜不喜欢..., ...吗.",
    "  Give exactly 4 answers: 2 that mean YES and 2 that mean NO, with v set to yes or no.",
    "  Each answer is a short verdict that replies to the question in ITS OWN words, flavoured by the tone.",
    "  有没有想前女友 → 有 / 没有.  是不是笨蛋 → 是 / 不是.  他喜不喜欢我 → 喜欢 / 不喜欢.  要不要买 → 买 / 先别买.",
    "  Is he mad at me → YES, A BIT / NOT AT ALL.  Should I text him → TEXT HIM / LEAVE IT.",
    "  Never answer a 'is it so' question with advice like go for it / don't do it, and never answer a 'should I' question with is / isn't.",
    "  Both sides must sound equally natural and fair. Do not lean towards one.",
    'kind "open": anything else (what, which, where, who, when, how, how many, why, or a statement).',
    "  Give 6 different concrete answers that directly and sensibly answer THIS exact question:",
    "  who → a kind of person, when → a time, how many → a number, where → a place, why → a playful plausible reason,",
    "  drinking tonight, what to eat with it → snacks that go with drinks, not hot cocoa. Set v to an empty string.",
    "  Make them varied, everyday and safe. Every one must be a good answer, because any of them may be picked.",
    "",
    "STEP 3. For each answer write one reaction line in the given tone, specific to that answer AND to what the question is about.",
    "The line must agree with its answer and must not repeat it. Tease the situation, the overthinking or the dice itself.",
    "NEVER put the user or the people they mention down: nothing about abilities, looks, worth, chances or failure.",
    "Never claim you analyzed anything or know the truth: it is only a dice. No emojis, hashtags, quotation marks or line breaks.",
    "If the question is about something serious (health, safety, self-harm, money, legal trouble, a big life decision),",
    'use kind "open" and return a single item whose answer gently suggests talking to someone they trust.',
    size,
    'Respond with JSON only: {"kind":"yesno or open","answers":[{"a":"answer","line":"reaction line","v":"yes, no or empty"}]}'
  ].join("\n");
}

// One Gemini call. Asks for minimal "thinking" so replies come back fast; if the model
// does not support that setting, it retries once without it and remembers.
let thinkingOk = true;
async function gemini(env, system, user, extra) {
  const model = env.TOSSY_MODEL || DEFAULT_MODEL;
  const call = (withThinking) => fetch(`${GEMINI}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: Object.assign({ temperature: 1, maxOutputTokens: 800 },
        withThinking ? { thinkingConfig: { thinkingLevel: "minimal" } } : {}, extra || {})
    })
  });
  let r = await call(thinkingOk);
  if (r.status === 400 && thinkingOk) { thinkingOk = false; r = await call(false); }
  if (!r.ok) return null;
  const data = await r.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
}
const unquote = (t) => String(t || "").replace(/\s+/g, " ").trim().replace(/^["'“”「『]+|["'“”」』]+$/g, "");

async function tossyLine(request, env) {
  if (!allowedOrigin(request)) return json(403, { error: "forbidden" });
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) return json(429, { error: "slow down" });
  if (!env.GEMINI_API_KEY) return json(500, { error: "missing GEMINI_API_KEY" });

  let b;
  try { b = await request.json(); } catch { return json(400, { error: "bad json" }); }
  const question = String(b.question || "").slice(0, 140);
  const lang = b.lang === "zh" ? "zh" : "en";
  if (!question) return json(400, { error: "question required" });

  /* questions without options: the model reads the question, says whether it is yes/no or open, and words
     the fitting answers + a matching line each; the page's dice picks one at random */
  if (b.type === "ideas") {
    const tone = VOICES[b.mode] || VOICES.savage;
    const text = await gemini(env, ideasPrompt(lang), `Tone: ${tone}\nQuestion: "${question}"`, { responseMimeType: "application/json" });
    if (!text) return json(502, { error: "upstream" });
    let out = null;
    try { out = JSON.parse(text.replace(/^```(json)?|```$/g, "")); } catch { return json(502, { error: "bad model json" }); }
    const list = Array.isArray(out) ? out : (out && Array.isArray(out.answers) ? out.answers : []);
    const ideas = list.map((x) => ({ a: unquote(x && x.a), line: unquote(x && x.line), v: x && (x.v === "yes" || x.v === "no") ? x.v : "" }))
      .filter((x) => x.a && x.a.length <= 40 && x.line.length <= 90).slice(0, 8);
    if (!ideas.length) return json(502, { error: "no ideas" });
    // a yes/no question is only usable if both sides came back
    const both = ideas.some((x) => x.v === "yes") && ideas.some((x) => x.v === "no");
    if (out && out.kind === "yesno" && !both) return json(502, { error: "one-sided" }); // the page then uses its built-in answers
    const kind = out && out.kind === "yesno" ? "yesno" : "open";
    if (kind === "open") ideas.forEach((x) => { x.v = ""; });
    return json(200, { kind, ideas });
  }

  const answer = String(b.answer || "").slice(0, 80);
  if (!answer) return json(400, { error: "answer required" });
  const line = unquote(await gemini(env, systemPrompt(lang), userPrompt({ ...b, question, answer, lang })));
  if (!line) return json(502, { error: "upstream" });
  // The page also re-checks length and falls back to its built-in line if anything is off.
  return json(200, { line });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/tossy-line") {
      if (request.method !== "POST") return json(405, { error: "POST only" });
      try { return await tossyLine(request, env); } catch (e) { return json(502, { error: "failed" }); }
    }
    // everything else is the static site in ./public (index.html, og.png, icon)
    return env.ASSETS.fetch(request);
  }
};
