/**
 * PFT-AST v10 — Auto-detecting Configuration
 * 1. window.BACKEND_URL_OVERRIDE  → manual override
 * 2. <meta name="backend-url">    → injected at deploy time
 * 3. Auto from hostname: localhost → http://localhost:7860
 *                        other    → HuggingFace Space URL
 */
(function() {
  var h = window.location.hostname;
  var isLocal = (h === 'localhost' || h === '127.0.0.1' ||
                 h.startsWith('192.168.') || h.startsWith('10.'));
  var metaEl = document.querySelector('meta[name="backend-url"]');
  var url = window.BACKEND_URL_OVERRIDE ||
            (metaEl && metaEl.content ? metaEl.content : null) ||
            (isLocal ? 'http://localhost:7860' : 'https://rajeshragi-final.hf.space');
  window.BACKEND_URL = url;
  console.log('[PFT-AST] Backend:', url, isLocal ? '(local mode)' : '(remote)');
})();
