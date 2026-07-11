// Newsletter signup endpoint for amplitudebd.com (flood relief).
// Same-origin POST { email, source, company? } from the site's signup forms.
//
// Flow (resilient — a signup is never lost if one service is down):
//   1. Add to MailerLite "Flood Relief Updates" group (the sender).
//   2. Record in Supabase `subscribers` (the owned list), including the
//      MailerLite id + resulting status, in a single insert (RLS is
//      insert-only, so we never need to UPDATE the row afterwards).
//   Success if EITHER side accepted the email. Secrets live only here
//   (Vercel env vars), never in the browser.
//
// CommonJS (no package.json / build step); uses Node's global fetch.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const ML_KEY = process.env.MAILERLITE_API_KEY;
const ML_GROUP = process.env.MAILERLITE_GROUP_ID;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_SOURCES = new Set(['popup', 'flood-relief', 'homepage']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  // Honeypot: a hidden "company" field. Real users leave it empty; bots fill it.
  if (String(body.company || '').trim()) return res.status(200).json({ ok: true });

  const email = String(body.email || '').trim().toLowerCase();
  const source = ALLOWED_SOURCES.has(body.source) ? body.source : 'homepage';

  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  // 1) MailerLite — the sender. Best-effort.
  let mlOk = false, mlId = null;
  if (ML_KEY && ML_GROUP) {
    try {
      const r = await fetch('https://connect.mailerlite.com/api/subscribers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          Authorization: `Bearer ${ML_KEY}`,
        },
        body: JSON.stringify({ email, groups: [ML_GROUP] }),
      });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        mlId = (data && data.data && data.data.id) || null;
        mlOk = true;
      }
    } catch (_) { /* fall through — Supabase still records it */ }
  }

  // 2) Supabase — the owned list. Best-effort. Single insert; duplicates ignored.
  let sbOk = false;
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'return=minimal,resolution=ignore-duplicates',
        },
        body: JSON.stringify({
          email,
          source,
          status: mlOk ? 'subscribed' : 'pending',
          mailerlite_id: mlId,
        }),
      });
      sbOk = r.ok || r.status === 409; // 409 = already there = fine
    } catch (_) { /* swallow */ }
  }

  if (mlOk || sbOk) return res.status(200).json({ ok: true });
  return res.status(502).json({ ok: false, error: 'signup_failed' });
};
