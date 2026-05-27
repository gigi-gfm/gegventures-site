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

  var busy = false;

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
