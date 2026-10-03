// Twilio webhook helpers. Pure Web Crypto, shared with the Node tests.

const OPT_OUT = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'];
const OPT_IN = ['START', 'YES', 'UNSTOP'];

/** 'out' | 'in' | null for an inbound message body. */
export function optKeyword(body) {
  const word = String(body ?? '').trim().toUpperCase();
  if (OPT_OUT.includes(word)) return 'out';
  if (OPT_IN.includes(word)) return 'in';
  return null;
}

/**
 * Twilio's request signature: HMAC-SHA1 over the full webhook URL followed by
 * every POST parameter as key+value, keys sorted, base64 encoded.
 */
export async function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function isValidTwilioRequest(authToken, url, params, header) {
  if (!authToken || !header) return false;
  const expected = await twilioSignature(authToken, url, params);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}
