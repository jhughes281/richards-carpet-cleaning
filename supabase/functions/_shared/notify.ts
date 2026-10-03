// Outbound text (Twilio) and email (Resend), plus the Turnstile spam check.
// Each one is optional: leave its secrets unset and that channel is skipped.

const env = (k: string) => Deno.env.get(k) ?? '';

export function makeNotify() {
  return {
    async sms(to: string, body: string) {
      const sid = env('TWILIO_ACCOUNT_SID');
      const token = env('TWILIO_AUTH_TOKEN');
      const from = env('TWILIO_FROM');
      if (!sid || !token || !from) throw new Error('Twilio is not configured');
      const form = new URLSearchParams({ To: to, Body: body });
      // A Messaging Service SID (MG...) is what A2P 10DLC registration gives you.
      form.set(from.startsWith('MG') ? 'MessagingServiceSid' : 'From', from);
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa(`${sid}:${token}`), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message ?? 'unknown error'}`);
      return { id: json.sid as string };
    },

    async email({ to, subject, text, replyTo }: { to: string; subject: string; text: string; replyTo?: string | null }) {
      const key = env('RESEND_API_KEY');
      const from = env('RESEND_FROM');
      if (!key || !from) throw new Error('Resend is not configured');
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`Resend ${res.status}: ${json.message ?? 'unknown error'}`);
      return { id: json.id as string };
    },
  };
}

/** Returns a verifier, or null when TURNSTILE_SECRET is unset (local testing). */
export function makeTurnstile() {
  const secret = env('TURNSTILE_SECRET');
  if (!secret) return null;
  return async (token: unknown, ip: string | null) => {
    if (typeof token !== 'string' || !token) return false;
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const json = await res.json();
    return json.success === true;
  };
}
