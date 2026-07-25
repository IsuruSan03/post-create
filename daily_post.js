import sharp from "sharp";
import { XMLParser } from "fast-xml-parser";

const GROQ_KEY = process.env.GROQ_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!GROQ_KEY || !TG_TOKEN || !TG_CHAT_ID) {
  throw new Error("Missing GROQ_API_KEY / TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars");
}

// ---------- RSS ----------
const FEEDS = [
  "https://feeds.bbci.co.uk/news/politics/rss.xml",
  "https://www.theguardian.com/politics/rss",
  "https://feeds.skynews.com/feeds/rss/politics.xml"
];

const PRIORITY = [
  { tags: ["scandal", "resign", "minister", "pm ", "prime minister", "sleaze", "inquiry", "misled", "parliament"], weight: 5 },
  { tags: ["nhs", "hospital", "doctor", "nurse", "health service"], weight: 4 },
  { tags: ["cost of living", "energy bill", "inflation", "tax", "budget", "mortgage", "elite", "rich"], weight: 3 },
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
      allItems.push(...items.slice(0, 12));
    } catch (e) {
      console.warn("Feed failed:", feed, e.message);
    }
  }
  if (allItems.length === 0) throw new Error("No RSS items");
  allItems.sort((a, b) => scoreItem(b) - scoreItem(a));
  return allItems[0];
}

// ---------- Groq ----------
async function writePostPackage(story) {
  const instruction = `You are writing for "The Honest Brit" – a bold UK political page.

Story:
Title: ${story.title}
Description: ${story.description}

Rules (strict):
- headline = maximum 4 words, ALL CAPS, extremely punchy (example style: "KEPT IN THE DARK?" or "TAX THE ELITE")
- poll_question = short and clear (max 10-12 words)
- left_option must be "YES"
- right_option must be "NO"
- image_scene must describe this EXACT composition only:
  Left side: clear, well-lit British male politician in dark suit standing at a podium with microphone, three-quarter view, professional and serious
  Right side: large dramatic close-up of an older male political face, heavily shadowed, filling the right half
  Small secondary figure lower right
  Heavy distressed Union Jack background, very dark cinematic mood
  NO text, NO logos

Return ONLY raw JSON:
{
  "headline": "MAX 4 WORDS ALL CAPS",
  "summary": "2 short factual sentences",
  "quote_or_stat": "1 key sentence",
  "poll_question": "short clear question",
  "left_option": "YES",
  "left_explain": "brief",
  "right_option": "NO",
  "right_explain": "brief",
  "hashtags_main": ["#TheHonestBrit","#UKPolitics","#Topic1","#Topic2"],
  "hashtags_extra": ["#tag1","#tag2"],
  "image_scene": "60 word description of the exact left-podium + right-large-face composition"
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
      temperature: 0.55
    })
  });

  if (!resp.ok) throw new Error(`Groq error: ${await resp.text()}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON:\n" + text);
  return JSON.parse(match[0]);
}

// ---------- Image builder ----------
async function buildImage(pkg) {
  // Stronger prompt + negative elements
  const scenePrompt = `${pkg.image_scene}, dark cinematic political poster, heavy distressed Union Jack flag texture, dramatic high contrast lighting, sharp focus on faces, professional portrait quality, photorealistic, 8k --no text, no logos, no blurry faces, no cropped heads, no ugly faces, no deformed`;

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(scenePrompt)}?width=1080&height=1350&nologo=true&seed=${Date.now() % 1000000}`;
  const bgResp = await fetch(url);
  if (!bgResp.ok) throw new Error("Image failed: " + bgResp.status);
  const bgBuffer = Buffer.from(await bgResp.arrayBuffer());

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Safer SVG – no textLength overflow, larger safe zones
  const overlaySvg = `
<svg width="1080" height="1350" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0.75"/>
      <stop offset="40%" stop-color="#000" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bot" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="45%" stop-color="#000" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.93"/>
    </linearGradient>
  </defs>

  <rect width="1080" height="1350" fill="url(#top)"/>
  <rect width="1080" height="1350" fill="url(#bot)"/>

  <!-- HEADLINE - large, clean, white + red outline, safe margins -->
  <text x="540" y="200"
        font-family="Arial Black, Impact, sans-serif"
        font-size="82"
        font-weight="900"
        fill="#FFFFFF"
        stroke="#C1122F"
        stroke-width="9"
        text-anchor="middle">
    ${esc(pkg.headline)}
  </text>

  <!-- Bottom black bar -->
  <rect x="50" y="1085" width="980" height="220" rx="32" ry="32" fill="#0f0f0f" fill-opacity="0.95"/>

  <!-- Poll question - safe size -->
  <text x="540" y="1165"
        font-family="Arial, Helvetica, sans-serif"
        font-size="32"
        font-weight="700"
        fill="#FFFFFF"
        text-anchor="middle">
    ${esc(pkg.poll_question)}
  </text>

  <!-- YES -->
  <circle cx="290" cy="1240" r="36" fill="#2F6FED" stroke="#FFFFFF" stroke-width="4"/>
  <text x="290" y="1254" font-size="38" text-anchor="middle" fill="#FFFFFF">👍</text>
  <text x="360" y="1254"
        font-family="Arial Black, Arial, sans-serif"
        font-size="40"
        font-weight="800"
        fill="#FFFFFF">YES</text>

  <!-- NO -->
  <circle cx="690" cy="1240" r="36" fill="#E0457B" stroke="#FFFFFF" stroke-width="4"/>
  <text x="690" y="1254" font-size="38" text-anchor="middle" fill="#FFFFFF">❤️</text>
  <text x="760" y="1254"
        font-family="Arial Black, Arial, sans-serif"
        font-size="40"
        font-weight="800"
        fill="#FFFFFF">NO</text>
</svg>`;

  return sharp(bgBuffer)
    .resize(1080, 1350)
    .composite([{ input: Buffer.from(overlaySvg) }])
    .jpeg({ quality: 93 })
    .toBuffer();
}

// ---------- Caption ----------
function buildCaption(pkg) {
  return `🇬🇧 BE HONEST.

${pkg.summary}

${pkg.quote_or_stat}

${pkg.poll_question}

👍 YES — ${pkg.left_explain}
❤️ NO — ${pkg.right_explain}

Drop your honest take below. No spin. Just the question. 👇

Follow The Honest Brit for the UK's most direct political pulse check. 🇬🇧

BE

${pkg.hashtags_main.join(" ")}`;
}

function postingTimeTable() {
  const now = new Date();
  const ukTime = now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
  const sriTime = now.toLocaleString('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hour12: false });
  return `| Time Zone | Current Time |
| :--- | :--- |
| UK (BST/GMT) | ${ukTime} |
| Sri Lanka (SLST) | ${sriTime} |`;
}

// ---------- Telegram ----------
async function sendToTelegram(imageBuffer, pkg) {
  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  form.append("photo", new Blob([imageBuffer], { type: "image/jpeg" }), "post.jpg");

  const photoResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form
  });
  if (!photoResp.ok) throw new Error("sendPhoto failed: " + await photoResp.text());

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: buildCaption(pkg) })
  });

  const extraTags = pkg.hashtags_extra?.join(" ") || "";
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text: `🏷 Pinned comment tags:\n${extraTags}\n\n🕒 Posting time:\n${postingTimeTable()}`
    })
  });
}

// ---------- Run ----------
(async () => {
  console.log("Fetching story...");
  const story = await pickTopStory();
  console.log("Story:", story.title);

  console.log("Writing package...");
  const pkg = await writePostPackage(story);
  console.log("Headline:", pkg.headline);

  console.log("Building image...");
  const image = await buildImage(pkg);

  console.log("Sending to Telegram...");
  await sendToTelegram(image, pkg);
  console.log("Done.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
