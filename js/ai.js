// Shared helpers for the Gegventures AI features.
window.GegAI = (function () {
  async function streamPost(url, body, onChunk) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      let message = 'The request failed. Please try again.';
      try {
        const data = await res.json();
        if (data && data.error) message = data.error;
      } catch (e) {
        /* response was not JSON */
      }
      throw new Error(message);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) onChunk(text);
    }
  }

  async function getStatus() {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return { aiConfigured: false };
      return await res.json();
    } catch (e) {
      return { aiConfigured: false };
    }
  }

  return { streamPost, getStatus };
})();
