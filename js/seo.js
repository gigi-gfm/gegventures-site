// Organic Traffic Engine — AI SEO plans that earn free Google clicks.
(function () {
  var form = document.getElementById('seoForm');
  var output = document.getElementById('seoOutput');
  var status = document.getElementById('seoStatus');
  var runBtn = document.getElementById('seoRun');
  var copyBtn = document.getElementById('seoCopy');
  var empty = document.getElementById('seoEmpty');
  var banner = document.getElementById('aiBanner');
  var mode = document.getElementById('mode');
  var keywords = document.getElementById('keywords');
  var keywordsLabel = document.getElementById('keywordsLabel');
  if (!form || !output) return;

  var busy = false;

  // Tailor the keyword field to the selected mode.
  var FIELD = {
    'full-plan': {
      label: 'Seed keywords or topics <span style="font-weight:400;color:var(--ink-soft)">(optional)</span>',
      placeholder: 'e.g. annual physical, new patient, diabetes care',
    },
    keywords: {
      label: 'Seed keywords or topics <span style="font-weight:400;color:var(--ink-soft)">(optional)</span>',
      placeholder: 'e.g. annual physical, new patient, diabetes care',
    },
    'content-brief': {
      label: 'Target keyword or topic',
      placeholder: 'e.g. new patient annual physical in Austin',
    },
    'local-seo': {
      label: 'Service-area keywords <span style="font-weight:400;color:var(--ink-soft)">(optional)</span>',
      placeholder: 'e.g. family doctor near me, walk-in clinic Austin',
    },
    'optimize-page': {
      label: 'Page URL or current page content',
      placeholder: 'Paste the URL or the page’s current text to optimize',
    },
  };

  function syncField() {
    var f = FIELD[mode.value] || FIELD['full-plan'];
    if (keywordsLabel) keywordsLabel.innerHTML = f.label;
    if (keywords) keywords.placeholder = f.placeholder;
  }
  if (mode) {
    mode.addEventListener('change', syncField);
    syncField();
  }

  function setBusy(state) {
    busy = state;
    if (runBtn) {
      runBtn.disabled = state;
      runBtn.textContent = state ? 'Building…' : 'Build my SEO plan';
    }
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (busy) return;

    var body = {
      mode: form.mode.value,
      business: form.business.value.trim(),
      website: form.website.value.trim(),
      location: form.location.value.trim(),
      keywords: form.keywords.value.trim(),
      details: form.details.value.trim(),
    };

    if (!body.business) {
      if (status) status.textContent = 'Tell us the business name and what it does.';
      form.business.focus();
      return;
    }
    var needsKeywords = body.mode === 'content-brief' || body.mode === 'optimize-page';
    if (needsKeywords && !body.keywords) {
      if (status) {
        status.textContent =
          body.mode === 'optimize-page'
            ? 'Paste the page URL or its current content to optimize.'
            : 'Add a target keyword or topic for the content brief.';
      }
      form.keywords.focus();
      return;
    }

    output.textContent = '';
    output.hidden = false;
    if (empty) empty.hidden = true;
    if (copyBtn) copyBtn.hidden = true;
    if (status) status.textContent = 'Building your organic-traffic plan with Claude…';
    setBusy(true);

    var result = '';
    try {
      await GegAI.streamPost('/api/seo', body, function (chunk) {
        result += chunk;
        output.textContent = result;
      });
      if (status) {
        status.textContent = result.trim()
          ? 'Plan ready — verify estimated demand in a keyword tool before you commit.'
          : 'No plan was returned. Please try again.';
      }
      if (copyBtn && result.trim()) copyBtn.hidden = false;
    } catch (err) {
      if (status) status.textContent = err.message || 'The engine failed. Please try again.';
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
