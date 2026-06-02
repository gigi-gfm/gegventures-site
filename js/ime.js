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

  // -------- Case time tracker --------
  // Tracks billable hours per case. Persists to localStorage so it survives
  // page reloads and tab close/reopen. One "case" is identified by the label
  // typed in the Case label field (defaults to "default").
  (function setupTracker() {
    var HOURLY_RATE = 300;
    var RETAINER = 1500;
    var caseInput = document.getElementById('trackerCase');
    var toggle = document.getElementById('trackerToggle');
    var live = document.getElementById('trackerLive');
    var actInput = document.getElementById('trackerActivity');
    var hoursInput = document.getElementById('trackerHours');
    var addBtn = document.getElementById('trackerAdd');
    var resetBtn = document.getElementById('trackerReset');
    var table = document.getElementById('trackerTable');
    var entriesBody = document.getElementById('trackerEntries');
    var totalHoursEl = document.getElementById('trackerTotalHours');
    var billedEl = document.getElementById('trackerBilled');
    var balanceEl = document.getElementById('trackerBalance');
    if (!toggle || !caseInput) return;

    var STORE_KEY = 'ime_tracker_v1';

    function loadStore() {
      try {
        var raw = localStorage.getItem(STORE_KEY);
        if (!raw) return { cases: {}, activeCase: '' };
        var data = JSON.parse(raw);
        if (!data.cases) data.cases = {};
        return data;
      } catch (e) {
        return { cases: {}, activeCase: '' };
      }
    }
    function saveStore(store) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
      } catch (e) { /* full or denied — ignore */ }
    }
    function caseKey() {
      var v = caseInput.value.trim();
      return v || 'default';
    }
    function getCase(store) {
      var k = caseKey();
      if (!store.cases[k]) store.cases[k] = { entries: [], startedAt: 0 };
      return store.cases[k];
    }
    function fmtTime(seconds) {
      seconds = Math.max(0, Math.floor(seconds));
      var h = Math.floor(seconds / 3600);
      var m = Math.floor((seconds % 3600) / 60);
      var s = seconds % 60;
      return (
        String(h).padStart(2, '0') + ':' +
        String(m).padStart(2, '0') + ':' +
        String(s).padStart(2, '0')
      );
    }
    function fmtMoney(n) {
      var neg = n < 0;
      var abs = Math.abs(n).toFixed(2);
      return (neg ? '−$' : '$') + abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function render() {
      var store = loadStore();
      var c = getCase(store);

      // Live timer
      var liveSeconds = 0;
      if (c.startedAt) {
        liveSeconds = (Date.now() - c.startedAt) / 1000;
        toggle.textContent = 'Stop timer';
        toggle.classList.add('btn--ghost');
        toggle.classList.remove('btn--primary');
      } else {
        toggle.textContent = 'Start timer';
        toggle.classList.add('btn--primary');
        toggle.classList.remove('btn--ghost');
      }
      live.textContent = fmtTime(liveSeconds);

      // Entries table
      entriesBody.innerHTML = '';
      if (!c.entries.length) {
        table.hidden = true;
      } else {
        table.hidden = false;
        c.entries.forEach(function (e, idx) {
          var tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + (e.date || '') + '</td>' +
            '<td>' + (e.activity || '').replace(/[<>&]/g, function (ch) {
              return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch];
            }) + '</td>' +
            '<td>' + Number(e.hours).toFixed(2) + '</td>' +
            '<td><button type="button" data-remove="' + idx + '">Remove</button></td>';
          entriesBody.appendChild(tr);
        });
        entriesBody.querySelectorAll('button[data-remove]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var i = Number(btn.getAttribute('data-remove'));
            var s = loadStore();
            var cc = getCase(s);
            cc.entries.splice(i, 1);
            saveStore(s);
            render();
          });
        });
      }

      // Totals
      var loggedHours = c.entries.reduce(function (sum, e) {
        return sum + (Number(e.hours) || 0);
      }, 0);
      var liveHours = liveSeconds / 3600;
      var totalHours = loggedHours + liveHours;
      var billed = totalHours * HOURLY_RATE;
      var balance = billed - RETAINER;
      totalHoursEl.textContent = totalHours.toFixed(2);
      billedEl.textContent = fmtMoney(billed);
      balanceEl.textContent = fmtMoney(balance);
    }

    // Live tick while a timer is running.
    setInterval(function () {
      var store = loadStore();
      if (getCase(store).startedAt) render();
    }, 1000);

    toggle.addEventListener('click', function () {
      var store = loadStore();
      var c = getCase(store);
      if (c.startedAt) {
        // Stop — convert elapsed to a logged entry rounded to nearest 0.25 hr
        var elapsedHours = (Date.now() - c.startedAt) / 1000 / 3600;
        var rounded = Math.round(elapsedHours * 4) / 4;
        if (rounded > 0) {
          c.entries.push({
            date: new Date().toISOString().slice(0, 10),
            activity: 'Timer session',
            hours: rounded,
          });
        }
        c.startedAt = 0;
      } else {
        c.startedAt = Date.now();
      }
      saveStore(store);
      render();
    });

    addBtn.addEventListener('click', function () {
      var hours = Number(hoursInput.value);
      if (!hours || hours <= 0) return;
      var store = loadStore();
      var c = getCase(store);
      c.entries.push({
        date: new Date().toISOString().slice(0, 10),
        activity: (actInput.value || 'Activity').trim(),
        hours: hours,
      });
      saveStore(store);
      actInput.value = '';
      hoursInput.value = '';
      render();
    });

    resetBtn.addEventListener('click', function () {
      if (!confirm('Reset the tracker for "' + caseKey() + '"? This deletes all logged entries for this case.')) return;
      var store = loadStore();
      delete store.cases[caseKey()];
      saveStore(store);
      render();
    });

    caseInput.addEventListener('change', function () {
      var store = loadStore();
      store.activeCase = caseKey();
      saveStore(store);
      render();
    });
    caseInput.addEventListener('input', render);

    // Restore last active case label.
    var store = loadStore();
    if (store.activeCase) caseInput.value = store.activeCase;
    render();
  })();

  // Default letter date to today, in "Month D, YYYY" format Dr. Garcia uses.
  var letterDateInput = document.getElementById('letterDate');
  if (letterDateInput && !letterDateInput.value) {
    var today = new Date();
    var months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    letterDateInput.value =
      months[today.getMonth()] + ' ' + today.getDate() + ', ' + today.getFullYear();
  }
})();
