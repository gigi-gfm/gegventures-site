// AI content studio — generates marketing copy for Garcia Family Medicine.
(function () {
  var form = document.getElementById('studioForm');
  var output = document.getElementById('studioOutput');
  var status = document.getElementById('studioStatus');
  var runBtn = document.getElementById('studioRun');
  var copyBtn = document.getElementById('studioCopy');
  var empty = document.getElementById('studioEmpty');
  var banner = document.getElementById('aiBanner');
  if (!form || !output) return;

  var busy = false;

  function setBusy(state) {
    busy = state;
    if (runBtn) {
      runBtn.disabled = state;
      runBtn.textContent = state ? 'Generating…' : 'Generate content';
    }
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (busy) return;

    var body = {
      contentType: form.contentType.value,
      topic: form.topic.value.trim(),
      location: form.location.value.trim(),
      details: form.details.value.trim(),
    };

    if (!body.topic) {
      if (status) status.textContent = 'Add a topic or focus to generate content.';
      form.topic.focus();
      return;
    }

    output.textContent = '';
    output.hidden = false;
    if (empty) empty.hidden = true;
    if (copyBtn) copyBtn.hidden = true;
    if (status) status.textContent = 'Drafting with Claude…';
    setBusy(true);

    var result = '';
    try {
      await GegAI.streamPost('/api/generate', body, function (chunk) {
        result += chunk;
        output.textContent = result;
      });
      if (status) {
        status.textContent = result.trim()
          ? 'Draft ready — review and refine before publishing.'
          : 'No content was returned. Please try again.';
      }
      if (copyBtn && result.trim()) copyBtn.hidden = false;
    } catch (err) {
      if (status) status.textContent = err.message || 'Generation failed. Please try again.';
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

  GegAI.getStatus().then(function (s) {
    if (!s.aiConfigured && banner) banner.hidden = false;
  });
})();
