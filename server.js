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

app.listen(PORT, () => {
  console.log(`Gegventures site running at http://localhost:${PORT}`);
  if (!client) {
    console.warn(
      'ANTHROPIC_API_KEY is not set — the AI chatbot and content studio will return a 503 until you add it.',
    );
  }
});
