import sharp from "sharp";
import { XMLParser } from "fast-xml-parser";

const GROQ_KEY = process.env.GROQ_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!GROQ_KEY || !TG_TOKEN || !TG_CHAT_ID) {
  throw new Error("Missing GROQ_API_KEY / TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars");
}

// ---------- 1. Pull real headlines from free RSS feeds ----------
const FEEDS = [
  "https://feeds.bbci.co.uk/news/politics/rss.xml",
  "https://www.theguardian.com/politics/rss",
  "https://feeds.skynews.com/feeds/rss/politics.xml"
];

const PRIORITY = [
  { tags: ["scandal", "resign", "minister", "pm ", "prime minister", "sleaze", "inquiry"], weight: 5 },
  { tags: ["nhs", "hospital", "doctor", "nurse", "health service"], weight: 4 },
  { tags: ["cost of living", "energy bill", "inflation", "tax", "budget", "mortgage"], weight: 3 },
  { tags: ["migrant", "immigration", "asylum", "border"], weight: 2 },
  { tags: ["trump", "us relations", "washington", "tariff"], weight: 1 }
];

async function fetchFeedItems(url) {
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) return [];
  const xml = await resp.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map(it => ({
    title: String(it.title || "").trim(),
    description: String(it.description || "").replace(/<[^>]+>/g, "").trim()
  })).filter(it => it.title);
}

function scoreItem(item) {
  const text = (item.title + " " + item.description).toLowerCase();
  let score = 0;
  for (const p of PRIORITY) {
    if (p.tags.some(t => text.includes(t))) score += p.weight;
  }
  return score;
}

async function pickTopStory() {
  const allItems = [];
  for (const feed of FEEDS) {
    try {
      const items = await fetchFeedItems(feed);
      allItems.push(...items.slice(0, 15));
    } catch (e) {
      console.warn("Feed failed:", feed, e.message);
    }
  }
  if (allItems.length === 0) throw new Error("No RSS items fetched from any feed");

  allItems.sort((a, b) => scoreItem(b) - scoreItem(a));
  return allItems[0]; // highest-priority match, or just the first item if nothing matched
}

// ---------- 2. Free LLM (Groq) writes the post package from that real headline ----------
async function writePostPackage(story) {
  const instruction = `You write posts for a UK political commentary page called "The Honest Brit" (direct, bold, binary YES/NO polls, neutral framing of both sides).

Today's real news story:
Title: ${story.title}
Description: ${story.description}

Turn this into a post package. Rules:
- Do NOT describe any real named person's face/likeness in image_scene. No real politicians, no logos, no rendered text in the scene.
- image_scene must be SYMBOLIC/EDITORIAL only: objects, colors, textures, silhouettes, lighting that represent the story's theme (e.g. a cracked piggy bank, foggy hospital corridor, torn banknote, storm clouds over a skyline silhouette).
- Keep summary factual and neutral. Poll options must be 1-2 words each.

Respond with ONLY raw JSON, no markdown fences, no preamble, in this exact shape:
{
  "headline": "3-6 words, ALL CAPS, punchy",
  "summary": "2-3 factual sentences on the story",
  "quote_or_stat": "1-2 sentences with a key detail or figure from the description",
  "poll_question": "bold binary question, one sentence",
  "left_option": "1-2 words",
  "left_explain": "brief explanation of this position",
  "right_option": "1-2 words",
  "right_explain": "brief explanation of this position",
  "hashtags_main": ["#TheHonestBrit","#UKPolitics","#Topic1","#Topic2"],
  "hashtags_extra": ["#...", "up to 20 total discovery tags"],
  "image_scene": "30-60 word symbolic visual description, no real people, no text, no logos"
}`;

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: instruction }],
      temperature: 0.8
    })
  });
  if (!resp.ok) throw new Error(`Groq API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not find JSON in model output:\n" + text);
  return JSON.parse(match[0]);
}

// ---------- 3. Build the square image: pollinations background + SVG overlay ----------
//
// TEXT STYLE + FRAMING RULES (do not change without a reason):
// - Headline (top): big, bold, plain WHITE fill. No colored outline/stroke on the letters.
//   Readability against busy backgrounds is handled with a soft dark drop-shadow behind the
//   text (via feDropShadow), not a stroke.
// - Bottom bar (poll question + left/right options): large white text, bigger than the old
//   layout, but ALWAYS auto-fit so nothing is ever cut off or pushed outside the 1080x1080
//   canvas:
//     * Every text block is measured against a fixed max width for its slot.
//     * If it doesn't fit at the target font size, it wraps onto more lines first.
//     * If it still doesn't fit within the max allowed lines, the font size shrinks in
//       steps until it does (down to a sensible minimum).
//     * The top headline panel and bottom poll bar both resize themselves vertically to
//       match however many lines the text actually wrapped to, so text is never clipped
//       top/bottom either.
//   Any future edit to fonts/sizes must keep this auto-fit approach — never hardcode a
//   single font-size assuming the text will always be short.
//
function fitTextLines(text, { maxWidth, maxFontSize, minFontSize, maxLines, charWidthRatio = 0.58, step = 2 }) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { fontSize: minFontSize, lines: [""] };

  const wrapAt = (fontSize) => {
    const maxCharsPerLine = Math.max(1, Math.floor(maxWidth / (fontSize * charWidthRatio)));
    const lines = [];
    let current = "";
    for (const w of words) {
      const candidate = current ? `${current} ${w}` : w;
      if (candidate.length <= maxCharsPerLine || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  let fontSize = maxFontSize;
  let lines = wrapAt(fontSize);
  while (lines.length > maxLines && fontSize > minFontSize) {
    fontSize -= step;
    lines = wrapAt(fontSize);
  }
  return { fontSize, lines: lines.slice(0, Math.max(maxLines, lines.length)) };
}

function renderTspans(lines, x, lineHeight) {
  return lines
    .map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${line}</tspan>`)
    .join("");
}

async function buildImage(pkg) {
  const scenePrompt = `${pkg.image_scene}, distressed Union Jack texture blended in, dark moody navy and British red palette, cinematic dramatic lighting, no text, no people, no logos, high detail`;
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(scenePrompt)}?width=1080&height=1080&nologo=true&seed=${Date.now() % 1000000}`;

  const bgResp = await fetch(url);
  if (!bgResp.ok) throw new Error("pollinations fetch failed: " + bgResp.status);
  const bgBuffer = Buffer.from(await bgResp.arrayBuffer());

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // ---- HEADLINE: fit within a horizontal margin, up to 3 lines, shrinking font as needed ----
  const headlineFit = fitTextLines(esc(pkg.headline), {
    maxWidth: 940,
    maxFontSize: 84,
    minFontSize: 44,
    maxLines: 3
  });
  const headlineLineHeight = Math.round(headlineFit.fontSize * 1.15);
  const headlinePaddingTop = 240;
  const headlinePaddingBottom = 40;
  const headlineBlockHeight = Math.max(
    240,
    headlinePaddingTop + headlineFit.lines.length * headlineLineHeight + headlinePaddingBottom
  );
  const headlineFirstBaselineY = headlinePaddingTop;

  // ---- BOTTOM BAR: poll question fits within margin, up to 2 lines, shrinking as needed ----
  const pollFit = fitTextLines(esc(pkg.poll_question), {
    maxWidth: 940,
    maxFontSize: 58,
    minFontSize: 32,
    maxLines: 2
  });
  const pollLineHeight = Math.round(pollFit.fontSize * 1.15);
  const buttonsRowHeight = 140; // fixed space reserved at the bottom of the bar for the option buttons
  const pollPaddingTop = 60;
  const bottomBarHeight = Math.max(
    260,
    pollPaddingTop + pollFit.lines.length * pollLineHeight + buttonsRowHeight
  );
  const bottomBarY = 1080 - bottomBarHeight;
  const pollFirstBaselineY = bottomBarY + pollPaddingTop;
  const buttonsRowY = 1080 - 105; // fixed distance from the bottom edge, regardless of bar height

  // ---- LEFT / RIGHT OPTIONS: single line each, shrink to fit their half of the bar ----
  const leftFit = fitTextLines(esc(pkg.left_option), {
    maxWidth: 300,
    maxFontSize: 52,
    minFontSize: 28,
    maxLines: 1
  });
  const rightFit = fitTextLines(esc(pkg.right_option), {
    maxWidth: 300,
    maxFontSize: 52,
    minFontSize: 28,
    maxLines: 1
  });

  const overlaySvg = `
  <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#000" stop-opacity="0.6"/>
        <stop offset="1" stop-color="#000" stop-opacity="0"/>
      </linearGradient>
      <filter id="headlineShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#000000" flood-opacity="0.85"/>
      </filter>
    </defs>
    <rect x="0" y="0" width="1080" height="${headlineBlockHeight}" fill="url(#topFade)"/>

    <!-- HEADLINE: big, bold, plain white, no stroke/outline, auto-fit within the canvas -->
    <text x="540" y="${headlineFirstBaselineY}" font-family="Arial Black, Arial, sans-serif"
          font-size="${headlineFit.fontSize}" font-weight="900"
          fill="#ffffff" text-anchor="middle" filter="url(#headlineShadow)">${renderTspans(headlineFit.lines, 540, headlineLineHeight)}</text>

    <rect x="0" y="${bottomBarY}" width="1080" height="${bottomBarHeight}" rx="0" fill="#0d0d0dcc"/>

    <!-- BOTTOM BAR: poll question + options, auto-fit within the canvas -->
    <text x="540" y="${pollFirstBaselineY}" font-family="Arial, sans-serif"
          font-size="${pollFit.fontSize}" font-weight="800"
          fill="#ffffff" text-anchor="middle">${renderTspans(pollFit.lines, 540, pollLineHeight)}</text>

    <circle cx="220" cy="${buttonsRowY}" r="34" fill="#2f6fed" stroke="#ffffff" stroke-width="3"/>
    <text x="220" y="${buttonsRowY + 13}" font-family="Arial, sans-serif" font-size="32" text-anchor="middle">👍</text>
    <text x="278" y="${buttonsRowY + 13}" font-family="Arial, sans-serif" font-size="${leftFit.fontSize}" font-weight="800"
          fill="#ffffff" text-anchor="start">${leftFit.lines[0]}</text>

    <text x="802" y="${buttonsRowY + 13}" font-family="Arial, sans-serif" font-size="${rightFit.fontSize}" font-weight="800"
          fill="#ffffff" text-anchor="end">${rightFit.lines[0]}</text>
    <circle cx="860" cy="${buttonsRowY}" r="34" fill="#e0457b" stroke="#ffffff" stroke-width="3"/>
    <text x="860" y="${buttonsRowY + 13}" font-family="Arial, sans-serif" font-size="32" text-anchor="middle">❤️</text>
  </svg>`;

  return sharp(bgBuffer)
    .resize(1080, 1080)
    .composite([{ input: Buffer.from(overlaySvg) }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

// ---------- 4. Caption text (for copy/paste onto Facebook) ----------
function buildCaption(pkg) {
  return `🇬🇧 BE HONEST.

${pkg.summary}

${pkg.quote_or_stat}

${pkg.poll_question}

👍 ${pkg.left_option} — ${pkg.left_explain}
❤️ ${pkg.right_option} — ${pkg.right_explain}

Drop your honest take below. No spin. Just the question. 👇

Follow The Honest Brit for the UK's most direct political pulse check. 🇬🇧

${pkg.hashtags_main.join(" ")}`;
}

function postingTimeTable() {
  return `| Time Zone | Recommended Time |
| :--- | :--- |
| UK (BST) | 5:00 PM – 6:00 PM |
| Sri Lanka (SLST) | 9:30 PM – 10:30 PM |`;
}

// ---------- 5. Send to Telegram ----------
async function sendToTelegram(imageBuffer, pkg) {
  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  form.append("photo", new Blob([imageBuffer], { type: "image/jpeg" }), "post.jpg");

  const photoResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form
  });
  if (!photoResp.ok) throw new Error("Telegram sendPhoto failed: " + (await photoResp.text()));

  const caption = buildCaption(pkg);

  // Message 1: caption ONLY, nothing else, so it's a clean single tap-and-hold copy on mobile
  const captionResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: caption })
  });
  if (!captionResp.ok) throw new Error("Telegram sendMessage (caption) failed: " + (await captionResp.text()));

  // Message 2: everything else (pinned tags + posting time table)
  const extraTags = pkg.hashtags_extra?.join(" ") || "";
  const extrasMsg = `🏷 Pinned comment tags:\n${extraTags}\n\n🕒 Posting time:\n${postingTimeTable()}`;

  const extrasResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: extrasMsg })
  });
  if (!extrasResp.ok) throw new Error("Telegram sendMessage (extras) failed: " + (await extrasResp.text()));
}

// ---------- run ----------
(async () => {
  console.log("Reading RSS feeds for today's top story...");
  const story = await pickTopStory();
  console.log("Story:", story.title);

  console.log("Writing post package (Groq, free)...");
  const pkg = await writePostPackage(story);
  console.log("Headline:", pkg.headline);

  console.log("Building image (pollinations, free)...");
  const image = await buildImage(pkg);

  console.log("Sending to Telegram...");
  await sendToTelegram(image, pkg);

  console.log("Done.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
