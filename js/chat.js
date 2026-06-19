// Patient-acquisition chatbot for Garcia Family Medicine.
(function () {
  var log = document.getElementById('chatLog');
  var form = document.getElementById('chatForm');
  var input = document.getElementById('chatInput');
  var sendBtn = document.getElementById('chatSend');
  var banner = document.getElementById('aiBanner');
  if (!log || !form || !input) return;

  // Conversation history sent to the API. UI-only greeting is not included.
  var messages = [];
  var busy = false;

  function addBubble(role, text) {
    var wrap = document.createElement('div');
    wrap.className = 'chat__msg chat__msg--' + role;
    var bubble = document.createElement('div');
    bubble.className = 'chat__bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function setBusy(state) {
    busy = state;
    input.disabled = state;
    if (sendBtn) sendBtn.disabled = state;
  }

  addBubble(
    'assistant',
    "Hi! I'm the virtual assistant for Garcia Family Medicine. I can answer questions about our services, hours, and insurance — and help you book an appointment. What brings you in?"
  );

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (busy) return;
    var text = input.value.trim();
    if (!text) return;

    addBubble('user', text);
    messages.push({ role: 'user', content: text });
    input.value = '';
    setBusy(true);

    var bubble = addBubble('assistant', '');
    bubble.classList.add('is-streaming');
    var reply = '';

    try {
      await GegAI.streamPost('/api/chat', { messages: messages }, function (chunk) {
        reply += chunk;
        bubble.textContent = reply;
        log.scrollTop = log.scrollHeight;
      });
      if (reply.trim()) {
        // Render the finished reply as Markdown (links, lists, emphasis).
        if (window.GegMD) {
          bubble.classList.add('md');
          bubble.innerHTML = GegMD.render(reply);
          log.scrollTop = log.scrollHeight;
        }
        messages.push({ role: 'assistant', content: reply });
      } else {
        bubble.textContent = 'Sorry — I had trouble responding. Please try again.';
      }
    } catch (err) {
      bubble.textContent = err.message || 'Something went wrong. Please try again.';
      bubble.parentElement.classList.add('chat__msg--error');
      // Roll back the unanswered user turn so the next send stays valid.
      messages.pop();
    } finally {
      bubble.classList.remove('is-streaming');
      setBusy(false);
      input.focus();
    }
  });

  GegAI.getStatus().then(function (status) {
    if (!status.aiConfigured && banner) banner.hidden = false;
  });
})();
