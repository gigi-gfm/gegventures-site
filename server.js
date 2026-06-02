import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import * as dbm from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = 'claude-opus-4-7';

app.use(express.json({ limit: '400mb' }));
app.use(cookieParser());

// Keep server internals out of the public static handler.
const BLOCKED = [
  /^\/node_modules\//,
  /^\/server\.js$/,
  /^\/db\.js$/,
  /^\/data\//,
  /^\/package(-lock)?\.json$/,
  /^\/\./,
];
app.use((req, res, next) => {
  if (BLOCKED.some((re) => re.test(req.path))) return res.status(404).send('Not found');
  next();
});

// -------- Auth --------
dbm.bootstrapAdmin();
dbm.purgeExpiredSessions();
setInterval(() => dbm.purgeExpiredSessions(), 60 * 60 * 1000).unref();

const SESSION_COOKIE = 'geg_session';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: false, // Cloudflare Tunnel terminates TLS; cookies flow over the tunnel.
  path: '/',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

function currentUser(req) {
  return dbm.getSessionUser(req.cookies?.[SESSION_COOKIE]);
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
    next();
  });
}

// Pages that don't require auth.
const PUBLIC_PAGES = new Set([
  '/login.html',
  '/login',
  '/setup.html',
  '/api/auth/login',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/setup',
  '/api/status',
  '/favicon.ico',
  // The original marketing site is still public:
  '/index.html',
  '/',
  '/about.html',
  '/services.html',
  '/contact.html',
  '/studio.html',
  '/garcia-family-medicine.html',
]);
const PUBLIC_PREFIXES = ['/css/', '/js/', '/fonts/'];

// Protected pages — anything under these paths requires a login.
const PROTECTED_HTML = new Set([
  '/ime-studio.html',
  '/referral.html',
  '/return-to-work.html',
  '/cases.html',
  '/users.html',
]);
const PROTECTED_API_PREFIX = '/api/';
const PROTECTED_API_EXCEPTIONS = new Set([
  '/api/auth/login',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/setup',
  '/api/auth/setup-available',
  '/api/status',
]);

// Gate HTML pages: redirect unauthenticated requests to /login.html.
app.use((req, res, next) => {
  const p = req.path;
  if (PROTECTED_HTML.has(p)) {
    if (!currentUser(req)) {
      return res.redirect('/login.html?next=' + encodeURIComponent(p));
    }
  }
  // Gate API: anything under /api/ that isn't an exception requires login.
  if (p.startsWith(PROTECTED_API_PREFIX) && !PROTECTED_API_EXCEPTIONS.has(p)) {
    if (!currentUser(req)) return res.status(401).json({ error: 'Not signed in.' });
  }
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

// IME report drafter for Dr. Tess. Takes a clinical case packet
// (demographics, history, records summary, physical exam, imaging,
// prior treatment) and returns a structured IME draft including a
// reasoned discussion of permanent partial disability per AMA Guides.
// Output is a DRAFT — the examining physician must verify every finding,
// edit for accuracy, and assign final impairment percentages themselves.
const IME_SYSTEM = `You are a clinical documentation assistant for Theresa C. Garcia, MD, FAAFP, Dipl. ABOM ("Dr. Tess") of Garcia Family Medicine in Blue Springs, Missouri. Dr. Garcia performs Independent Medical Evaluations and PPD ratings under MISSOURI WORKERS' COMPENSATION LAW (RSMo Chapter 287). You draft IME LETTERS in HER ESTABLISHED FORMAT from the case material she gives you. Dr. Garcia reviews, edits, and signs every letter — your output is a working draft.

Core principles — non-negotiable:
0. TERMINOLOGY: "IME" stands for "Independent Medical Evaluation" and refers to THE ENTIRE LETTER you are drafting — the letterhead, addressee, RE block, history, physical exam, records review, discussion, and signature together constitute the IME. Do not refer to "the IME report" as if it were a separate document from the evaluation. The physical examination is a component performed during the IME and must be dated with the date Dr. Garcia actually examined the patient.
1. Use ONLY facts in the case packet Dr. Garcia provides. Do not invent providers, dates, findings, imaging results, or quotes. Mark missing items "[NEEDS VERIFICATION]" or "[NOT IN RECORDS PROVIDED]".
2. Evidence-based advocacy is appropriate where the records support it. Dr. Garcia's reports favor the patient when the evidence does — e.g., critiquing a prior provider's reasoning when the records show flaws, surfacing pain and functional impact that other providers minimized, arguing causation by showing the temporal pattern. This is NOT manufactured bias; it is rigorous reading of the actual record. Make every advocacy point tie to a specific document, date, or finding.
3. Causation: state opinions in Missouri's "prevailing factor" language (RSMo § 287.020.3). If the evidence supports the work injury as the prevailing factor, say so plainly. If pre-existing conditions exist but the work injury made symptoms appear/worsen/become disabling, argue that with specific evidence (timing of symptoms, MRI compartment differentials, mechanism of injury, prior asymptomatic status).
4. PPD: Missouri does NOT mandate the AMA Guides. Express any PPD as a PERCENTAGE OF DISABILITY at the correct statutory level (RSMo § 287.190 — see schedule below) or of the BODY AS A WHOLE for unscheduled/spine/internal/psychiatric injuries. CRITICAL: If the examinee is NOT at Maximum Medical Improvement, do NOT assign a PPD percentage. Instead state that PPD determination is premature, explain why MMI has not been reached, recommend the treatment needed to reach MMI, and offer to rule on PPD once the examinee has completed that treatment. Dr. Garcia explicitly defers PPD when MMI is not yet established.
5. **Scheduled weeks under RSMo § 287.190.1 (use to identify the statutory level):** thumb 60; index 45; middle 35; ring 30; little 22; hand 175; wrist 175; arm at/above elbow 210; arm at shoulder 232; great toe 40; other toe 16; foot 155; ankle 155; leg at/above knee 160; leg at hip 207; eye 140; hearing one ear 49 / both 180. Body as a whole = 400 weeks.
6. Standard of medical opinion: every opinion "within a reasonable degree of medical certainty."
7. Voice: first person ("I asked him...", "This examiner believes...", "I would like to point out..."). Educational asides in parentheses where they help the reader (e.g., "(also called the articular cartilage)"). Direct quotes from records in quotation marks with the source. When Dr. Garcia provides VOICE SAMPLES in the case packet, model the editorial tone, sentence rhythm, and willingness to editorialize on those samples — including pointed observations where the evidence supports them. Do not invent editorial digressions of your own; only adopt the voice she has already demonstrated.

OUTPUT FORMAT — produce the letter EXACTLY in the structure below. Use plain text with the section headings shown. Do NOT use Markdown bullet symbols inside sections; use sentences and paragraphs. Do use **bold** for the section headers and the DISCUSSION question prompts.

==== LETTERHEAD (centered, three lines) ====
**GARCIA FAMILY MEDICINE**
801 NW St. Mary's Drive, Suite 209
Blue Springs, Missouri 64014

(blank line)

[Date of letter — e.g. "September 25, 2025"]

(blank line)

[Addressee — multiple lines: name, firm, street, city/state/zip — exactly as provided in the packet]

(blank line)

RE: [Claimant] v [Employer]
    Date of Injury: [DOI]
    Injury Number: [Claim/Injury #]

(blank line)

**INDEPENDENT MEDICAL EVALUATION**  (centered)

(blank line)

==== OPENING PARAGRAPH ====
One paragraph stating when the examinee presented for the IME, that he/she understands it is for evaluation only and not treatment, and noting any follow-up phone conversation with the examinee (with or without an interpreter) used to clarify details.

==== SECTIONS (in this exact order, with these exact headers) ====

**Description of Injury**
A detailed narrative of the mechanism of injury and what happened. Use first person ("Mr./Ms. ___ is a ___-year-old, [handedness]-handed [ethnicity if relevant] [sex] who..."). Quote the examinee where colorful or important. Include relevant context (witnesses, what happened in the workplace afterward, why the examinee did or did not seek immediate care). Multiple paragraphs are fine. Include the timeline of when care WAS eventually sought and from whom, including delays and the reasons for them.

**Present Symptoms**
A narrative of current symptoms in the examinee's words and the examiner's observations. Pain rating, what relieves/aggravates, functional impact on work and activities, medication use (and the examinee's reasoning about it), prior athletic/recreational activities now lost.

**Past Medical History**
Brief narrative. Note specifically what the examinee reports about prior pain or absence of pain in the affected body part.

**Surgical History**
Brief narrative.

**Family History**
Brief narrative.

**Social History**
Narrative — smoking, alcohol, drugs, living situation, social engagement, the human texture of the examinee's life. Dr. Garcia takes a personal interest in this and the prose should reflect that.

**Review of Symptoms**
(Note: Dr. Garcia uses "Review of Symptoms" — NOT "Review of Systems".) One paragraph: constitutional, pulmonary, cardiac, GI, GU, musculoskeletal ("as described above").

**Physical Exam — Performed [DATE OF EXAMINATION]**
Use these subsection labels in this order (each on its own line followed by the finding):
General:
Head:
Chest:
Heart:
Abdomen:
Extremities:
Musculoskeletal: (general — full ROM of unaffected joints, lack of difficulty on the contralateral side, etc.)
[Affected body part — e.g. "Left knee", "Lumbar spine", "Right shoulder"] (specific findings — tenderness, swelling, special tests by name with positive/negative, ROM in degrees measured by goniometer, gait observations)

CRITICAL: The Physical Exam section header MUST include the date the examination was actually performed (taken from the "Date examinee presented for IME" field in the case packet — this is the date she physically examined the patient, which is often different from the date the letter is being written). Format the header exactly: "**Physical Exam — Performed [Month D, YYYY]**". If no exam date is provided in the packet, write "**Physical Exam — Performed [DATE NEEDED]**".

USE ONLY the "Physical Examination — TODAY at the IME visit" section from the case packet. These are Dr. Garcia's own findings from the IME-day exam. If that section is empty, write "[NEEDS VERIFICATION — Dr. Garcia to document IME-day examination findings in this section]" under the affected-body-part subheading. Never substitute findings from prior providers' exams here — those belong in Review of Records Provided.

**Review of Records Provided**
A NUMBERED list. Each numbered entry is a SOURCE (provider/facility), not a single document. Under each number, write a NARRATIVE ANALYSIS of that source's records — what was done, what was found, what the provider concluded, AND a critical reading where appropriate (organizational confusion, transcription errors, internal inconsistencies, conclusions not supported by the documentation, missing follow-up). Quote distinctive phrases from the records. Use full paragraphs, not bullet points. This is one of the strongest parts of Dr. Garcia's reports — be thorough.

Format each entry like:
1. [Source name]
   [Narrative analysis with multiple paragraphs if warranted.]

(blank line)

**DISCUSSION**  (centered, all caps, bold)

(blank line)

Question-and-answer format. For each question posed by the referring party (provided in the case packet), output the question in **bold** EXACTLY as posed, then a blank line, then Dr. Garcia's full reasoned answer in narrative paragraphs. If specific questions were not provided, use Dr. Garcia's standard question set:
- **Does this examiner believe that the accident on the job was the prevailing factor in causing the complaints to the [body part]? Are there any diagnoses for which the accident was the prevailing factor?**
- **What medical treatment would you recommend to cure and relieve the injured employee from the effects of his/her injuries?**
- **Does this examiner believe that the treatment recommended above is in direct relation to the work accident on [DOI]?**
- **What restrictions would this examiner place on the injured employee in his/her present physical condition?**
- **If you believe the injured employee does not need further treatment, what permanent partial disability percentage do you attribute to the work-related injury?**

In each answer:
- State the opinion in plain first-person prose.
- Cite specific findings, dates, providers, and records to support it.
- Where appropriate, critique reasoning of prior providers using their own documentation against them.
- Provide ICD-10 codes inline ONLY for the primary diagnosis or diagnoses for which causation is being directly opined. Do NOT multiply codes for secondary, related, or incidental conditions (e.g., parameniscal cyst, Baker's cyst, loose bodies that accompany a meniscal tear) — Dr. Garcia will add those if she wants them. When in doubt, fewer codes is closer to her established practice. Use the format: "The 2026 ICD-10-CM code for this diagnosis is XXX.XX."
- For the PPD question: if not at MMI, say so explicitly, explain why, recommend treatment to reach MMI, and state Dr. Garcia will rule on PPD once the examinee has recovered from that treatment. Do NOT commit to a future statutory level (e.g., "leg at the knee, 160 weeks") unless the case packet explicitly asks for it — leave the level open for her to set at the future PPD evaluation.
- For the restrictions question: assess whether restrictions would meaningfully change the trajectory of this case. If the cycle of pain is already established, if the examinee is already self-modifying duties at work, or if the records show prior restrictions were ignored without consequence, SAY SO — Dr. Garcia's actual practice is to be honest about the limited value of restrictions in those situations, not to invent a conventional restriction list. Only list specific restrictions (lifting limit, posture changes, rest periods) when the case is genuinely pre-MMI in a way restrictions would help, or when the referring questions explicitly ask for them.

==== CLOSING ====

After the discussion answers, end with this paragraph EXACTLY (substitute today's date / examination date implicitly through the prior text):

"The above statements were made based on the available information. Historical information was obtained, physical examination occurred, and available records were reviewed. The above is truthful and accurate and given with a reasonable degree of medical certainty. This was not a general evaluation; rather it was only focused on the questions that were asked. No doctor-patient relationship exists."

If the examinee is not at MMI, add: "If I can be of any further assistance, please do not hesitate to contact me at 816-427-5320. Once [Examinee] has recovered from [his/her] [recommended treatment], I will be happy to rule on permanent partial disability."

(blank line)
Sincerely,
(blank line)
(blank line)
Theresa C. Garcia MD, FAAFP, Dipl. ABOM
NPI #1275549974
Missouri License #2000160495

==== REVIEWER CHECKLIST (at the very end, after the signature) ====

After the signature block, insert a horizontal rule and a **"Reviewer Checklist for Dr. Garcia"** section listing every [NEEDS VERIFICATION] item, every place where the records were thin, every assumption the draft made, and every item Dr. Garcia should confirm before signing. This section is NOT part of the letter — it is a working aid that she will delete before sending.`;

app.post('/api/ime', async (req, res) => {
  if (!requireClient(res)) return;

  const fields = {
    letterDate: typeof req.body?.letterDate === 'string' ? req.body.letterDate.trim() : '',
    addressee: typeof req.body?.addressee === 'string' ? req.body.addressee.trim() : '',
    reBlock: typeof req.body?.reBlock === 'string' ? req.body.reBlock.trim() : '',
    dateOfEval: typeof req.body?.dateOfEval === 'string' ? req.body.dateOfEval.trim() : '',
    followUpConversation: typeof req.body?.followUpConversation === 'string' ? req.body.followUpConversation.trim() : '',
    examinee: typeof req.body?.examinee === 'string' ? req.body.examinee.trim() : '',
    caseInfo: typeof req.body?.caseInfo === 'string' ? req.body.caseInfo.trim() : '',
    chiefComplaint: typeof req.body?.chiefComplaint === 'string' ? req.body.chiefComplaint.trim() : '',
    historyOfInjury: typeof req.body?.historyOfInjury === 'string' ? req.body.historyOfInjury.trim() : '',
    pastHistory: typeof req.body?.pastHistory === 'string' ? req.body.pastHistory.trim() : '',
    recordsReviewed: typeof req.body?.recordsReviewed === 'string' ? req.body.recordsReviewed.trim() : '',
    priorExamFindings: typeof req.body?.priorExamFindings === 'string' ? req.body.priorExamFindings.trim() : '',
    physicalExam: typeof req.body?.physicalExam === 'string' ? req.body.physicalExam.trim() : '',
    diagnostics: typeof req.body?.diagnostics === 'string' ? req.body.diagnostics.trim() : '',
    priorTreatment: typeof req.body?.priorTreatment === 'string' ? req.body.priorTreatment.trim() : '',
    guidesEdition: typeof req.body?.guidesEdition === 'string' ? req.body.guidesEdition.trim() : '',
    jurisdiction: typeof req.body?.jurisdiction === 'string' ? req.body.jurisdiction.trim() : 'Missouri Workers’ Compensation (RSMo Chapter 287)',
    specificQuestions: typeof req.body?.specificQuestions === 'string' ? req.body.specificQuestions.trim() : '',
    voiceSamples: typeof req.body?.voiceSamples === 'string' ? req.body.voiceSamples.trim() : '',
  };

  if (
    !fields.historyOfInjury &&
    !fields.recordsReviewed &&
    !fields.physicalExam &&
    !fields.priorExamFindings
  ) {
    return res.status(400).json({
      error:
        'Provide at least the history of injury, records summary, or a physical exam (today or from records) before drafting.',
    });
  }

  // Cap each field so a single oversized paste cannot blow the context.
  const cap = (s, n) => (s.length > n ? s.slice(0, n) + '\n…[truncated]' : s);
  const section = (label, value, limit) =>
    value ? `## ${label}\n${cap(value, limit)}` : `## ${label}\n[Not provided]`;

  const userPrompt = [
    'Draft an Independent Medical Evaluation LETTER for Dr. Theresa C. Garcia from the case packet below, in HER ESTABLISHED FORMAT (letterhead → date → addressee → RE block → opening paragraph → Description of Injury → Present Symptoms → Past/Surgical/Family/Social History → Review of Symptoms → Physical Exam → Review of Records Provided (numbered narrative analyses) → DISCUSSION (question-and-answer) → standard closing paragraph → signature). Apply Missouri Workers’ Compensation Law (RSMo Chapter 287): use the "prevailing factor" causation language; only assign PPD if examinee is at MMI; otherwise defer.',
    `Jurisdiction: ${cap(fields.jurisdiction, 200)}`,
    fields.guidesEdition
      ? `Optional rating cross-check requested by Dr. Garcia: ${cap(fields.guidesEdition, 200)} (still express final PPD as a Missouri percentage at the statutory level)`
      : 'No AMA Guides edition specified — express PPD as a Missouri percentage at the statutory level under RSMo § 287.190.',
    fields.specificQuestions
      ? `Specific questions the referring party asked Dr. Garcia to answer (USE THESE EXACT QUESTIONS, BOLDED, IN THE DISCUSSION SECTION):\n${cap(fields.specificQuestions, 2000)}`
      : 'No specific questions provided — use Dr. Garcia’s standard question set for the Discussion section.',
    fields.voiceSamples
      ? `VOICE SAMPLES from Dr. Garcia's past IME reports — model the editorial tone, sentence rhythm, and willingness to editorialize on these samples. Do not copy phrases verbatim; absorb the voice and write in it.\n\n${cap(fields.voiceSamples, 8000)}`
      : '',
    '',
    '--- LETTER HEADER ---',
    section('Date of letter (use today’s date if blank)', fields.letterDate, 100),
    section('Addressee (multiple lines: name, firm, street, city/state/zip)', fields.addressee, 600),
    section('RE block (Claimant v Employer / Date of Injury / Injury Number)', fields.reBlock, 400),
    '--- END LETTER HEADER ---',
    '',
    '--- CASE PACKET ---',
    section('Examinee (name, DOB, sex, dominant hand, employer, occupation)', fields.examinee, 600),
    section('Case / Claim Information', fields.caseInfo, 800),
    section(
      'DATE OF PHYSICAL EXAMINATION (the date Dr. Garcia performed the IME — USE THIS IN THE "Physical Exam — Performed [date]" SECTION HEADER)',
      fields.dateOfEval,
      100,
    ),
    section('Follow-up phone conversation details (with interpreter if applicable)', fields.followUpConversation, 1500),
    section('Chief Complaint', fields.chiefComplaint, 600),
    section('History of Present Injury / Description of Injury', fields.historyOfInjury, 6000),
    section('Past Medical / Surgical / Family / Social / Occupational History', fields.pastHistory, 3000),
    section('Records Reviewed (chronological summary, source-by-source)', fields.recordsReviewed, 25000),
    section(
      "Prior Physical Exam Findings (from records — for Review of Records narrative; NOT today's exam)",
      fields.priorExamFindings,
      8000
    ),
    section(
      "Physical Examination — TODAY at the IME visit (performed by Dr. Garcia — this populates the Physical Exam section of the letter)",
      fields.physicalExam,
      6000
    ),
    section('Diagnostic Studies (imaging / EMG / labs — as reported)', fields.diagnostics, 4000),
    section('Prior Treatment & Response', fields.priorTreatment, 3000),
    '--- END CASE PACKET ---',
    '',
    'Produce the full IME now, in Dr. Garcia’s established format. The IME (the entire letter) must read in her first-person voice with the question-and-answer Discussion section. The Physical Exam section header MUST include the date the examination was performed (from the DATE OF PHYSICAL EXAMINATION field above). End with her exact closing paragraph, her signature block (Theresa C. Garcia MD, FAAFP, Dipl. ABOM / NPI #1275549974 / Missouri License #2000160495), and then a horizontal rule followed by the Reviewer Checklist for Dr. Garcia (working aid, not part of the IME).',
  ]
    .filter(Boolean)
    .join('\n');

  await streamCompletion(
    res,
    {
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: IME_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    },
    'ime',
  );
});

// =====================================================================
// Garcia Family Medicine — shared letterhead + signature for all letters
// =====================================================================
const GFM_LETTERHEAD = `**GARCIA FAMILY MEDICINE**
801 NW St. Mary's Drive, Suite 209
Blue Springs, Missouri 64014
Phone: 816-427-5320`;

const GFM_SIGNATURE = `Sincerely,


Theresa C. Garcia MD, FAAFP, Dipl. ABOM
NPI #1275549974
Missouri License #2000160495`;

// =====================================================================
// Referral letter generator
// =====================================================================
const REFERRAL_SYSTEM = `You are a clinical documentation assistant for Theresa C. Garcia, MD, FAAFP, Dipl. ABOM ("Dr. Tess") of Garcia Family Medicine in Blue Springs, Missouri. You draft REFERRAL LETTERS from her practice to consulting specialists. She reviews, edits, and signs every letter.

Rules:
- Use ONLY the patient and clinical information provided in the case packet. Do NOT invent diagnoses, findings, labs, imaging, or medications.
- Mark any gap with "[NEEDS VERIFICATION]".
- Professional, concise, warm tone — peer-to-peer physician communication.
- Output the letter in this exact format:

==== LETTERHEAD (centered, four lines) ====
**GARCIA FAMILY MEDICINE**
801 NW St. Mary's Drive, Suite 209
Blue Springs, Missouri 64014
Phone: 816-427-5320

(blank line)

[Date]

(blank line)

[Recipient block — specialist name, practice, street, city/state/zip]

(blank line)

RE: [Patient name], DOB [DOB], MRN [if provided]

(blank line)

Dear Dr. [Last name],

==== BODY (3–5 short paragraphs) ====
Paragraph 1: One-sentence statement of who the patient is and what specialty consultation is being requested, with the clinical question.
Paragraph 2: Pertinent history — onset, course, relevant past medical/surgical history.
Paragraph 3: Pertinent exam findings, labs, and imaging — only what was provided.
Paragraph 4: Current medications and what has already been tried.
Paragraph 5: Specific ask of the consultant ("Please evaluate and advise on…"), urgency if any, and offer to provide additional information.

==== CLOSING ====
Thank you for seeing this patient.

(blank line)
Sincerely,
(blank line)
(blank line)
Theresa C. Garcia MD, FAAFP, Dipl. ABOM
NPI #1275549974
Missouri License #2000160495

==== END WITH ====
A horizontal rule followed by "Reviewer Checklist for Dr. Garcia:" listing any [NEEDS VERIFICATION] items and assumptions.`;

app.post('/api/referral', async (req, res) => {
  if (!requireClient(res)) return;
  const letterDate = typeof req.body?.letterDate === 'string' ? req.body.letterDate.trim() : '';
  const patient = typeof req.body?.patient === 'string' ? req.body.patient.trim() : '';
  const recipient = typeof req.body?.recipient === 'string' ? req.body.recipient.trim() : '';
  const specialty = typeof req.body?.specialty === 'string' ? req.body.specialty.trim() : '';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  const clinicalHistory = typeof req.body?.clinicalHistory === 'string' ? req.body.clinicalHistory.trim() : '';
  const examLabsImaging = typeof req.body?.examLabsImaging === 'string' ? req.body.examLabsImaging.trim() : '';
  const medications = typeof req.body?.medications === 'string' ? req.body.medications.trim() : '';
  const urgency = typeof req.body?.urgency === 'string' ? req.body.urgency.trim() : '';

  if (!patient || !recipient || !reason) {
    return res
      .status(400)
      .json({ error: 'Patient, recipient, and reason for referral are all required.' });
  }

  const cap = (s, n) => (s.length > n ? s.slice(0, n) + '\n…[truncated]' : s);
  const section = (label, value, limit) =>
    value ? `## ${label}\n${cap(value, limit)}` : '';

  const userPrompt = [
    'Draft a referral letter from Garcia Family Medicine using the case packet below. Use the established letterhead, format, and signature block.',
    `Date of letter: ${letterDate || '[Use today]'}`,
    section('Patient (name, DOB, MRN, contact)', patient, 400),
    section('Recipient (specialist name, practice, address)', recipient, 500),
    section('Specialty / focus', specialty, 200),
    section('Reason for referral / clinical question', reason, 800),
    section('Relevant clinical history', clinicalHistory, 2500),
    section('Pertinent exam, labs, imaging', examLabsImaging, 2500),
    section('Current medications and prior treatment tried', medications, 1500),
    section('Urgency / timing', urgency, 200),
  ]
    .filter(Boolean)
    .join('\n');

  await streamCompletion(
    res,
    {
      model: MODEL,
      max_tokens: 4000,
      system: REFERRAL_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    },
    'referral',
  );
});

// =====================================================================
// Return-to-work / work-status letter
// =====================================================================
const RTW_SYSTEM = `You are a clinical documentation assistant for Theresa C. Garcia, MD, FAAFP, Dipl. ABOM of Garcia Family Medicine. You draft RETURN-TO-WORK and WORK-STATUS LETTERS for patients to give to their employer. She reviews and signs every letter.

Rules:
- Use ONLY information in the case packet. Do NOT invent diagnoses, findings, or restrictions.
- Professional, plain language. The letter is read by HR / supervisors, not physicians — avoid jargon where possible.
- Do NOT include diagnostic detail beyond what is medically necessary for the work-status decision. Maintain patient privacy.
- Output the letter in this exact format:

==== LETTERHEAD (centered, four lines) ====
**GARCIA FAMILY MEDICINE**
801 NW St. Mary's Drive, Suite 209
Blue Springs, Missouri 64014
Phone: 816-427-5320

(blank line)

[Date]

(blank line)

To Whom It May Concern: (OR specific addressee if provided)

(blank line)

RE: [Patient name], DOB [DOB]

(blank line)

==== BODY ====
Paragraph 1: One sentence: "This letter confirms that [Patient name] is under my medical care."
Paragraph 2: Work status statement. Choose ONE based on the input:
- "[Patient] is unable to return to work from [start date] through [end date], at which time he/she will be re-evaluated."
- "[Patient] may return to work on [date] with the following light-duty restrictions until [end date or next visit]:" followed by a bulleted list of restrictions (lifting limit, posture changes, breaks, no operation of equipment, etc.).
- "[Patient] is released to full duty without restriction effective [date]."
Paragraph 3 (only if restrictions are provided): A clear, scannable bulleted list of the restrictions.
Paragraph 4: Next follow-up date and a sentence inviting the employer to contact the office with questions: "If you have any questions, please contact our office at 816-427-5320."

==== CLOSING ====
Sincerely,
(blank line)
(blank line)
Theresa C. Garcia MD, FAAFP, Dipl. ABOM
NPI #1275549974
Missouri License #2000160495

==== END WITH ====
A horizontal rule followed by "Reviewer Checklist for Dr. Garcia:" listing any [NEEDS VERIFICATION] items.`;

app.post('/api/return-to-work', async (req, res) => {
  if (!requireClient(res)) return;
  const letterDate = typeof req.body?.letterDate === 'string' ? req.body.letterDate.trim() : '';
  const patient = typeof req.body?.patient === 'string' ? req.body.patient.trim() : '';
  const employer = typeof req.body?.employer === 'string' ? req.body.employer.trim() : '';
  const workStatus = typeof req.body?.workStatus === 'string' ? req.body.workStatus.trim() : '';
  const effectiveDates = typeof req.body?.effectiveDates === 'string' ? req.body.effectiveDates.trim() : '';
  const restrictions = typeof req.body?.restrictions === 'string' ? req.body.restrictions.trim() : '';
  const reasonForLetter = typeof req.body?.reasonForLetter === 'string' ? req.body.reasonForLetter.trim() : '';
  const followUp = typeof req.body?.followUp === 'string' ? req.body.followUp.trim() : '';

  if (!patient || !workStatus) {
    return res.status(400).json({ error: 'Patient and work status are required.' });
  }

  const cap = (s, n) => (s.length > n ? s.slice(0, n) + '\n…[truncated]' : s);
  const section = (label, value, limit) =>
    value ? `## ${label}\n${cap(value, limit)}` : '';

  const userPrompt = [
    'Draft a return-to-work / work-status letter from Garcia Family Medicine using the case packet below.',
    `Date of letter: ${letterDate || '[Use today]'}`,
    section('Patient (name, DOB)', patient, 300),
    section('Employer / HR contact (if known)', employer, 400),
    section('Work status (off work / light duty / full duty)', workStatus, 200),
    section('Effective dates (start through end / next eval)', effectiveDates, 200),
    section('Restrictions (if light duty)', restrictions, 1500),
    section('Reason for letter / brief medical context', reasonForLetter, 800),
    section('Next follow-up appointment', followUp, 200),
  ]
    .filter(Boolean)
    .join('\n');

  await streamCompletion(
    res,
    {
      model: MODEL,
      max_tokens: 3000,
      system: RTW_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    },
    'rtw',
  );
});

// IME case-packet extractor. Accepts uploaded medical records (PDFs and/or
// images of scanned records), uses Claude's PDF + vision support to read them,
// and returns a structured JSON object populating each form field in the IME
// studio. The user reviews and edits before drafting the report.
const EXTRACT_SYSTEM = `You are a medical records extraction assistant for Dr. Tess, who performs Independent Medical Examinations under Missouri Workers' Compensation Law. You are given one or more medical record documents (PDFs, scans, images) for a single examinee. Your job is to read every document carefully and populate the IME case packet by calling the populate_case_packet tool exactly once.

Rules:
- Read every page of every document. Quote dates, providers, diagnoses, imaging findings, exam findings, and treatment exactly as written.
- Put each piece of information in the MOST APPROPRIATE field. If unsure, prefer 'recordsReviewed' (the chronological summary).
- Do NOT invent facts, dates, providers, or findings that are not in the documents. If a field has no relevant content in the records, leave it as an empty string — do not guess.
- For 'recordsReviewed', produce a CHRONOLOGICAL summary, one document per line or short paragraph, in the format: "MM/DD/YYYY — [document type] — [provider/facility] — [1–3 sentence summary of key findings, diagnoses, plan]". Include every encounter, imaging report, operative note, and PT/OT note you can identify.
- For 'priorExamFindings', extract physical exam findings DOCUMENTED BY PRIOR PROVIDERS in the records — ROM in degrees, MRC strength grades, SLR, sensory and reflex findings, special tests — only what is documented. Format chronologically by exam date with the provider's name. This is reference material; Dr. Tess will perform and document her own examination at the IME visit, which goes into a SEPARATE field she fills in herself. Do NOT synthesize, summarize, or create a "new" exam in this field.
- For 'diagnostics', extract imaging (MRI, X-ray, CT, US), EMG/NCS, and lab reports as they were written by the reporting clinician.
- For 'priorTreatment', list conservative care, injections, surgeries, PT/OT response, medications, and work-status timeline.
- Preserve every concrete number, date, dose, and provider name. These are medical-legal documents — accuracy is non-negotiable.
- If pages are unreadable, blurry, or in an unexpected language, note that in the relevant field as "[Page(s) X unreadable]" but still extract everything legible.`;

const EXTRACT_TOOL = {
  name: 'populate_case_packet',
  description:
    'Populate the IME case packet form for Dr. Tess from the uploaded medical records.',
  input_schema: {
    type: 'object',
    properties: {
      addressee: {
        type: 'string',
        description:
          'Referring attorney / claim examiner block from cover letters in the records: name, firm name, street address, city/state/zip — one block, line by line. Leave empty string if not present in the records.',
      },
      reBlock: {
        type: 'string',
        description:
          'Three-line RE block in the format: "RE: [Claimant Name] v [Employer Name]\\n    Date of Injury: [MM/DD/YYYY]\\n    Injury Number: [claim/injury #]". Pull these from the records or claim documents. Leave empty if no claim number is found.',
      },
      examinee: {
        type: 'string',
        description:
          'Examinee identifiers extracted from the records: full name, DOB, age, sex, ethnicity if specified, dominant hand if mentioned, employer, years employed there, occupation at time of injury. One short paragraph.',
      },
      caseInfo: {
        type: 'string',
        description:
          'Claim / case information: date of injury, claim number, insurer/carrier, employer, referring attorney/claim examiner, date(s) of examination if present.',
      },
      chiefComplaint: {
        type: 'string',
        description:
          "The examinee's chief complaint as documented, in the examinee's own words where quoted.",
      },
      historyOfInjury: {
        type: 'string',
        description:
          'History of present injury: mechanism of injury, immediate symptoms, evolution of symptoms, current symptoms, aggravating and relieving factors. Compose from the records.',
      },
      pastHistory: {
        type: 'string',
        description:
          'Past medical, surgical, social, family, and occupational history including prior injuries to the same body part, comorbidities, prior surgeries, smoking/alcohol, job duties, and any prior PPD ratings.',
      },
      recordsReviewed: {
        type: 'string',
        description:
          'A CHRONOLOGICAL summary of every document, encounter, and report extracted from the uploaded records. Format each line: "MM/DD/YYYY — [type] — [provider] — [key findings]". Include ED visits, urgent care, orthopedic/specialist evals, PT/OT notes, imaging reports, operative notes, follow-ups, and IMEs.',
      },
      priorExamFindings: {
        type: 'string',
        description:
          'Physical examination findings DOCUMENTED BY PRIOR PROVIDERS in the uploaded records — NOT a new exam. For each documented exam, include date, provider, and the findings (vitals, ROM in degrees, MRC strength grades, SLR, sensory and reflex findings, special tests). Format chronologically. This populates a reference section for Dr. Tess to compare against her own exam at the IME visit. Do NOT include the IME-day examination here — Dr. Tess will perform and document that herself.',
      },
      diagnostics: {
        type: 'string',
        description:
          'Diagnostic studies as reported by the reading clinician: MRI, X-ray, CT, ultrasound, EMG/NCS, labs — with date and finding.',
      },
      priorTreatment: {
        type: 'string',
        description:
          'Prior treatment and response: conservative care, injections, surgical procedures with dates, PT/OT response, current medications, and the work-status timeline (off work, light duty, full duty, restrictions).',
      },
      notes: {
        type: 'string',
        description:
          'Any extraction notes for Dr. Tess: missing pages, unreadable sections, conflicting documentation between providers, or anything that warrants verification before drafting.',
      },
    },
    required: [
      'addressee',
      'reBlock',
      'examinee',
      'caseInfo',
      'chiefComplaint',
      'historyOfInjury',
      'pastHistory',
      'recordsReviewed',
      'priorExamFindings',
      'diagnostics',
      'priorTreatment',
      'notes',
    ],
  },
};

const ALLOWED_MEDIA = {
  'application/pdf': 'document',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
};

// Anthropic enforces a 32 MB / 100-page cap PER PDF on the API side; that is
// not something the app can override. We do not impose any limit on how many
// PDFs Dr. Tess can upload — large packets are split into batches and
// extracted in parallel, then merged.
const ANTHROPIC_PER_FILE_BYTES = 32 * 1024 * 1024;
const EXTRACT_BATCH_FILES = 5; // files per Claude call when batching

app.post('/api/extract', async (req, res) => {
  if (!requireClient(res)) return;

  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'Upload at least one medical record file.' });
  }

  const prepared = [];
  for (const file of files) {
    if (!file || typeof file.data !== 'string' || typeof file.mediaType !== 'string') {
      return res.status(400).json({ error: 'Each file must include mediaType and base64 data.' });
    }
    const kind = ALLOWED_MEDIA[file.mediaType];
    if (!kind) {
      return res.status(400).json({
        error: `Unsupported file type "${file.mediaType}". Use PDF, JPEG, PNG, GIF, or WebP.`,
      });
    }
    const approxBytes = Math.floor((file.data.length * 3) / 4);
    if (approxBytes > ANTHROPIC_PER_FILE_BYTES) {
      return res.status(400).json({
        error:
          `${file.name || 'A file'} is ${(approxBytes / 1024 / 1024).toFixed(1)} MB — the Anthropic API limits a single PDF to 32 MB / 100 pages. ` +
          'Split that file into smaller PDFs (e.g. one PDF per provider) and re-upload — there is no limit on how many PDFs you can upload.',
      });
    }
    prepared.push({
      name: file.name || 'document',
      block: {
        type: kind,
        source: { type: 'base64', media_type: file.mediaType, data: file.data },
      },
    });
  }

  // Split into batches so a packet of 50+ PDFs doesn't blow a single request.
  const batches = [];
  for (let i = 0; i < prepared.length; i += EXTRACT_BATCH_FILES) {
    batches.push(prepared.slice(i, i + EXTRACT_BATCH_FILES));
  }

  async function extractBatch(batch, batchIdx) {
    const content = batch.map((b) => b.block);
    content.push({
      type: 'text',
      text:
        batches.length > 1
          ? `This is batch ${batchIdx + 1} of ${batches.length} from a larger medical-records packet for the same examinee. Read every document above carefully and call populate_case_packet exactly once with everything extractable from THIS batch. A later merge step will combine batches — so be exhaustive in recordsReviewed (every document, in chronological order, with dates and providers).`
          : 'Read every document above carefully, then call populate_case_packet exactly once with the extracted fields. Be exhaustive in recordsReviewed.',
    });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: EXTRACT_SYSTEM,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'populate_case_packet' },
      messages: [{ role: 'user', content }],
    });
    const toolUse = (response.content || []).find((b) => b.type === 'tool_use');
    if (!toolUse || !toolUse.input || typeof toolUse.input !== 'object') {
      throw new Error(
        'The model did not return structured fields for batch ' +
          (batchIdx + 1) +
          '. Try again, or split the upload differently.'
      );
    }
    return toolUse.input;
  }

  function mergeFields(parts) {
    const fields = {
      addressee: '',
      reBlock: '',
      examinee: '',
      caseInfo: '',
      chiefComplaint: '',
      historyOfInjury: '',
      pastHistory: '',
      recordsReviewed: '',
      priorExamFindings: '',
      diagnostics: '',
      priorTreatment: '',
      notes: '',
    };
    const join = (key, sep) => {
      const values = parts
        .map((p) => (typeof p[key] === 'string' ? p[key].trim() : ''))
        .filter(Boolean);
      // Dedup identical strings across batches
      const seen = new Set();
      const unique = values.filter((v) => (seen.has(v) ? false : (seen.add(v), true)));
      fields[key] = unique.join(sep);
    };
    // Identifier/header fields: prefer the most complete first non-empty
    ['addressee', 'reBlock', 'examinee', 'caseInfo', 'chiefComplaint'].forEach((k) => {
      const v = parts
        .map((p) => (typeof p[k] === 'string' ? p[k].trim() : ''))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0];
      fields[k] = v || '';
    });
    // Narrative fields: concatenate with paragraph breaks
    ['historyOfInjury', 'pastHistory', 'priorExamFindings', 'diagnostics', 'priorTreatment', 'notes'].forEach(
      (k) => join(k, '\n\n')
    );
    // Records reviewed: line-merge then chronological sort if dates present
    const records = [];
    const seen = new Set();
    for (const p of parts) {
      const text = typeof p.recordsReviewed === 'string' ? p.recordsReviewed : '';
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        records.push(t);
      }
    }
    records.sort((a, b) => {
      const da = (a.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/) || [])[0];
      const db = (b.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/) || [])[0];
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return new Date(da) - new Date(db);
    });
    fields.recordsReviewed = records.join('\n');
    return fields;
  }

  try {
    const results = await Promise.all(batches.map((b, i) => extractBatch(b, i)));
    const merged = results.length === 1 ? results[0] : mergeFields(results);
    return res.json({ fields: merged, batches: results.length, files: prepared.length });
  } catch (err) {
    console.error('extract error:', err?.message || err);
    return res.status(500).json({
      error:
        err?.message ||
        'Extraction failed. Confirm the files are readable PDFs or clear scans and try again.',
    });
  }
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

// =====================================================================
// Authentication endpoints
// =====================================================================
// Setup endpoint: creates the first admin user when no users exist yet.
// Becomes a no-op (and returns 403) as soon as any user exists, so it
// cannot be used to take over an existing install.
app.get('/api/auth/setup-available', (_req, res) => {
  res.json({ available: dbm.listUsers().length === 0 });
});
app.post('/api/auth/setup', (req, res) => {
  if (dbm.listUsers().length > 0) {
    return res.status(403).json({ error: 'Setup is already complete. Use the login page.' });
  }
  try {
    const user = dbm.createUser({
      email: req.body?.email,
      password: req.body?.password,
      name: req.body?.name,
      role: 'admin',
    });
    const { token } = dbm.createSession(user.id);
    res.cookie(SESSION_COOKIE, token, COOKIE_OPTS);
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not create admin.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const user = dbm.verifyUserPassword(email, password);
  if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });
  const { token } = dbm.createSession(user.id);
  res.cookie(SESSION_COOKIE, token, COOKIE_OPTS);
  res.json({ user });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) dbm.deleteSession(token);
  res.clearCookie(SESSION_COOKIE, COOKIE_OPTS);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.json({ user: null });
  res.json({ user });
});

// =====================================================================
// User management (admin only)
// =====================================================================
app.get('/api/users', requireAdmin, (_req, res) => {
  res.json({ users: dbm.listUsers() });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { email, password, name, role } = req.body || {};
  try {
    const user = dbm.createUser({ email, password, name, role });
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not create user.' });
  }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account.' });
  dbm.deleteUser(id);
  res.json({ ok: true });
});

// =====================================================================
// Cases — list, create, read, update, archive
// =====================================================================
app.get('/api/cases', requireAuth, (req, res) => {
  const includeArchived = req.query.archived === '1';
  res.json({ cases: dbm.listCases({ includeArchived }) });
});

app.post('/api/cases', requireAuth, (req, res) => {
  const label = (req.body?.label || '').trim();
  const c = dbm.createCase({ label, userId: req.user.id });
  res.json({ case: c });
});

app.get('/api/cases/:id', requireAuth, (req, res) => {
  const c = dbm.getCase(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Case not found.' });
  const entries = dbm.listEntries(c.id);
  const timer = dbm.getTimer(c.id);
  res.json({ case: c, entries, timer });
});

app.patch('/api/cases/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const allowed = [
    'label', 'data', 'imeDraft',
    'retainerDate', 'recordsDate', 'examDate', 'softDeadline', 'hardDeadline',
    'archived',
  ];
  const patch = {};
  for (const k of allowed) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) patch[k] = req.body[k];
  }
  const updated = dbm.updateCase(id, patch);
  if (!updated) return res.status(404).json({ error: 'Case not found.' });
  res.json({ case: updated });
});

app.delete('/api/cases/:id', requireAuth, (req, res) => {
  // Soft delete — flip archived flag. Use ?hard=1 to actually delete.
  const id = Number(req.params.id);
  if (req.query.hard === '1' && req.user.role === 'admin') {
    dbm.deleteCase(id);
  } else {
    dbm.updateCase(id, { archived: true });
  }
  res.json({ ok: true });
});

// Time entries
app.get('/api/cases/:id/entries', requireAuth, (req, res) => {
  res.json({ entries: dbm.listEntries(Number(req.params.id)) });
});
app.post('/api/cases/:id/entries', requireAuth, (req, res) => {
  try {
    const result = dbm.addEntry(Number(req.params.id), {
      entryDate: req.body?.entryDate,
      activity: req.body?.activity,
      hours: Number(req.body?.hours),
      userId: req.user.id,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/cases/:caseId/entries/:entryId', requireAuth, (req, res) => {
  dbm.deleteEntry(Number(req.params.caseId), Number(req.params.entryId));
  res.json({ ok: true });
});

// Live timer
app.post('/api/cases/:id/timer/start', requireAuth, (req, res) => {
  res.json({ timer: dbm.startTimer(Number(req.params.id), req.user.id) });
});
app.post('/api/cases/:id/timer/stop', requireAuth, (req, res) => {
  res.json(dbm.stopTimer(Number(req.params.id)) || { stoppedHours: 0 });
});

// =====================================================================
// VoiceRx integration — proxies to the voicerx-api Worker so the IME
// Studio can pull dictation transcripts saved by VoiceRx.
// =====================================================================
const VOICERX_TOKEN = process.env.VOICERX_TOKEN || '';
const VOICERX_API_URL =
  (process.env.VOICERX_API_URL || 'https://voicerx-api.winter-shadow-e82d.workers.dev').replace(/\/+$/, '');

async function voicerxFetch(path) {
  if (!VOICERX_TOKEN) {
    return { ok: false, status: 503, json: { error: 'VoiceRx integration not configured — set VOICERX_TOKEN in .env.' } };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(VOICERX_API_URL + path, {
      headers: { Authorization: 'Bearer ' + VOICERX_TOKEN },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { ok: r.ok, status: r.status, json: parsed };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { ok: false, status: 504, json: { error: 'VoiceRx timed out after 15 seconds. The Worker may be down or the token may be wrong.' } };
    }
    return { ok: false, status: 502, json: { error: 'VoiceRx unreachable: ' + (err.message || err) } };
  }
}

app.get('/api/voicerx/status', requireAuth, async (_req, res) => {
  if (!VOICERX_TOKEN) return res.json({ configured: false });
  const result = await voicerxFetch('/whoami');
  res.json({
    configured: true,
    reachable: result.ok,
    apiUrl: VOICERX_API_URL,
    provider: result.ok ? result.json : null,
    error: result.ok ? null : result.json?.error || 'unknown',
  });
});

app.get('/api/voicerx/notes', requireAuth, async (_req, res) => {
  const result = await voicerxFetch('/notes');
  res.status(result.status).json(result.json);
});

app.get('/api/voicerx/notes/:id', requireAuth, async (req, res) => {
  // Limit to safe characters — voicerx note IDs are slugs.
  if (!/^[\w-]+$/.test(req.params.id)) return res.status(400).json({ error: 'Bad note id.' });
  const result = await voicerxFetch('/notes/' + req.params.id);
  res.status(result.status).json(result.json);
});

app.listen(PORT, () => {
  console.log(`Gegventures site running at http://localhost:${PORT}`);
  if (!client) {
    console.warn(
      'ANTHROPIC_API_KEY is not set — the AI chatbot and content studio will return a 503 until you add it.',
    );
  }
});
