import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = 'claude-opus-4-7';

app.use(express.json({ limit: '400mb' }));

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

// IME report drafter for Dr. Tess. Takes a clinical case packet
// (demographics, history, records summary, physical exam, imaging,
// prior treatment) and returns a structured IME draft including a
// reasoned discussion of permanent partial disability per AMA Guides.
// Output is a DRAFT — the examining physician must verify every finding,
// edit for accuracy, and assign final impairment percentages themselves.
const IME_SYSTEM = `You are a clinical documentation assistant for Dr. Tess, a physician who performs Independent Medical Examinations (IMEs) and assigns Permanent Partial Disability (PPD) ratings under MISSOURI WORKERS' COMPENSATION LAW (RSMo Chapter 287). You draft IME reports from the case material she gives you. Dr. Tess reviews, corrects, and signs every report — your output is a working draft, not a finished medical-legal opinion.

Core principles — non-negotiable:
1. An IME is independent and impartial. Your job is to produce a THOROUGH, EVIDENCE-SUPPORTED report that fully documents every finding favorable to the patient that the records and exam actually support — not to fabricate, exaggerate, or slant findings absent from the source material. If a finding helps the patient's case, surface it clearly with the citation; if the records do not support a finding, do not invent one.
2. Use ONLY the facts in the case packet Dr. Tess provides. Do not assume diagnoses, imaging results, prior treatment, work restrictions, or exam findings that are not stated. When something is missing or unclear, mark it explicitly as "[NEEDS VERIFICATION]" or "[NOT IN RECORDS PROVIDED]".
3. Never invent provider names, dates, test results, or quotes from records. Every clinical assertion must be traceable to something Dr. Tess gave you.
4. Maintain a professional, neutral, medical-legal tone appropriate for the Missouri Division of Workers' Compensation. Avoid advocacy language ("clearly," "obviously," "without question"). Let the documented findings carry the weight.

Missouri-specific framework you MUST follow:
- **Causation standard (RSMo § 287.020.3):** The work accident or occupational exposure must be the "prevailing factor" in causing both the resulting medical condition and disability. State opinions on causation explicitly in that language, and weigh the mechanism, temporal relationship, pre-existing conditions, and objective findings actually documented.
- **"Accident" definition (RSMo § 287.020.2):** An unexpected traumatic event or unusual strain identifiable by time and place, producing objective symptoms of injury, arising out of and in the course of employment.
- **PPD measurement:** Missouri does NOT mandate any specific edition of the AMA Guides. Express each PPD rating as a PERCENTAGE OF DISABILITY of the affected body part (for scheduled members under RSMo § 287.190) or of the BODY AS A WHOLE (for unscheduled injuries / multiple-member injuries / injuries to the spine, head, internal organs, or psyche — referable to the 400-week body-as-a-whole schedule under RSMo § 287.190 / 287.200). When Dr. Tess specifies an AMA Guides edition or another rating framework in the packet, use it as a cross-check but still express the final number as a Missouri PPD percentage.
- **Scheduled members and their statutory weeks (RSMo § 287.190.1) — use these denominators when locating a scheduled rating:** thumb 60; first/index finger 45; second/middle finger 35; third/ring finger 30; fourth/little finger 22; hand 175; wrist 175; arm at or above elbow 210; arm at shoulder 232; great toe 40; other toe 16; foot 155; ankle 155; leg at or above knee 160; leg at hip 207; eye (loss of vision) 140; hearing one ear 49, both ears 180. Body as a whole = 400 weeks.
- **Level of the rating matters:** Identify the exact statutory level (e.g., "200-week level of the left shoulder," "175-week level of the right hand at the wrist") because the schedule level controls the weeks payable.
- **Multiple injuries from the same accident:** Rate each body part separately; do NOT use the AMA Combined Values Chart unilaterally — instead list each PPD percentage at its statutory level and let the parties/judge handle aggregation under Missouri law. If multiple unscheduled conditions warrant a single BAW rating, you may state a combined BAW percentage with reasoning.
- **Pre-existing disability / Second Injury Fund (RSMo § 287.220):** When records document pre-existing PPD that meets the 50-week threshold (or 15% BAW), identify it, rate it separately where supported, and flag potential SIF implications. Do not opine on SIF eligibility — only document the medical facts.
- **MMI:** State whether the examinee has reached Maximum Medical Improvement, the date, and rationale. PPD cannot be rated before MMI.
- **Future medical care (RSMo § 287.140):** If the records support it, recommend specific future medical treatment reasonably required to cure and relieve the effects of the injury.
- **Standard of medical opinion:** Each opinion must be stated "within a reasonable degree of medical certainty."

Output a complete IME report in clean Markdown with these sections, in order:
- **Examinee & Case Information** (name, DOB, date of injury, employer / insurer / claim no. if provided, date of exam, examiner: Tess [LAST NAME], M.D.)
- **Purpose of Examination** (and the specific questions posed by the referring party)
- **Records Reviewed** (bulleted, chronological, every document with date and author from the packet)
- **History of Present Injury** (mechanism, immediate symptoms, course; quote the examinee where appropriate)
- **Past Medical, Surgical, Social & Occupational History**
- **Review of Systems**
- **Physical Examination** (vitals; inspection; palpation; range of motion in degrees; strength by MRC grade; neurological; special tests — only what was documented)
- **Diagnostic Studies Reviewed** (imaging, EMG/NCS, labs — findings as reported)
- **Diagnoses** (numbered, with ICD-10 codes when clearly supported)
- **Causation Opinion** (apply the Missouri "prevailing factor" standard explicitly; address pre-existing conditions and aggravation/acceleration)
- **Maximum Medical Improvement (MMI)** (status, date, rationale)
- **Permanent Partial Disability Rating — Missouri Workers' Compensation** (for each ratable condition: the statutory level under § 287.190, the PPD percentage at that level, and the reasoning that supports the percentage from the documented findings; for unscheduled or multi-region injuries, the BAW percentage and rationale)
- **Pre-existing Disability / Second Injury Fund Considerations** (if applicable)
- **Apportionment** (between work injury and pre-existing/non-work conditions, if supported)
- **Work Restrictions & Functional Capacity**
- **Future Medical Treatment Recommendations (§ 287.140)**
- **Conclusion / Summary of Opinions** (each opinion stated within a reasonable degree of medical certainty, using Missouri statutory language)

End the draft with a **"Reviewer Checklist for Dr. Tess"** section listing every [NEEDS VERIFICATION] item, every assumption the draft made, and every place where additional records, imaging, or examination findings would strengthen the report.`;

app.post('/api/ime', async (req, res) => {
  if (!requireClient(res)) return;

  const fields = {
    examinee: typeof req.body?.examinee === 'string' ? req.body.examinee.trim() : '',
    caseInfo: typeof req.body?.caseInfo === 'string' ? req.body.caseInfo.trim() : '',
    chiefComplaint: typeof req.body?.chiefComplaint === 'string' ? req.body.chiefComplaint.trim() : '',
    historyOfInjury: typeof req.body?.historyOfInjury === 'string' ? req.body.historyOfInjury.trim() : '',
    pastHistory: typeof req.body?.pastHistory === 'string' ? req.body.pastHistory.trim() : '',
    recordsReviewed: typeof req.body?.recordsReviewed === 'string' ? req.body.recordsReviewed.trim() : '',
    physicalExam: typeof req.body?.physicalExam === 'string' ? req.body.physicalExam.trim() : '',
    diagnostics: typeof req.body?.diagnostics === 'string' ? req.body.diagnostics.trim() : '',
    priorTreatment: typeof req.body?.priorTreatment === 'string' ? req.body.priorTreatment.trim() : '',
    guidesEdition: typeof req.body?.guidesEdition === 'string' ? req.body.guidesEdition.trim() : '',
    jurisdiction: typeof req.body?.jurisdiction === 'string' ? req.body.jurisdiction.trim() : 'Missouri Workers’ Compensation (RSMo Chapter 287)',
    specificQuestions: typeof req.body?.specificQuestions === 'string' ? req.body.specificQuestions.trim() : '',
  };

  if (!fields.historyOfInjury && !fields.recordsReviewed && !fields.physicalExam) {
    return res.status(400).json({
      error: 'Provide at least the history of injury, records summary, or physical exam findings before drafting.',
    });
  }

  // Cap each field so a single oversized paste cannot blow the context.
  const cap = (s, n) => (s.length > n ? s.slice(0, n) + '\n…[truncated]' : s);
  const section = (label, value, limit) =>
    value ? `## ${label}\n${cap(value, limit)}` : `## ${label}\n[Not provided]`;

  const userPrompt = [
    'Draft an Independent Medical Examination (IME) report from the case packet below, applying Missouri Workers’ Compensation Law (RSMo Chapter 287) for causation, MMI, and PPD percentages at the correct statutory level.',
    `Jurisdiction: ${cap(fields.jurisdiction, 200)}`,
    fields.guidesEdition
      ? `Optional rating cross-check requested by Dr. Tess: ${cap(fields.guidesEdition, 200)} (still express final PPD as a Missouri percentage at the statutory level)`
      : 'No AMA Guides edition specified — express PPD as a Missouri percentage at the statutory level under RSMo § 287.190.',
    fields.specificQuestions
      ? `Specific questions the referring party asked Dr. Tess to answer:\n${cap(fields.specificQuestions, 1500)}`
      : '',
    '',
    '--- CASE PACKET ---',
    section('Examinee', fields.examinee, 600),
    section('Case / Claim Information', fields.caseInfo, 800),
    section('Chief Complaint', fields.chiefComplaint, 600),
    section('History of Present Injury', fields.historyOfInjury, 4000),
    section('Past Medical, Surgical, Social & Occupational History', fields.pastHistory, 3000),
    section('Records Reviewed (chronological summary)', fields.recordsReviewed, 20000),
    section('Physical Examination Findings (today)', fields.physicalExam, 6000),
    section('Diagnostic Studies (imaging / EMG / labs)', fields.diagnostics, 4000),
    section('Prior Treatment & Response', fields.priorTreatment, 3000),
    '--- END CASE PACKET ---',
    '',
    'Produce the full IME draft now, following the section order in your instructions. Show the PPD/impairment math step by step. End with the Reviewer Checklist for Dr. Tess.',
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
- For 'physicalExam', extract physical exam findings — ROM in degrees, MRC strength grades, special tests, neurological findings — only what is documented. This is for findings recorded in the source records, not a new exam.
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
      examinee: {
        type: 'string',
        description:
          'Examinee identifiers extracted from the records: full name, DOB, sex, dominant hand if mentioned, employer, occupation at time of injury. One short paragraph.',
      },
      caseInfo: {
        type: 'string',
        description:
          'Claim / case information: date of injury, claim number, insurer/carrier, employer, attorney, referring party, date(s) of examination if present.',
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
      physicalExam: {
        type: 'string',
        description:
          'Physical exam findings as documented in the records (vitals, inspection, palpation, ROM in degrees, MRC strength grades, neurological findings, special tests). Only what is documented.',
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
      'examinee',
      'caseInfo',
      'chiefComplaint',
      'historyOfInjury',
      'pastHistory',
      'recordsReviewed',
      'physicalExam',
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
      examinee: '',
      caseInfo: '',
      chiefComplaint: '',
      historyOfInjury: '',
      pastHistory: '',
      recordsReviewed: '',
      physicalExam: '',
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
    ['examinee', 'caseInfo', 'chiefComplaint'].forEach((k) => {
      const v = parts
        .map((p) => (typeof p[k] === 'string' ? p[k].trim() : ''))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0];
      fields[k] = v || '';
    });
    // Narrative fields: concatenate with paragraph breaks
    ['historyOfInjury', 'pastHistory', 'physicalExam', 'diagnostics', 'priorTreatment', 'notes'].forEach(
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

app.listen(PORT, () => {
  console.log(`Gegventures site running at http://localhost:${PORT}`);
  if (!client) {
    console.warn(
      'ANTHROPIC_API_KEY is not set — the AI chatbot and content studio will return a 503 until you add it.',
    );
  }
});
