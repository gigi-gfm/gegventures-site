// IME Studio — drafts an Independent Medical Examination report for Dr. Tess
// from the case packet she pastes in. Streams the draft as the model produces it.
(function () {
  var form = document.getElementById('imeForm');
  var output = document.getElementById('imeOutput');
  var status = document.getElementById('imeStatus');
  var runBtn = document.getElementById('imeRun');
  var copyBtn = document.getElementById('imeCopy');
  var downloadBtn = document.getElementById('imeDownload');
  var empty = document.getElementById('imeEmpty');
  var banner = document.getElementById('aiBanner');
  if (!form || !output) return;

  var dropZone = document.getElementById('imeDrop');
  var fileInput = document.getElementById('imeFiles');
  var fileList = document.getElementById('imeFileList');
  var extractBtn = document.getElementById('imeExtractBtn');
  var clearBtn = document.getElementById('imeClearFiles');
  var extractStatus = document.getElementById('imeExtractStatus');

  var busy = false;
  var extracting = false;
  var pendingFiles = [];
  var ACCEPTED_MIME = {
    'application/pdf': true,
    'image/png': true,
    'image/jpeg': true,
    'image/jpg': true,
    'image/gif': true,
    'image/webp': true,
  };
  // No artificial file-count limit. Anthropic enforces a 32 MB / 100-page
  // cap per PDF; the server batches files internally if there are many.
  var MAX_BYTES = 32 * 1024 * 1024;

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderFiles() {
    if (!fileList) return;
    fileList.innerHTML = '';
    if (pendingFiles.length === 0) {
      fileList.hidden = true;
      if (clearBtn) clearBtn.hidden = true;
      if (extractBtn) extractBtn.disabled = true;
      return;
    }
    fileList.hidden = false;
    if (clearBtn) clearBtn.hidden = false;
    if (extractBtn) extractBtn.disabled = extracting;
    pendingFiles.forEach(function (file, idx) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.className = 'ime-file__name';
      name.textContent = file.name;
      var size = document.createElement('span');
      size.className = 'ime-file__size';
      size.textContent = formatSize(file.size);
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ime-file__remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        pendingFiles.splice(idx, 1);
        renderFiles();
      });
      li.appendChild(name);
      li.appendChild(size);
      li.appendChild(remove);
      fileList.appendChild(li);
    });
  }

  function addFiles(fileList) {
    var added = 0;
    var rejected = [];
    Array.prototype.forEach.call(fileList, function (file) {
      var type = file.type;
      if (type === 'image/jpg') type = 'image/jpeg';
      if (!ACCEPTED_MIME[type]) {
        rejected.push(file.name + ' (unsupported type)');
        return;
      }
      if (file.size > MAX_BYTES) {
        rejected.push(file.name + ' (over 32 MB — split PDF into smaller files)');
        return;
      }
      pendingFiles.push(file);
      added++;
    });
    renderFiles();
    if (extractStatus) {
      if (rejected.length) {
        extractStatus.textContent =
          'Added ' + added + ' file(s). Skipped: ' + rejected.join(', ');
      } else if (added) {
        extractStatus.textContent =
          added +
          ' file(s) ready. Click "Extract & autofill form" to read them and populate the fields below.';
      }
    }
  }

  if (dropZone) {
    dropZone.addEventListener('click', function () {
      if (fileInput) fileInput.click();
    });
    dropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropZone.classList.add('is-drag');
    });
    dropZone.addEventListener('dragleave', function () {
      dropZone.classList.remove('is-drag');
    });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('is-drag');
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
  }
  if (fileInput) {
    fileInput.addEventListener('change', function (e) {
      if (e.target.files) addFiles(e.target.files);
      // Allow re-selecting the same file later
      fileInput.value = '';
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      pendingFiles = [];
      renderFiles();
      if (extractStatus) extractStatus.textContent = '';
    });
  }

  function readAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = reader.result || '';
        var comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = function () {
        reject(new Error('Could not read ' + file.name));
      };
      reader.readAsDataURL(file);
    });
  }

  function setField(name, value) {
    var el = form.elements[name];
    if (!el || typeof value !== 'string') return;
    if (value.trim()) el.value = value;
  }

  if (extractBtn) {
    extractBtn.addEventListener('click', async function () {
      if (extracting || pendingFiles.length === 0) return;
      extracting = true;
      extractBtn.disabled = true;
      extractBtn.textContent = 'Reading records…';
      if (extractStatus)
        extractStatus.textContent =
          'Uploading and reading ' +
          pendingFiles.length +
          ' file(s). Large PDFs can take 30–120 seconds.';

      try {
        var payload = { files: [] };
        for (var i = 0; i < pendingFiles.length; i++) {
          var f = pendingFiles[i];
          var mediaType = f.type === 'image/jpg' ? 'image/jpeg' : f.type;
          var data = await readAsBase64(f);
          payload.files.push({ name: f.name, mediaType: mediaType, data: data });
        }

        var res = await fetch('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        var json;
        try {
          json = await res.json();
        } catch (e) {
          throw new Error('Server returned an unexpected response.');
        }
        if (!res.ok) throw new Error(json.error || 'Extraction failed.');

        var fields = (json && json.fields) || {};
        setField('addressee', fields.addressee);
        setField('reBlock', fields.reBlock);
        setField('examinee', fields.examinee);
        setField('caseInfo', fields.caseInfo);
        setField('chiefComplaint', fields.chiefComplaint);
        setField('historyOfInjury', fields.historyOfInjury);
        setField('pastHistory', fields.pastHistory);
        setField('recordsReviewed', fields.recordsReviewed);
        setField('priorExamFindings', fields.priorExamFindings);
        // NOTE: physicalExam (today's IME exam by Dr. Tess) is never auto-filled.
        setField('diagnostics', fields.diagnostics);
        setField('priorTreatment', fields.priorTreatment);

        var note =
          'Form filled from your records. Review every field, then enter YOUR exam findings from today’s IME visit in the highlighted "Physical Examination — TODAY" field before drafting.';
        if (fields.notes && fields.notes.trim()) {
          note += ' Extraction notes: ' + fields.notes.trim();
        }
        if (extractStatus) extractStatus.textContent = note;

        var firstField = document.getElementById('examinee');
        if (firstField && firstField.scrollIntoView) {
          firstField.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch (err) {
        if (extractStatus)
          extractStatus.textContent = (err && err.message) || 'Extraction failed.';
      } finally {
        extracting = false;
        extractBtn.disabled = pendingFiles.length === 0;
        extractBtn.textContent = 'Extract & autofill form';
      }
    });
  }

  function setBusy(state) {
    busy = state;
    if (runBtn) {
      runBtn.disabled = state;
      runBtn.textContent = state ? 'Drafting…' : 'Draft IME';
    }
  }

  function readField(name) {
    var el = form.elements[name];
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (busy) return;

    var body = {
      letterDate: readField('letterDate'),
      addressee: readField('addressee'),
      reBlock: readField('reBlock'),
      examinee: readField('examinee'),
      caseInfo: readField('caseInfo'),
      dateOfEval: readField('dateOfEval'),
      followUpConversation: readField('followUpConversation'),
      jurisdiction: readField('jurisdiction'),
      guidesEdition: readField('guidesEdition'),
      specificQuestions: readField('specificQuestions'),
      voiceSamples: readField('voiceSamples'),
      chiefComplaint: readField('chiefComplaint'),
      historyOfInjury: readField('historyOfInjury'),
      pastHistory: readField('pastHistory'),
      recordsReviewed: readField('recordsReviewed'),
      priorExamFindings: readField('priorExamFindings'),
      physicalExam: readField('physicalExam'),
      diagnostics: readField('diagnostics'),
      priorTreatment: readField('priorTreatment'),
    };

    if (
      !body.historyOfInjury &&
      !body.recordsReviewed &&
      !body.physicalExam &&
      !body.priorExamFindings
    ) {
      if (status)
        status.textContent =
          "Add at least the history of injury, records summary, or a physical exam (today's or from records) before drafting.";
      return;
    }

    output.textContent = '';
    output.hidden = false;
    if (empty) empty.hidden = true;
    if (copyBtn) copyBtn.hidden = true;
    if (downloadBtn) downloadBtn.hidden = true;
    if (status) status.textContent = 'Drafting the IME with Claude — this can take 30–90 seconds for a full evaluation…';
    setBusy(true);

    var result = '';
    try {
      await GegAI.streamPost('/api/ime', body, function (chunk) {
        result += chunk;
        output.textContent = result;
        output.scrollTop = output.scrollHeight;
      });
      if (status) {
        status.textContent = result.trim()
          ? 'Draft ready. Review every finding, confirm the § 287.190 schedule level, and edit before signing.'
          : 'No content was returned. Please try again.';
      }
      if (result.trim()) {
        if (copyBtn) copyBtn.hidden = false;
        if (downloadBtn) downloadBtn.hidden = false;
      }
    } catch (err) {
      if (status) status.textContent = err.message || 'Drafting failed. Please try again.';
    } finally {
      setBusy(false);
    }
  });

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(output.textContent).then(
        function () {
          copyBtn.textContent = 'Copied';
          setTimeout(function () {
            copyBtn.textContent = 'Copy';
          }, 1800);
        },
        function () {
          if (status) status.textContent = 'Could not copy — select the text manually.';
        }
      );
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', function () {
      var text = output.textContent || '';
      if (!text.trim()) return;
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = 'ime-draft-' + stamp + '.md';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
    });
  }

  GegAI.getStatus().then(function (s) {
    if (!s.aiConfigured && banner) banner.hidden = false;
  });

  // Hand the patient/case context over to the RTW page, opened in a new tab.
  var rtwBtn = document.getElementById('rtwHandoffBtn');
  if (rtwBtn) {
    rtwBtn.addEventListener('click', function () {
      var examinee = readField('examinee');
      var caseInfo = readField('caseInfo');
      var chief = readField('chiefComplaint');
      var history = readField('historyOfInjury');

      // Brief medical context for the RTW letter — kept short, HR-appropriate.
      var brief = '';
      if (chief) brief = chief;
      if (history) brief = brief ? brief + '\n\n' + history : history;
      if (brief.length > 600) brief = brief.slice(0, 600) + '…';

      var payload = {
        patient: examinee,
        employer: caseInfo,
        reasonForLetter: brief,
      };
      try {
        localStorage.setItem('rtw_handoff', JSON.stringify(payload));
      } catch (e) {
        /* ignore — RTW page will just open blank */
      }
      window.open('return-to-work.html', '_blank');
    });
  }

  // Hand the patient/case context over to the Referral page, opened in a new tab.
  var refBtn = document.getElementById('referralHandoffBtn');
  if (refBtn) {
    refBtn.addEventListener('click', function () {
      var examinee = readField('examinee');
      var chief = readField('chiefComplaint');
      var history = readField('historyOfInjury');
      var past = readField('pastHistory');
      var dx = readField('diagnostics');
      var priorTx = readField('priorTreatment');
      var todayExam = readField('physicalExam');
      var priorExam = readField('priorExamFindings');

      var clinicalHistory = [chief, history, past].filter(Boolean).join('\n\n');
      var examLabsImaging = [todayExam, priorExam, dx].filter(Boolean).join('\n\n');

      var payload = {
        patient: examinee,
        reason: chief || history.slice(0, 300),
        clinicalHistory: clinicalHistory,
        examLabsImaging: examLabsImaging,
        medications: priorTx,
      };
      try {
        localStorage.setItem('referral_handoff', JSON.stringify(payload));
      } catch (e) {
        /* ignore */
      }
      window.open('referral.html', '_blank');
    });
  }


  // =====================================================================
  // Case persistence (server-backed). Replaces the old localStorage tracker.
  // =====================================================================
  var HOURLY_RATE = 300;
  var RETAINER = 1500;

  // Form fields that we round-trip to the server as case.data JSON.
  var DATA_FIELDS = [
    'letterDate', 'addressee', 'reBlock',
    'examinee', 'caseInfo', 'followUpConversation',
    'jurisdiction', 'guidesEdition', 'specificQuestions', 'voiceSamples',
    'chiefComplaint', 'historyOfInjury', 'pastHistory', 'recordsReviewed',
    'priorExamFindings', 'physicalExam',
    'diagnostics', 'priorTreatment',
  ];

  var caseId = (function () {
    var p = new URLSearchParams(window.location.search).get('case');
    var n = parseInt(p, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  var caseObj = null; // latest server-side case
  var entries = []; // latest entries list
  var timerState = null;
  var localTimerStartedAt = null; // mirror of timerState for live tick

  // Tracker DOM
  var caseInputEl = document.getElementById('trackerCase');
  var toggleEl = document.getElementById('trackerToggle');
  var liveEl = document.getElementById('trackerLive');
  var actInput = document.getElementById('trackerActivity');
  var hoursInput = document.getElementById('trackerHours');
  var addBtn = document.getElementById('trackerAdd');
  var resetBtn = document.getElementById('trackerReset');
  var table = document.getElementById('trackerTable');
  var entriesBody = document.getElementById('trackerEntries');
  var totalHoursEl = document.getElementById('trackerTotalHours');
  var billedEl = document.getElementById('trackerBilled');
  var balanceEl = document.getElementById('trackerBalance');
  var retainerDateEl = document.getElementById('trackerRetainerDate');
  var recordsDateEl = document.getElementById('trackerRecordsDate');
  var examDateEl = document.getElementById('trackerExamDate');
  var softEl = document.getElementById('trackerSoftDeadline');
  var hardEl = document.getElementById('trackerHardDeadline');
  var statusEl = document.getElementById('trackerDeadlineStatus');

  function addBusinessDays(dateStr, n) {
    if (!dateStr) return '';
    var parts = dateStr.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var added = 0;
    while (added < n) {
      d.setDate(d.getDate() + 1);
      var day = d.getDay();
      if (day !== 0 && day !== 6) added++;
    }
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function daysBetween(aStr, bStr) {
    if (!aStr || !bStr) return null;
    return Math.round((new Date(bStr + 'T12:00:00') - new Date(aStr + 'T12:00:00')) / 86400000);
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function formatHuman(iso) {
    if (!iso) return '';
    var parts = iso.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function fmtTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function fmtMoney(n) {
    var neg = n < 0;
    var abs = Math.abs(n).toFixed(2);
    return (neg ? '−$' : '$') + abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ---- Server I/O ----
  async function fetchCase() {
    if (!caseId) return;
    var res = await fetch('/api/cases/' + caseId);
    if (res.status === 401) {
      window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname + window.location.search);
      return;
    }
    if (!res.ok) {
      window.location.href = '/cases.html';
      return;
    }
    var data = await res.json();
    caseObj = data.case;
    entries = data.entries || [];
    timerState = data.timer || null;
    localTimerStartedAt = timerState ? new Date(timerState.startedAt + 'Z').getTime() : null;
    populateFromCase();
    renderTracker();
  }

  async function patchCase(patch) {
    if (!caseId) return;
    var res = await fetch('/api/cases/' + caseId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      var data = await res.json();
      caseObj = data.case;
    }
  }

  // Auto-save on form-field change, debounced.
  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveFormData, 700);
  }
  function gatherFormData() {
    var out = {};
    DATA_FIELDS.forEach(function (k) {
      var el = form.elements[k];
      if (el) out[k] = el.value;
    });
    // dateOfEval (the IME form's exam date) is kept in sync with examDateEl
    // when the tracker exam-date changes. We also save whatever's typed.
    if (form.elements.dateOfEval) out.dateOfEval = form.elements.dateOfEval.value;
    return out;
  }
  async function saveFormData() {
    if (!caseId) return;
    await patchCase({ data: gatherFormData() });
  }

  // ---- Populate the page from a fetched case ----
  function populateFromCase() {
    if (!caseObj) return;

    // Case label (the tracker's case-label input)
    if (caseInputEl && document.activeElement !== caseInputEl) {
      caseInputEl.value = caseObj.label || '';
    }

    // Date fields
    if (retainerDateEl && document.activeElement !== retainerDateEl)
      retainerDateEl.value = caseObj.retainerDate || '';
    if (recordsDateEl && document.activeElement !== recordsDateEl)
      recordsDateEl.value = caseObj.recordsDate || '';
    if (examDateEl && document.activeElement !== examDateEl)
      examDateEl.value = caseObj.examDate || '';
    if (softEl && document.activeElement !== softEl)
      softEl.value = caseObj.softDeadline || '';
    if (hardEl && document.activeElement !== hardEl)
      hardEl.value = caseObj.hardDeadline || '';

    // Form fields from case.data
    var d = caseObj.data || {};
    DATA_FIELDS.forEach(function (k) {
      var el = form.elements[k];
      if (el && typeof d[k] === 'string' && document.activeElement !== el) {
        el.value = d[k];
      }
    });
    if (form.elements.dateOfEval && typeof d.dateOfEval === 'string' && document.activeElement !== form.elements.dateOfEval) {
      form.elements.dateOfEval.value = d.dateOfEval;
    }

    // Previously saved IME draft
    if (caseObj.imeDraft && caseObj.imeDraft.trim()) {
      output.textContent = caseObj.imeDraft;
      output.hidden = false;
      if (empty) empty.hidden = true;
      if (copyBtn) copyBtn.hidden = false;
      if (downloadBtn) downloadBtn.hidden = false;
    }
  }

  // ---- Tracker render ----
  function renderTracker() {
    // Live timer
    var liveSeconds = 0;
    if (localTimerStartedAt) {
      liveSeconds = (Date.now() - localTimerStartedAt) / 1000;
      if (toggleEl) {
        toggleEl.textContent = 'Stop timer';
        toggleEl.classList.add('btn--ghost');
        toggleEl.classList.remove('btn--primary');
      }
    } else if (toggleEl) {
      toggleEl.textContent = 'Start timer';
      toggleEl.classList.add('btn--primary');
      toggleEl.classList.remove('btn--ghost');
    }
    if (liveEl) liveEl.textContent = fmtTime(liveSeconds);

    // Entries table
    if (entriesBody) {
      entriesBody.innerHTML = '';
      if (!entries.length) {
        if (table) table.hidden = true;
      } else {
        if (table) table.hidden = false;
        entries.forEach(function (e) {
          var tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + escapeHtml(e.entryDate || '') + '</td>' +
            '<td>' + escapeHtml(e.activity || '') + '</td>' +
            '<td>' + Number(e.hours).toFixed(2) + '</td>' +
            '<td><button type="button" data-eid="' + e.id + '">Remove</button></td>';
          entriesBody.appendChild(tr);
        });
        entriesBody.querySelectorAll('button[data-eid]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            var eid = btn.getAttribute('data-eid');
            await fetch('/api/cases/' + caseId + '/entries/' + eid, { method: 'DELETE' });
            await fetchCase();
          });
        });
      }
    }

    // Totals
    var loggedHours = entries.reduce(function (s, e) { return s + (Number(e.hours) || 0); }, 0);
    var liveHours = liveSeconds / 3600;
    var totalHours = loggedHours + liveHours;
    var billed = totalHours * HOURLY_RATE;
    var balance = billed - RETAINER;
    if (totalHoursEl) totalHoursEl.textContent = totalHours.toFixed(2);
    if (billedEl) billedEl.textContent = fmtMoney(billed);
    if (balanceEl) balanceEl.textContent = fmtMoney(balance);

    // Deadline banner
    if (statusEl) {
      statusEl.className = 'ime-tracker__deadline-status';
      if (caseObj && caseObj.hardDeadline) {
        var dh = daysBetween(todayISO(), caseObj.hardDeadline);
        var ds = caseObj.softDeadline ? daysBetween(todayISO(), caseObj.softDeadline) : null;
        var msg = '';
        if (dh < 0) {
          msg = 'OVERDUE — hard deadline was ' + formatHuman(caseObj.hardDeadline) +
            ' (' + Math.abs(dh) + ' day' + (Math.abs(dh) === 1 ? '' : 's') + ' ago).';
          statusEl.classList.add('is-overdue');
        } else if (dh === 0) {
          msg = 'Hard deadline is TODAY (' + formatHuman(caseObj.hardDeadline) + ').';
          statusEl.classList.add('is-overdue');
        } else if (ds !== null && ds < 0) {
          msg = 'Past soft deadline (' + formatHuman(caseObj.softDeadline) + '). ' +
            dh + ' day' + (dh === 1 ? '' : 's') + ' until hard deadline (' + formatHuman(caseObj.hardDeadline) + ').';
          statusEl.classList.add('is-warning');
        } else if (ds !== null) {
          msg = ds + ' day' + (ds === 1 ? '' : 's') + ' until soft deadline (' + formatHuman(caseObj.softDeadline) + '), ' +
            dh + ' until hard deadline (' + formatHuman(caseObj.hardDeadline) + ').';
        } else {
          msg = dh + ' day' + (dh === 1 ? '' : 's') + ' until hard deadline (' + formatHuman(caseObj.hardDeadline) + ').';
        }
        statusEl.textContent = msg;
        statusEl.hidden = false;
      } else {
        statusEl.hidden = true;
      }
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[<>&"]/g, function (ch) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch];
    });
  }

  // ---- Wire form-field auto-save ----
  function wireAutoSave() {
    DATA_FIELDS.concat(['dateOfEval']).forEach(function (k) {
      var el = form.elements[k];
      if (!el) return;
      el.addEventListener('input', scheduleSave);
      el.addEventListener('change', scheduleSave);
    });
  }

  // ---- Wire tracker UI ----
  if (caseInputEl) {
    caseInputEl.addEventListener('change', function () {
      patchCase({ label: caseInputEl.value.trim() || 'Untitled case' });
    });
  }
  if (retainerDateEl) {
    retainerDateEl.addEventListener('change', function () {
      patchCase({ retainerDate: retainerDateEl.value });
    });
  }
  if (recordsDateEl) {
    recordsDateEl.addEventListener('change', function () {
      patchCase({ recordsDate: recordsDateEl.value });
    });
  }
  if (examDateEl) {
    examDateEl.addEventListener('change', async function () {
      var patch = { examDate: examDateEl.value };
      // Always recompute deadlines from the exam date.
      if (examDateEl.value) {
        patch.softDeadline = addBusinessDays(examDateEl.value, 7);
        patch.hardDeadline = addBusinessDays(examDateEl.value, 10);
      }
      // Mirror the IME letter's "Date of physical examination" field
      // so the drafted letter's Physical Exam header gets the right date.
      var formExamDate = document.getElementById('dateOfEval');
      if (formExamDate && examDateEl.value) {
        var parts = examDateEl.value.split('-');
        var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        formExamDate.value = months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
        scheduleSave();
      }
      await patchCase(patch);
      // Re-fetch so the deadline inputs pick up the auto-fill.
      await fetchCase();
    });
  }
  if (softEl) {
    softEl.addEventListener('change', function () {
      patchCase({ softDeadline: softEl.value });
    });
  }
  if (hardEl) {
    hardEl.addEventListener('change', function () {
      patchCase({ hardDeadline: hardEl.value });
    });
  }

  if (toggleEl) {
    toggleEl.addEventListener('click', async function () {
      if (!caseId) return;
      if (localTimerStartedAt) {
        var res = await fetch('/api/cases/' + caseId + '/timer/stop', { method: 'POST' });
        if (res.ok) await fetchCase();
      } else {
        var res2 = await fetch('/api/cases/' + caseId + '/timer/start', { method: 'POST' });
        if (res2.ok) await fetchCase();
      }
    });
  }

  if (addBtn) {
    addBtn.addEventListener('click', async function () {
      var hours = Number(hoursInput.value);
      if (!hours || hours <= 0 || !caseId) return;
      await fetch('/api/cases/' + caseId + '/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryDate: todayISO(),
          activity: (actInput.value || 'Activity').trim(),
          hours: hours,
        }),
      });
      actInput.value = '';
      hoursInput.value = '';
      await fetchCase();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', async function () {
      if (!confirm('Delete all time entries for this case? (Dates and form data are kept.)')) return;
      // Delete each entry sequentially.
      for (var i = 0; i < entries.length; i++) {
        await fetch('/api/cases/' + caseId + '/entries/' + entries[i].id, { method: 'DELETE' });
      }
      await fetchCase();
    });
  }

  // Save the streamed IME draft to the case once it finishes.
  // The existing form-submit handler already streams into `output.textContent`;
  // we hook a save by patching after the submit completes.
  var origSubmit = form.onsubmit;
  form.addEventListener('submit', function () {
    // After the draft streams (race-safe via setInterval) save when output stabilizes.
    var lastLen = -1;
    var stabilizeTimer = null;
    var checks = 0;
    function check() {
      checks++;
      var len = (output.textContent || '').length;
      if (len === lastLen && len > 0) {
        clearInterval(stabilizeTimer);
        patchCase({ imeDraft: output.textContent });
      } else if (checks > 240) { // ~ 4 min timeout
        clearInterval(stabilizeTimer);
      }
      lastLen = len;
    }
    setTimeout(function () { stabilizeTimer = setInterval(check, 1000); }, 2000);
  });

  // Live tick for the running timer.
  setInterval(function () {
    if (localTimerStartedAt) renderTracker();
  }, 1000);

  // Default letter date to today, in "Month D, YYYY" format Dr. Garcia uses.
  var letterDateInput = document.getElementById('letterDate');
  if (letterDateInput && !letterDateInput.value) {
    var today = new Date();
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    letterDateInput.value = months[today.getMonth()] + ' ' + today.getDate() + ', ' + today.getFullYear();
  }

  // Boot: if no case ID, send the user to the dashboard to pick one.
  if (!caseId) {
    window.location.href = '/cases.html';
  } else {
    wireAutoSave();
    fetchCase();
  }
})();
