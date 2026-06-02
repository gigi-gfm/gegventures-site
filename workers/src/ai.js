// AI endpoints: IME draft, RTW letter, referral letter, records extraction,
// VoiceRx proxy. Streams text responses from Anthropic back to the client.

import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from './auth.js';
import {
  IME_SYSTEM,
  REFERRAL_SYSTEM,
  RTW_SYSTEM,
  EXTRACT_SYSTEM,
  EXTRACT_TOOL,
  ALLOWED_MEDIA,
  ANTHROPIC_PER_FILE_BYTES,
  EXTRACT_BATCH_FILES,
} from './prompts.js';

const MODEL = 'claude-opus-4-7';

export const aiRouter = new Hono();

function getClient(env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

function requireClient(c) {
  const client = getClient(c.env);
  if (!client) {
    return c.json(
      { error: 'ANTHROPIC_API_KEY is not set on the Worker. Use `wrangler secret put ANTHROPIC_API_KEY`.' },
      503,
    );
  }
  return client;
}

const cap = (s, n) => (s && s.length > n ? s.slice(0, n) + '\n…[truncated]' : (s || ''));
const section = (label, value, limit, ifMissing = '[Not provided]') =>
  value ? `## ${label}\n${cap(value, limit)}` : `## ${label}\n${ifMissing}`;

// Stream text from Claude back to the client as a plain-text response.
async function streamCompletion(c, params) {
  const client = getClient(c.env);
  if (!client) {
    return c.json(
      { error: 'ANTHROPIC_API_KEY is not set on the Worker.' },
      503,
    );
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const sdkStream = client.messages.stream(params);
        sdkStream.on('text', (delta) => {
          controller.enqueue(encoder.encode(delta));
        });
        await sdkStream.finalMessage();
        controller.close();
      } catch (err) {
        const msg = '\n\n[Stream error: ' + (err.message || err) + ']';
        try { controller.enqueue(encoder.encode(msg)); } catch {}
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}

// =====================================================================
// /api/ime  — Independent Medical Evaluation letter draft
// =====================================================================
aiRouter.post('/ime', requireAuth, async (c) => {
  const client = requireClient(c); if (client instanceof Response) return client;
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const str = (k) => (typeof body?.[k] === 'string' ? body[k].trim() : '');
  const fields = {
    letterDate: str('letterDate'),
    addressee: str('addressee'),
    reBlock: str('reBlock'),
    dateOfEval: str('dateOfEval'),
    followUpConversation: str('followUpConversation'),
    examinee: str('examinee'),
    caseInfo: str('caseInfo'),
    chiefComplaint: str('chiefComplaint'),
    historyOfInjury: str('historyOfInjury'),
    pastHistory: str('pastHistory'),
    recordsReviewed: str('recordsReviewed'),
    priorExamFindings: str('priorExamFindings'),
    physicalExam: str('physicalExam'),
    diagnostics: str('diagnostics'),
    priorTreatment: str('priorTreatment'),
    guidesEdition: str('guidesEdition'),
    jurisdiction: str('jurisdiction') || 'Missouri Workers’ Compensation (RSMo Chapter 287)',
    specificQuestions: str('specificQuestions'),
    voiceSamples: str('voiceSamples'),
  };
  if (
    !fields.historyOfInjury && !fields.recordsReviewed &&
    !fields.physicalExam && !fields.priorExamFindings
  ) {
    return c.json({
      error: 'Provide at least the history of injury, records summary, or a physical exam (today or from records) before drafting.',
    }, 400);
  }
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
      fields.dateOfEval, 100),
    section('Follow-up phone conversation details (with interpreter if applicable)', fields.followUpConversation, 1500),
    section('Chief Complaint', fields.chiefComplaint, 600),
    section('History of Present Injury / Description of Injury', fields.historyOfInjury, 6000),
    section('Past Medical / Surgical / Family / Social / Occupational History', fields.pastHistory, 3000),
    section('Records Reviewed (chronological summary, source-by-source)', fields.recordsReviewed, 25000),
    section("Prior Physical Exam Findings (from records — for Review of Records narrative; NOT today's exam)", fields.priorExamFindings, 8000),
    section("Physical Examination — TODAY at the IME visit (performed by Dr. Garcia — this populates the Physical Exam section of the letter)", fields.physicalExam, 6000),
    section('Diagnostic Studies (imaging / EMG / labs — as reported)', fields.diagnostics, 4000),
    section('Prior Treatment & Response', fields.priorTreatment, 3000),
    '--- END CASE PACKET ---',
    '',
    'Produce the full IME now, in Dr. Garcia’s established format. The IME (the entire letter) must read in her first-person voice with the question-and-answer Discussion section. The Physical Exam section header MUST include the date the examination was performed (from the DATE OF PHYSICAL EXAMINATION field above). End with her exact closing paragraph, her signature block (Theresa C. Garcia MD, FAAFP, Dipl. ABOM / NPI #1275549974 / Missouri License #2000160495), and then a horizontal rule followed by the Reviewer Checklist for Dr. Garcia (working aid, not part of the IME).',
  ].filter(Boolean).join('\n');
  return await streamCompletion(c, {
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: IME_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });
});

// =====================================================================
// /api/referral
// =====================================================================
aiRouter.post('/referral', requireAuth, async (c) => {
  const client = requireClient(c); if (client instanceof Response) return client;
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const str = (k) => (typeof body?.[k] === 'string' ? body[k].trim() : '');
  const f = {
    letterDate: str('letterDate'),
    patient: str('patient'),
    recipient: str('recipient'),
    specialty: str('specialty'),
    reason: str('reason'),
    clinicalHistory: str('clinicalHistory'),
    examLabsImaging: str('examLabsImaging'),
    medications: str('medications'),
    urgency: str('urgency'),
  };
  if (!f.patient || !f.recipient || !f.reason) {
    return c.json({ error: 'Patient, recipient, and reason for referral are all required.' }, 400);
  }
  const sec = (label, value, limit) => (value ? `## ${label}\n${cap(value, limit)}` : '');
  const userPrompt = [
    'Draft a referral letter from Garcia Family Medicine using the case packet below. Use the established letterhead, format, and signature block.',
    `Date of letter: ${f.letterDate || '[Use today]'}`,
    sec('Patient (name, DOB, MRN, contact)', f.patient, 400),
    sec('Recipient (specialist name, practice, address)', f.recipient, 500),
    sec('Specialty / focus', f.specialty, 200),
    sec('Reason for referral / clinical question', f.reason, 800),
    sec('Relevant clinical history', f.clinicalHistory, 2500),
    sec('Pertinent exam, labs, imaging', f.examLabsImaging, 2500),
    sec('Current medications and prior treatment tried', f.medications, 1500),
    sec('Urgency / timing', f.urgency, 200),
  ].filter(Boolean).join('\n');
  return await streamCompletion(c, {
    model: MODEL,
    max_tokens: 4000,
    system: REFERRAL_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });
});

// =====================================================================
// /api/return-to-work
// =====================================================================
aiRouter.post('/return-to-work', requireAuth, async (c) => {
  const client = requireClient(c); if (client instanceof Response) return client;
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const str = (k) => (typeof body?.[k] === 'string' ? body[k].trim() : '');
  const f = {
    letterDate: str('letterDate'),
    patient: str('patient'),
    employer: str('employer'),
    workStatus: str('workStatus'),
    effectiveDates: str('effectiveDates'),
    restrictions: str('restrictions'),
    reasonForLetter: str('reasonForLetter'),
    followUp: str('followUp'),
  };
  if (!f.patient || !f.workStatus) {
    return c.json({ error: 'Patient and work status are required.' }, 400);
  }
  const sec = (label, value, limit) => (value ? `## ${label}\n${cap(value, limit)}` : '');
  const userPrompt = [
    'Draft a return-to-work / work-status letter from Garcia Family Medicine using the case packet below.',
    `Date of letter: ${f.letterDate || '[Use today]'}`,
    sec('Patient (name, DOB)', f.patient, 300),
    sec('Employer / HR contact (if known)', f.employer, 400),
    sec('Work status (off work / light duty / full duty)', f.workStatus, 200),
    sec('Effective dates (start through end / next eval)', f.effectiveDates, 200),
    sec('Restrictions (if light duty)', f.restrictions, 1500),
    sec('Reason for letter / brief medical context', f.reasonForLetter, 800),
    sec('Next follow-up appointment', f.followUp, 200),
  ].filter(Boolean).join('\n');
  return await streamCompletion(c, {
    model: MODEL,
    max_tokens: 3000,
    system: RTW_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });
});

// =====================================================================
// /api/extract — records extraction via tool use
// =====================================================================
aiRouter.post('/extract', requireAuth, async (c) => {
  const client = getClient(c.env);
  if (!client) return c.json({ error: 'ANTHROPIC_API_KEY is not set on the Worker.' }, 503);

  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const files = Array.isArray(body?.files) ? body.files : [];
  if (files.length === 0) return c.json({ error: 'Upload at least one medical record file.' }, 400);

  const prepared = [];
  for (const file of files) {
    if (!file || typeof file.data !== 'string' || typeof file.mediaType !== 'string') {
      return c.json({ error: 'Each file must include mediaType and base64 data.' }, 400);
    }
    const kind = ALLOWED_MEDIA[file.mediaType];
    if (!kind) {
      return c.json({ error: `Unsupported file type "${file.mediaType}". Use PDF, JPEG, PNG, GIF, or WebP.` }, 400);
    }
    const approxBytes = Math.floor((file.data.length * 3) / 4);
    if (approxBytes > ANTHROPIC_PER_FILE_BYTES) {
      return c.json({
        error:
          `${file.name || 'A file'} is ${(approxBytes / 1024 / 1024).toFixed(1)} MB — the Anthropic API limits a single PDF to 32 MB / 100 pages. ` +
          'Split that file into smaller PDFs (e.g. one PDF per provider) and re-upload — there is no limit on how many PDFs you can upload.',
      }, 400);
    }
    prepared.push({
      name: file.name || 'document',
      block: { type: kind, source: { type: 'base64', media_type: file.mediaType, data: file.data } },
    });
  }

  const batches = [];
  for (let i = 0; i < prepared.length; i += EXTRACT_BATCH_FILES) {
    batches.push(prepared.slice(i, i + EXTRACT_BATCH_FILES));
  }
  async function extractBatch(batch, idx) {
    const content = batch.map((b) => b.block);
    content.push({
      type: 'text',
      text: batches.length > 1
        ? `This is batch ${idx + 1} of ${batches.length} from a larger medical-records packet for the same examinee. Read every document above carefully and call populate_case_packet exactly once with everything extractable from THIS batch. A later merge step will combine batches — so be exhaustive in recordsReviewed (every document, in chronological order, with dates and providers).`
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
      throw new Error('The model did not return structured fields for batch ' + (idx + 1) + '.');
    }
    return toolUse.input;
  }

  function mergeFields(parts) {
    const fields = {
      addressee: '', reBlock: '', examinee: '', caseInfo: '',
      chiefComplaint: '', historyOfInjury: '', pastHistory: '',
      recordsReviewed: '', priorExamFindings: '', diagnostics: '',
      priorTreatment: '', notes: '',
    };
    const join = (key, sep) => {
      const values = parts.map((p) => (typeof p[key] === 'string' ? p[key].trim() : '')).filter(Boolean);
      const seen = new Set();
      fields[key] = values.filter((v) => (seen.has(v) ? false : (seen.add(v), true))).join(sep);
    };
    ['addressee', 'reBlock', 'examinee', 'caseInfo', 'chiefComplaint'].forEach((k) => {
      const v = parts.map((p) => (typeof p[k] === 'string' ? p[k].trim() : '')).filter(Boolean).sort((a, b) => b.length - a.length)[0];
      fields[k] = v || '';
    });
    ['historyOfInjury', 'pastHistory', 'priorExamFindings', 'diagnostics', 'priorTreatment', 'notes'].forEach((k) => join(k, '\n\n'));
    const records = [];
    const seen = new Set();
    for (const p of parts) {
      for (const line of String(p.recordsReviewed || '').split('\n')) {
        const t = line.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        records.push(t);
      }
    }
    records.sort((a, b) => {
      const da = (a.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/) || [])[0];
      const dbm = (b.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/) || [])[0];
      if (!da && !dbm) return 0;
      if (!da) return 1;
      if (!dbm) return -1;
      return new Date(da) - new Date(dbm);
    });
    fields.recordsReviewed = records.join('\n');
    return fields;
  }

  try {
    const results = await Promise.all(batches.map((b, i) => extractBatch(b, i)));
    const merged = results.length === 1 ? results[0] : mergeFields(results);
    return c.json({ fields: merged, batches: results.length, files: prepared.length });
  } catch (err) {
    return c.json({
      error: err.message || 'Extraction failed. Confirm the files are readable PDFs or clear scans and try again.',
    }, 500);
  }
});

// =====================================================================
// /api/voicerx/* — proxy to voicerx-api
// =====================================================================
async function voicerxFetch(env, path) {
  if (!env.VOICERX_TOKEN) return { ok: false, status: 503, json: { error: 'VoiceRx integration not configured — set VOICERX_TOKEN as a Worker secret.' } };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    // Prefer the Service Binding to voicerx-api when available — this
    // avoids Cloudflare error 1042 (Worker-to-Worker routing loop on
    // the same zone). Fall back to the public URL when the binding
    // isn't wired (e.g. local dev without a service binding).
    const url = (env.VOICERX_API_URL || 'https://voicerx-api.winter-shadow-e82d.workers.dev').replace(/\/+$/, '') + path;
    const init = {
      headers: { Authorization: 'Bearer ' + env.VOICERX_TOKEN },
      signal: controller.signal,
    };
    const r = env.VOICERX_API
      ? await env.VOICERX_API.fetch(new Request(url, init))
      : await fetch(url, init);
    clearTimeout(timeout);
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { ok: r.ok, status: r.status, json: parsed };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { ok: false, status: 504, json: { error: 'VoiceRx timed out after 15 seconds.' } };
    }
    return { ok: false, status: 502, json: { error: 'VoiceRx unreachable: ' + (err.message || err) } };
  }
}

aiRouter.get('/voicerx/status', requireAuth, async (c) => {
  if (!c.env.VOICERX_TOKEN) return c.json({ configured: false });
  const r = await voicerxFetch(c.env, '/whoami');
  return c.json({
    configured: true,
    reachable: r.ok,
    apiUrl: (c.env.VOICERX_API_URL || 'https://voicerx-api.winter-shadow-e82d.workers.dev'),
    provider: r.ok ? r.json : null,
    error: r.ok ? null : r.json?.error || 'unknown',
  });
});

aiRouter.get('/voicerx/notes', requireAuth, async (c) => {
  const r = await voicerxFetch(c.env, '/notes');
  return c.json(r.json, r.status);
});

aiRouter.get('/voicerx/notes/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!/^[\w-]+$/.test(id)) return c.json({ error: 'Bad note id.' }, 400);
  const r = await voicerxFetch(c.env, '/notes/' + id);
  return c.json(r.json, r.status);
});
