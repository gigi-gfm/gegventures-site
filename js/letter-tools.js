// Shared driver for the simple letter-drafting tools (dictation, referral,
// return-to-work). Each page invokes window.LetterTools.init(config).
window.LetterTools = (function () {
  function defaultDateString() {
    var months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    var d = new Date();
    return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function init(config) {
    var form = document.getElementById(config.formId);
    var output = document.getElementById(config.outputId);
    var empty = document.getElementById(config.emptyId);
    var status = document.getElementById(config.statusId);
    var runBtn = document.getElementById(config.runBtnId);
    var copyBtn = document.getElementById(config.copyBtnId);
    var downloadBtn = document.getElementById(config.downloadBtnId);
    var banner = document.getElementById(config.bannerId);
    if (!form || !output) return;

    // Default letter date on load.
    if (config.dateFieldId) {
      var dateEl = document.getElementById(config.dateFieldId);
      if (dateEl && !dateEl.value) dateEl.value = defaultDateString();
    }

    var busy = false;
    function setBusy(state) {
      busy = state;
      if (runBtn) {
        runBtn.disabled = state;
        runBtn.textContent = state
          ? config.busyLabel || 'Drafting…'
          : config.runLabel || 'Draft letter';
      }
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (busy) return;

      var body = {};
      config.fields.forEach(function (name) {
        var el = form.elements[name];
        body[name] = el && typeof el.value === 'string' ? el.value.trim() : '';
      });

      if (config.requiredFields) {
        for (var i = 0; i < config.requiredFields.length; i++) {
          var f = config.requiredFields[i];
          if (!body[f]) {
            if (status)
              status.textContent =
                (config.requiredMessages && config.requiredMessages[f]) ||
                'Please fill in the required fields.';
            var el = form.elements[f];
            if (el && typeof el.focus === 'function') el.focus();
            return;
          }
        }
      }

      output.textContent = '';
      output.hidden = false;
      if (empty) empty.hidden = true;
      if (copyBtn) copyBtn.hidden = true;
      if (downloadBtn) downloadBtn.hidden = true;
      if (status) status.textContent = config.startMessage || 'Drafting with Claude…';
      setBusy(true);

      var result = '';
      try {
        await GegAI.streamPost(config.endpoint, body, function (chunk) {
          result += chunk;
          output.textContent = result;
          output.scrollTop = output.scrollHeight;
        });
        if (status) {
          status.textContent = result.trim()
            ? config.successMessage || 'Draft ready. Review every line before signing.'
            : 'No content was returned. Please try again.';
        }
        if (result.trim()) {
          if (copyBtn) copyBtn.hidden = false;
          if (downloadBtn) downloadBtn.hidden = false;
        }
      } catch (err) {
        if (status) status.textContent = (err && err.message) || 'Drafting failed. Please try again.';
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
        a.download = (config.downloadName || 'letter') + '-' + stamp + '.md';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 1000);
      });
    }

    if (banner) {
      GegAI.getStatus().then(function (s) {
        if (!s.aiConfigured) banner.hidden = false;
      });
    }
  }

  return { init: init };
})();
