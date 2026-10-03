// Fill these in after deploying the Supabase functions (see SETUP.md).
// Everything here is safe to publish: no secrets belong in this file.
// While functionsUrl is empty, the site shows the built-in prices and the
// form tells people to call instead of pretending to send.
window.RCC_CONFIG = {
  functionsUrl: '',           // e.g. 'https://abcd1234.supabase.co/functions/v1'
  turnstileSiteKey: '',       // Cloudflare Turnstile site key (not the secret)
  businessTz: 'America/Chicago',
  phoneDisplay: '(555) 234-8765',
};

// Local testing only: http://localhost:8762/?functions=http://localhost:8790
// points the page at tests/mock-functions.mjs. Ignored on any other host.
if (location.hostname === 'localhost') {
  const override = new URLSearchParams(location.search).get('functions');
  if (override && override.startsWith('http://localhost:')) window.RCC_CONFIG.functionsUrl = override;
}
