import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = 'claude-opus-4-7';

app.use(express.json({ limit: '1mb' }));

// Keep server internals out of the public static handler.
const BLOCKED = [/^\/node_modules\//, /^\/server\.js$/, /^\/package(-lock)?\.json$/, /^\/\./];
app.use((req, res, next) => {
  if (BLOCKED.some((re) => re.test(req.path))) return res.status(404).send('Not found');
  next();
});
app.use(express.static(__dirname, { extensions: ['html'], dotfiles: 'ignore' }));

const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;

// Practice profile the AI is allowed to speak to. Edit these to match the
// real Garcia Family Medicine details before going live.
const PRACTICE = {
  name: 'Garcia Family Medicine',
  type: 'family medicine practice',
  services:
    'preventive care and annual physicals, sick visits, chronic disease management (diabetes, hypertension, asthma), pediatric and adult care, women’s health, immunizations, and basic in-office labs',
  hours: 'Monday–Friday 8:00am–5:00pm; closed weekends and major holidays',
  location: '[INSERT STREET ADDRESS], with free patient parking',
  insurance:
    'most major insurance plans are accepted and self-pay options are available — the team can confirm specific coverage by phone',
  newPatients: 'currently accepting new patients of all ages',
};

const CHATBOT_SYSTEM = `You are the virtual front-desk assistant for ${PRACTICE.name}, a ${PRACTICE.type}. You greet prospective and current patients on the practice website.

Your goals, in order:
1. Make every visitor feel genuinely welcomed and understood.
2. Answer questions about the practice using ONLY the practice facts below.
3. Help the visitor take the next step — booking an appointment or requesting a callback. When they are ready, collect their full name, a preferred contact (phone or email), and a brief reason for the visit, then confirm that the team will follow up.

Practice facts (the only specifics you may state):
- Name: ${PRACTICE.name}
- Services: ${PRACTICE.services}
- Hours: ${PRACTICE.hours}
- Location: ${PRACTICE.location}
- Insurance: ${PRACTICE.insurance}
- New patients: ${PRACTICE.newPatients}

Hard rules:
- Do NOT provide medical advice, diagnoses, or treatment recommendations. For any health question, warmly encourage the visitor to book a visit.
- If anyone describes a medical emergency, tell them to call 911 or go to the nearest emergency room immediately.
- Be HIPAA-conscious: collect only the minimum contact info plus a short reason for the visit. Never ask for medical history, insurance ID numbers, Social Security numbers, or sensitive health details in chat.
- If you do not know something, say so plainly and offer to have the team follow up. Never invent hours, prices, providers, or policies.
- Keep replies short, warm, and conversational. Use plain language and avoid jargon.`;

const CONTENT_SYSTEM = `You are a senior healthcare marketing copywriter at Gegventures, a HIPAA-compliant digital marketing agency. You write patient-centered marketing content for ${PRACTICE.name}, a ${PRACTICE.type}.

Guidelines:
- Write in clear, warm, trustworthy language aimed at prospective patients.
- Be accurate and specific to family medicine. Do NOT invent statistics, awards, testimonials, or provider names. Where a specific figure would strengthen the copy, use an obvious placeholder like [INSERT STAT].
- Never include protected health information.
- Make no guarantees of medical outcomes and avoid language that could read as a medical claim.
- For SEO content, include a clear H1, naturally-placed keywords, scannable sections, and a meta-description suggestion.
- Always end with a clear next step (book an appointment, call, or request a consultation).
- Output clean Markdown that a marketer can review and refine.`;

const SEO_SYSTEM = `You are a senior organic-search strategist at Gegventures. You build practical plans that earn free, high-intent traffic from Google's organic results — so a business grows WITHOUT paying per click for Google Ads or any paid media.

Core philosophy:
- Every recommendation must drive ORGANIC (unpaid) traffic. Never recommend Google Ads, paid search, or any pay-per-click tactic — earning the click for free is the entire point.
- Focus on what actually moves organic rankings in 2026: genuinely helpful content, clear search-intent matching, strong on-page SEO, topical authority, technical health, E-E-A-T, and local SEO / Google Business Profile for businesses with a physical location.

How to work:
- Target high-intent keywords the business can realistically rank for. Prefer specific, lower-competition long-tail and local terms over broad head terms.
- Group keywords into topic clusters (a pillar page plus supporting articles) and map each to a clear search intent: informational, commercial, transactional, or navigational.
- For on-page elements, give exact, copy-ready output: a title tag (≤ ~60 characters), a meta description (≤ ~155 characters), one H1, and a logical H2/H3 outline. Note the primary keyword and 2–4 secondary keywords per page.
- Recommend relevant structured data / schema (e.g. LocalBusiness, MedicalClinic, FAQPage, Article) and a sensible internal-linking plan.
- For local businesses, include a Google Business Profile optimization plan and local-citation / review strategy.
- Include a short technical-SEO checklist (crawlability, site speed / Core Web Vitals, mobile, indexing, sitemap, HTTPS) tailored to the situation.
- Where useful, lay out a realistic publishing cadence / 90-day roadmap so the plan is something a small team can actually execute.

Hard rules:
- NEVER fabricate exact search volumes, keyword difficulty scores, or traffic numbers as if they were measured. When you estimate demand or competition, use clearly-labeled qualitative ranges (e.g. "likely low competition", "moderate monthly demand — verify in a keyword tool") and tell the reader which free tools to confirm with (Google Search Console, Google Keyword Planner, Google Trends, Search autocomplete / "People also ask").
- Do not invent statistics, reviews, awards, or specifics about the business. Use obvious placeholders like [INSERT ADDRESS] or [VERIFY] when a real-world detail is required.
- If the business is in healthcare, stay HIPAA-conscious and avoid making medical claims or guarantees of outcomes.
- Be concrete and prioritized — lead with the highest-leverage actions. Avoid generic filler.
- Output clean, well-structured Markdown with clear headings that a marketer can act on immediately.`;

function requireClient(res) {
  if (!client) {
    res.status(503).json({
      error:
        'ANTHROPIC_API_KEY is not set. Add it to your environment or a .env file, then restart the server.',
    });
    return false;
  }
  return true;
}

async function streamCompletion(res, params, label) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    const stream = client.messages.stream(params);
    stream.on('text', (delta) => res.write(delta));
    await stream.finalMessage();
    res.end();
  } catch (err) {
    console.error(`${label} error:`, err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'The AI request failed. Please try again.' });
    } else {
      res.end();
    }
  }
}

app.get('/api/status', (_req, res) => {
  res.json({ aiConfigured: !!client, model: MODEL, practice: PRACTICE.name });
});

// Patient-acquisition chatbot for Garcia Family Medicine.
app.post('/api/chat', async (req, res) => {
  if (!requireClient(res)) return;

  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = incoming
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim(),
    )
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    .slice(-20);

  if (messages.length === 0 || messages[0].role !== 'user') {
    return res
      .status(400)
      .json({ error: 'A conversation starting with a user message is required.' });
  }

  await streamCompletion(
    res,
    {
      model: MODEL,
      max_tokens: 1024,
      system: CHATBOT_SYSTEM,
      messages,
    },
    'chat',
  );
});

// Marketing content generator for Garcia Family Medicine.
app.post('/api/generate', async (req, res) => {
  if (!requireClient(res)) return;

  const CONTENT_TYPES = {
    'seo-page': 'an SEO-optimized service or landing page',
    'blog-post': 'a blog post that educates prospective patients',
    'ad-copy': 'a set of paid search and paid social ad variations',
    'gbp-post': 'a short Google Business Profile post',
  };

  const contentType = req.body?.contentType;
  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
  const location = typeof req.body?.location === 'string' ? req.body.location.trim() : '';
  const details = typeof req.body?.details === 'string' ? req.body.details.trim() : '';

  if (!CONTENT_TYPES[contentType]) {
    return res.status(400).json({ error: 'Unknown content type.' });
  }
  if (!topic) {
    return res.status(400).json({ error: 'A topic or focus is required.' });
  }

  const userPrompt = [
    `Create ${CONTENT_TYPES[contentType]} for ${PRACTICE.name}.`,
    `Topic / focus: ${topic.slice(0, 600)}`,
    location ? `Target location: ${location.slice(0, 200)}` : '',
    details ? `Additional direction: ${details.slice(0, 1500)}` : '',
    '',
    'Return polished, ready-to-review copy in Markdown.',
  ]
    .filter(Boolean)
    .join('\n');

  await streamCompletion(
    res,
    {
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: CONTENT_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    },
    'generate',
  );
});

// Organic Traffic Engine — builds SEO plans that earn free Google clicks
// (no paid search / pay-per-click). Works for any business, not just Garcia.
app.post('/api/seo', async (req, res) => {
  if (!requireClient(res)) return;

  const MODES = {
    'full-plan': 'a complete organic-traffic growth plan',
    keywords: 'a high-intent keyword opportunity map, organized into topic clusters with search intent',
    'content-brief': 'an SEO content brief for a single target keyword/topic (title tag, meta description, H1, full H2/H3 outline, primary + secondary keywords, entities to cover, suggested word count, internal links, and FAQ schema questions)',
    'local-seo': 'a local SEO and Google Business Profile optimization plan (GBP fields, categories, posts cadence, citation sources, and a review-generation strategy)',
    'optimize-page': 'an on-page SEO optimization of the provided existing page (a prioritized list of fixes plus rewritten title tag, meta description, headings, and internal-linking suggestions)',
  };

  const mode = req.body?.mode;
  const business = typeof req.body?.business === 'string' ? req.body.business.trim() : '';
  const website = typeof req.body?.website === 'string' ? req.body.website.trim() : '';
  const location = typeof req.body?.location === 'string' ? req.body.location.trim() : '';
  const keywords = typeof req.body?.keywords === 'string' ? req.body.keywords.trim() : '';
  const details = typeof req.body?.details === 'string' ? req.body.details.trim() : '';

  if (!MODES[mode]) {
    return res.status(400).json({ error: 'Unknown SEO mode.' });
  }
  if (!business) {
    return res.status(400).json({ error: 'A business name or description is required.' });
  }
  const needsKeywords = mode === 'content-brief' || mode === 'optimize-page';
  if (needsKeywords && !keywords) {
    return res.status(400).json({
      error:
        mode === 'optimize-page'
          ? 'Paste the page URL or its current content to optimize.'
          : 'A target keyword or topic is required for a content brief.',
    });
  }

  const userPrompt = [
    `Produce ${MODES[mode]}.`,
    '',
    `Business: ${business.slice(0, 600)}`,
    website ? `Website: ${website.slice(0, 300)}` : '',
    location ? `Target location / service area: ${location.slice(0, 200)}` : '',
    keywords
      ? `${mode === 'optimize-page' ? 'Page URL or current content' : 'Seed keywords / topics / target keyword'}: ${keywords.slice(0, 2000)}`
      : '',
    details ? `Additional context (audience, services, goals): ${details.slice(0, 1500)}` : '',
    '',
    'Goal: earn free, organic Google traffic — do NOT recommend paid ads or pay-per-click.',
    'Return a prioritized, copy-ready plan in clean Markdown.',
  ]
    .filter(Boolean)
    .join('\n');

  await streamCompletion(
    res,
    {
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: SEO_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    },
    'seo',
  );
});

app.listen(PORT, () => {
  console.log(`Gegventures site running at http://localhost:${PORT}`);
  if (!client) {
    console.warn(
      'ANTHROPIC_API_KEY is not set — the AI chatbot and content studio will return a 503 until you add it.',
    );
  }
});
