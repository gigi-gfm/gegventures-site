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
  var MAX_FILES = 8;
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
      if (pendingFiles.length >= MAX_FILES) {
        rejected.push(file.name + ' (limit ' + MAX_FILES + ' files)');
        return;
      }
      var type = file.type;
      if (type === 'image/jpg') type = 'image/jpeg';
      if (!ACCEPTED_MIME[type]) {
        rejected.push(file.name + ' (unsupported type)');
        return;
      }
      if (file.size > MAX_BYTES) {
        rejected.push(file.name + ' (over 32 MB)');
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
        setField('examinee', fields.examinee);
        setField('caseInfo', fields.caseInfo);
        setField('chiefComplaint', fields.chiefComplaint);
        setField('historyOfInjury', fields.historyOfInjury);
        setField('pastHistory', fields.pastHistory);
        setField('recordsReviewed', fields.recordsReviewed);
        setField('physicalExam', fields.physicalExam);
        setField('diagnostics', fields.diagnostics);
        setField('priorTreatment', fields.priorTreatment);

        var note = 'Form filled from your records. Review every field before drafting.';
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
      runBtn.textContent = state ? 'Drafting…' : 'Draft IME report';
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
      examinee: readField('examinee'),
      caseInfo: readField('caseInfo'),
      jurisdiction: readField('jurisdiction'),
      guidesEdition: readField('guidesEdition'),
      specificQuestions: readField('specificQuestions'),
      chiefComplaint: readField('chiefComplaint'),
      historyOfInjury: readField('historyOfInjury'),
      pastHistory: readField('pastHistory'),
      recordsReviewed: readField('recordsReviewed'),
      physicalExam: readField('physicalExam'),
      diagnostics: readField('diagnostics'),
      priorTreatment: readField('priorTreatment'),
    };

    if (!body.historyOfInjury && !body.recordsReviewed && !body.physicalExam) {
      if (status)
        status.textContent =
          'Add at least the history of injury, records summary, or physical exam findings before drafting.';
      return;
    }

    output.textContent = '';
    output.hidden = false;
    if (empty) empty.hidden = true;
    if (copyBtn) copyBtn.hidden = true;
    if (downloadBtn) downloadBtn.hidden = true;
    if (status) status.textContent = 'Drafting IME report with Claude — this can take 30–90 seconds for a full report…';
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
})();
