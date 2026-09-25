/**
 * Builds 6 role-specific user guides:
 *   - NMWC-Salesman-Guide-EN.{html,pdf}
 *   - NMWC-Salesman-Guide-AR.{html,pdf}
 *   - NMWC-Supervisor-Guide-EN.{html,pdf}
 *   - NMWC-Supervisor-Guide-AR.{html,pdf}
 *   - NMWC-Manager-Guide-EN.{html,pdf}
 *   - NMWC-Manager-Guide-AR.{html,pdf}
 *
 * Architecture:
 *   - One typed `Guide` shape holds cover, sections, and reference card.
 *   - Per role × language we write a separate `Guide` literal — content
 *     authored in plain language for each audience.
 *   - A shared `renderHtml(guide)` template emits print-ready A4 HTML
 *     with NMWC branding, RTL flip when lang === 'ar'.
 *   - Playwright then renders each HTML to PDF.
 *
 * Re-run any time:  npm run guide:roles
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

type Lang = 'en' | 'ar';
type Role = 'salesman' | 'supervisor' | 'manager' | 'steward';

type Callout = {
  kind: 'info' | 'tip' | 'warn' | 'danger';
  title: string;
  body: string;
};

type Step = { html: string; img?: string }; // html = step body, may include <strong>

type Section = {
  number: number;
  title: string;
  intro?: string;
  steps?: Step[];
  callouts?: Callout[];
  table?: { headers?: string[]; rows: string[][] };
  ul?: string[];
};

type Guide = {
  role: Role;
  lang: Lang;
  rolePill: string; // "FOR SALESMEN" or Arabic equivalent
  coverTitle: string;
  coverSubtitle: string;
  brandLine: string;
  filename: string; // base name without ext, e.g. "NMWC-Salesman-Guide-EN"
  welcome: { heading: string; body: string };
  sections: Section[];
  ref: { title: string; intro?: string; tables: { title: string; rows: string[][] }[] };
  footer: string;
};

// ────────────────────────────────────────────────────────────────────
// Shared CSS (used by every guide)
// ────────────────────────────────────────────────────────────────────

const CSS = String.raw`
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
  color: #1e293b;
  line-height: 1.55;
  font-size: 12pt;
  background: #fff;
}
[dir="rtl"] body { font-family: "Tajawal", "Cairo", "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
@media screen { body { padding: 24px; background: #f8fafc; } .page { background: #fff; max-width: 820px; margin: 0 auto 24px; padding: 48px; box-shadow: 0 6px 24px rgba(15,23,42,0.06); border-radius: 8px; } }
@media print { .page-break { page-break-before: always; } .avoid-break { page-break-inside: avoid; } }

h1, h2, h3, h4 { font-weight: 700; color: #0f172a; margin: 0; }
h1 { font-size: 26pt; letter-spacing: -0.02em; }
h2 { font-size: 20pt; margin-top: 18pt; padding-bottom: 6pt; border-bottom: 2px solid #1d4ed8; color: #1e3a8a; }
h3 { font-size: 14pt; margin-top: 16pt; color: #1d4ed8; }
h4 { font-size: 11pt; margin-top: 12pt; color: #334155; text-transform: uppercase; letter-spacing: 0.05em; }
p  { margin: 8pt 0; }

.cover {
  min-height: 250mm;
  display: flex; flex-direction: column; justify-content: space-between;
  background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%);
  color: #fff;
  padding: 36mm 22mm;
}
.cover.salesman { background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 100%); }
.cover.supervisor { background: linear-gradient(135deg, #064e3b 0%, #10b981 100%); }
.cover.manager { background: linear-gradient(135deg, #78350f 0%, #f59e0b 100%); }
.cover.steward { background: linear-gradient(135deg, #312e81 0%, #6366f1 100%); }
.cover .brand { font-size: 36pt; font-weight: 800; letter-spacing: -0.03em; }
.cover .sub { font-size: 14pt; opacity: 0.85; margin-top: 6pt; }
.cover .title { font-size: 30pt; font-weight: 800; line-height: 1.1; max-width: 14em; }
.cover .role-pill { display: inline-block; padding: 8pt 16pt; border-radius: 999px; background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.3); font-weight: 600; font-size: 12pt; margin-top: 12pt; }
.cover .footer { font-size: 10pt; opacity: 0.7; }

.section-opener {
  background: linear-gradient(180deg, #eff6ff 0%, #fff 100%);
  border-radius: 12px;
  padding: 22pt 22pt;
  margin: 0 0 16pt;
  border-left: 6px solid #1d4ed8;
}
[dir="rtl"] .section-opener { border-left: none; border-right: 6px solid #1d4ed8; }
.section-opener.green { border-left-color: #10b981; background: linear-gradient(180deg, #ecfdf5 0%, #fff 100%); }
.section-opener.amber { border-left-color: #f59e0b; background: linear-gradient(180deg, #fffbeb 0%, #fff 100%); }
.section-opener.indigo { border-left-color: #6366f1; background: linear-gradient(180deg, #eef2ff 0%, #fff 100%); }
[dir="rtl"] .section-opener.green { border-right-color: #10b981; }
[dir="rtl"] .section-opener.amber { border-right-color: #f59e0b; }
[dir="rtl"] .section-opener.indigo { border-right-color: #6366f1; }
.section-opener h2 { border: none; padding: 0; margin: 0 0 6pt; font-size: 22pt; color: #1e3a8a; }
.section-opener.green h2 { color: #064e3b; }
.section-opener.amber h2 { color: #78350f; }
.section-opener.indigo h2 { color: #312e81; }
.section-opener .intro { font-size: 11pt; color: #334155; max-width: 36em; }

.step-list { counter-reset: step; padding: 0; margin: 0; list-style: none; }
.step-list > li {
  counter-increment: step;
  position: relative;
  padding: 10pt 14pt 10pt 42pt;
  margin-bottom: 8pt;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  page-break-inside: avoid;
}
[dir="rtl"] .step-list > li { padding: 10pt 42pt 10pt 14pt; }
.step-list > li::before {
  content: counter(step);
  position: absolute; left: 10pt; top: 9pt;
  width: 22pt; height: 22pt; border-radius: 999px;
  background: #1d4ed8; color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 10.5pt;
}
[dir="rtl"] .step-list > li::before { left: auto; right: 10pt; }

.step-with-image { display: grid; grid-template-columns: 280px 1fr; gap: 18pt; align-items: start; page-break-inside: avoid; margin: 12pt 0; }
[dir="rtl"] .step-with-image { grid-template-columns: 1fr 280px; }

.screenshot {
  border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden;
  box-shadow: 0 2px 12px rgba(15,23,42,0.08); background: #000;
}
.screenshot img { width: 100%; height: auto; display: block; }
.screenshot .caption { background: #0f172a; color: #cbd5e1; padding: 6pt 10pt; font-size: 9.5pt; text-align: center; }

.callout { border-left: 4px solid #1d4ed8; background: #eff6ff; padding: 10pt 14pt; border-radius: 0 8px 8px 0; margin: 10pt 0; page-break-inside: avoid; }
[dir="rtl"] .callout { border-left: none; border-right: 4px solid #1d4ed8; border-radius: 8px 0 0 8px; }
.callout.tip { border-left-color: #10b981; background: #ecfdf5; }
.callout.warn { border-left-color: #f59e0b; background: #fffbeb; }
.callout.danger { border-left-color: #dc2626; background: #fef2f2; }
[dir="rtl"] .callout.tip { border-right-color: #10b981; }
[dir="rtl"] .callout.warn { border-right-color: #f59e0b; }
[dir="rtl"] .callout.danger { border-right-color: #dc2626; }
.callout strong.label { display: block; font-size: 10pt; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4pt; color: #1d4ed8; }
.callout.tip strong.label { color: #047857; }
.callout.warn strong.label { color: #b45309; }
.callout.danger strong.label { color: #b91c1c; }

table { border-collapse: collapse; width: 100%; margin: 10pt 0; font-size: 10.5pt; }
th, td { padding: 8pt 10pt; text-align: left; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
[dir="rtl"] th, [dir="rtl"] td { text-align: right; }
thead th { background: #f1f5f9; font-weight: 600; color: #334155; font-size: 10pt; }

.credentials-card { border: 2px dashed #1d4ed8; background: #eff6ff; border-radius: 10px; padding: 14pt; margin: 12pt 0; page-break-inside: avoid; text-align: center; }
.credentials-card .label { font-size: 9pt; text-transform: uppercase; color: #64748b; letter-spacing: 0.06em; }
.credentials-card .value { font-family: "SF Mono", Consolas, monospace; font-weight: 700; font-size: 14pt; color: #1e3a8a; direction: ltr; }
`;

// ────────────────────────────────────────────────────────────────────
// Renderer
// ────────────────────────────────────────────────────────────────────

function renderCallout(c: Callout): string {
  return `<div class="callout ${c.kind}"><strong class="label">${c.title}</strong>${c.body}</div>`;
}

function renderSection(s: Section, opener: 'blue' | 'green' | 'amber' | 'indigo'): string {
  const openerCls =
    opener === 'green'
      ? 'green'
      : opener === 'amber'
        ? 'amber'
        : opener === 'indigo'
          ? 'indigo'
          : '';
  const intro = s.intro ? `<p class="intro">${s.intro}</p>` : '';
  const ul = s.ul?.length ? `<ul>${s.ul.map((x) => `<li>${x}</li>`).join('')}</ul>` : '';
  const callouts = s.callouts?.map(renderCallout).join('') ?? '';
  const stepsHtml = s.steps?.length
    ? `<ol class="step-list">${s.steps
        .map((st) => {
          if (!st.img) return `<li>${st.html}</li>`;
          // step + screenshot side-by-side on its own row
          return `<li>${st.html}<div style="margin-top:8pt"><div class="screenshot" style="max-width:280px"><img src="img/${st.img}" alt="" /></div></div></li>`;
        })
        .join('')}</ol>`
    : '';
  const tableHtml = s.table
    ? `<table>${
        s.table.headers
          ? `<thead><tr>${s.table.headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`
          : ''
      }<tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '';
  return `<section class="page page-break"><div class="section-opener ${openerCls}"><h2>${s.number}. ${s.title}</h2>${intro}</div>${ul}${stepsHtml}${tableHtml}${callouts}</section>`;
}

function renderHtml(g: Guide): string {
  const dir = g.lang === 'ar' ? 'rtl' : 'ltr';
  const opener: 'blue' | 'green' | 'amber' | 'indigo' =
    g.role === 'supervisor'
      ? 'green'
      : g.role === 'manager'
        ? 'amber'
        : g.role === 'steward'
          ? 'indigo'
          : 'blue';
  const sectionsHtml = g.sections.map((s) => renderSection(s, opener)).join('');
  const refHtml = `<section class="page page-break"><h2>${g.ref.title}</h2>${
    g.ref.intro ? `<p>${g.ref.intro}</p>` : ''
  }${g.ref.tables
    .map(
      (t) =>
        `<h3>${t.title}</h3><table><tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    )
    .join('')}<div class="credentials-card"><div class="label">${
    g.lang === 'ar' ? 'رابط النظام' : 'Production URL'
  }</div><div class="value">https://nmwc-cm.vercel.app</div></div><p style="text-align:center;margin-top:24pt;color:#64748b;font-size:10pt;">${g.footer}</p></section>`;
  return `<!doctype html>
<html lang="${g.lang}" dir="${dir}">
<head>
<meta charset="utf-8" />
<title>${g.coverTitle}</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
${
  g.lang === 'ar'
    ? '<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">'
    : ''
}
<style>${CSS}</style>
</head>
<body>
<section class="cover page ${g.role}">
  <div>
    <div class="brand">NMWC</div>
    <div class="sub">${g.brandLine}</div>
  </div>
  <div>
    <div class="title">${g.coverTitle}</div>
    <span class="role-pill">${g.rolePill}</span>
  </div>
  <div class="footer">${g.coverSubtitle}</div>
</section>
<section class="page page-break">
  <h1>${g.welcome.heading}</h1>
  <p>${g.welcome.body}</p>
</section>
${sectionsHtml}
${refHtml}
</body></html>`;
}

// ────────────────────────────────────────────────────────────────────
// Content — English
// ────────────────────────────────────────────────────────────────────

const SALESMAN_EN: Guide = {
  role: 'salesman',
  lang: 'en',
  rolePill: 'FOR SALESMEN',
  brandLine: 'Customer Master — Field App',
  coverTitle: 'Salesman User Guide',
  coverSubtitle: 'NMWC Customer Master · v1.0 · 2026-05',
  filename: 'NMWC-Salesman-Guide-EN',
  welcome: {
    heading: 'Welcome',
    body: 'This is your daily companion. The NMWC Customer Master app helps you keep every shop on your route up-to-date — directly from the field. This guide walks you through every action you will need: logging in, finding a shop, fixing missing info, taking photos, capturing GPS, submitting for approval, and handling shop closures or reopenings.',
  },
  sections: [
    {
      number: 1,
      title: 'Logging in',
      intro: 'You only do this the first time, then once a day or week.',
      steps: [
        {
          html: 'On your phone, open <strong>https://nmwc-cm.vercel.app</strong>. Save it as a bookmark on your home screen.',
          img: '01-login.png',
        },
        { html: 'Type your <strong>Username</strong>. Your manager gives you this on day one.' },
        {
          html: 'Type your <strong>Password</strong>. Tap the blue <strong>Sign in</strong> button.',
        },
        {
          html: 'First time? The app may ask you to set a new password. This is for your safety — pick something only you know.',
        },
      ],
      callouts: [
        {
          kind: 'tip',
          title: 'Forgot your password?',
          body: "Don't guess more than 5 times — the system will lock you out for one minute. Just message your manager — they reset it in 30 seconds.",
        },
      ],
    },
    {
      number: 2,
      title: 'Find the shop you are visiting',
      intro: 'Open the customer in two taps.',
      steps: [
        {
          html: 'Tap <strong>Today</strong> in the menu. You see the shops on your route scheduled today.',
          img: '02-salesman-today.png',
        },
        {
          html: "If the shop is not on today's list, tap <strong>Customers</strong> and search by name or NMWC code.",
          img: '03-salesman-customers-list.png',
        },
        { html: "Tap any row to open that shop's profile." },
      ],
      callouts: [
        {
          kind: 'info',
          title: 'What\'s a "branch"?',
          body: 'A "customer" is the legal entity (company name on the CR). A "branch" is the physical shop you visit. Most shops have one branch ("Main"). Big chains have several.',
        },
      ],
    },
    {
      number: 3,
      title: 'Update the shop info',
      intro: 'Fill in what is missing. Required fields are marked with *.',
      steps: [
        {
          html: 'On the customer profile, tap the blue <strong>Enrich</strong> button at the top right.',
          img: '04-salesman-customer-profile.png',
        },
        {
          html: '<strong>Identity</strong> section: legal name, NMWC code, CR number, channel, sub-channel, contact person, primary phone.',
          img: '05-salesman-enrichment-top.png',
        },
        { html: 'Phone must be a valid Oman number, e.g. <strong>+96891234567</strong>.' },
        {
          html: 'Channel says what type of shop it is — pick the closest match (General Trade, HORECA, Modern Trade, etc.).',
        },
      ],
    },
    {
      number: 4,
      title: 'Take the photos',
      intro:
        'Always take fresh photos at the shop today. Old gallery photos are rejected. The shop-front photo is required to submit; the others raise the completeness score.',
      steps: [
        {
          html: 'Tap an empty photo slot. Your camera opens.',
          img: '06-salesman-enrichment-photos.png',
        },
        { html: '<strong>Shop front</strong> (required) — clearly shows the entrance. For a home-delivery customer, the building entrance.' },
        { html: "<strong>Signboard</strong> — the shop's sign with its name, when the shop has one." },
        { html: '<strong>CR document</strong> — the legal commercial registration paper, when the customer is a registered business.' },
        {
          html: 'The app uploads automatically. If your network is weak, it retries on its own. If still failing, tap <strong>Retry upload</strong> — your photo is saved, no need to retake.',
        },
      ],
      callouts: [
        {
          kind: 'warn',
          title: 'Take photos at the shop, not from the gallery',
          body: 'Photos older than 24 hours are rejected. Supervisors can see when each photo was taken. Taking it on the spot is the only way.',
        },
      ],
    },
    {
      number: 5,
      title: 'Capture the GPS location',
      steps: [
        {
          html: "Tap the <strong>Capture GPS</strong> button when you're standing at the shop entrance.",
        },
        { html: 'Your phone asks permission — tap <strong>Allow</strong>.' },
        {
          html: "If GPS doesn't work (indoors, weak signal), tap <strong>Enter coordinates manually</strong>. Tap the map at the shop's location, or type the lat/lng. Add a short reason so the supervisor sees it's manual.",
        },
      ],
    },
    {
      number: 6,
      title: 'Submit for approval',
      steps: [
        {
          html: 'Scroll to the bottom — you see a sticky bar with two buttons.',
          img: '07-salesman-enrichment-bottom.png',
        },
        { html: 'Tap the blue <strong>Submit for approval</strong> button (left).' },
        {
          html: "You'll see a confirmation. The shop's status becomes <strong>Pending review</strong> until your supervisor decides.",
        },
        {
          html: "If you're interrupted, tap <strong>Save draft</strong> instead — it stays on your phone for 7 days.",
        },
      ],
    },
    {
      number: 7,
      title: 'Mark a shop as permanently closed',
      intro: 'Use this only if the shop has truly shut down (gone out of business, moved, etc.).',
      steps: [
        {
          html: 'On the customer profile, tap the red <strong>Mark closed</strong> button on the branch tile.',
        },
        {
          html: "Take a fresh photo showing it's clearly closed (shutters down, sign removed, empty).",
        },
        {
          html: 'Type a short reason — at least 5 letters. e.g. "Shop has shut down, signage removed."',
        },
        { html: 'Tap <strong>Submit closure</strong>. Your supervisor reviews it.' },
      ],
      callouts: [
        {
          kind: 'warn',
          title: 'Be sure before you mark it',
          body: 'A blurry photo or one taken from far away will be rejected. Show the closed entrance clearly.',
        },
      ],
    },
    {
      number: 8,
      title: 'Request reactivation of a closed shop',
      intro: 'Use this when a previously closed shop has reopened.',
      steps: [
        { html: "Open the closed shop's profile. The branch shows a <strong>Closed</strong> tag." },
        { html: 'Tap the green <strong>Request reactivation</strong> button.' },
        { html: 'Take a fresh photo showing the shop is open and operating today.' },
        {
          html: 'Type a reason and submit. The <strong>manager</strong> (not your supervisor) approves reactivations.',
        },
      ],
      callouts: [
        {
          kind: 'info',
          title: 'Why a fresh photo?',
          body: 'The system checks the photo was taken AFTER the shop was marked closed. This prevents anyone from using an old photo to fake a reopening.',
        },
      ],
    },
    {
      number: 9,
      title: 'Common situations',
      table: {
        headers: ['Situation', 'What to do'],
        rows: [
          [
            'Photo upload keeps failing',
            'Move outside or near a window. Wait a few seconds. The app retries automatically. If still stuck, tap "Retry upload" — your photo is saved.',
          ],
          [
            "GPS won't capture",
            'Tap "Enter coordinates manually" inside the GPS box. Tap the map or type the numbers. Add a short reason.',
          ],
          [
            '"This customer is not on your route"',
            'You can only enrich shops on your assigned route. Ask your manager to reassign it if needed.',
          ],
          [
            'My submission was rejected',
            'Read the supervisor\'s reason. The shop appears in your "Needs correction" list. Open it, fix what they asked, and re-submit.',
          ],
          [
            "I'm mid-form and need to leave",
            'Tap "Save draft". You can come back within 7 days and finish.',
          ],
          [
            'The signal dropped while I was submitting',
            'The app says, beside the button, whether your submit arrived. Stay on the page and tap "Try again" when you have signal. If it had already arrived you see "Already received" — it is never sent twice.',
          ],
        ],
      },
    },
  ],
  ref: {
    title: '10. Quick reference card',
    intro: 'Keep this page handy in your first weeks.',
    tables: [
      {
        title: "Buttons you'll use",
        rows: [
          ['<strong>Enrich</strong> (blue, top-right)', 'Open the form to update the shop.'],
          ['<strong>Save draft</strong>', 'Save your work without sending. Stays 7 days.'],
          ['<strong>Submit for approval</strong>', 'Send your changes to your supervisor.'],
          [
            '<strong>Mark closed</strong> (red)',
            'Tell the system this shop has permanently closed.',
          ],
          [
            '<strong>Request reactivation</strong> (green)',
            'A closed shop has reopened — send to manager.',
          ],
          ['<strong>Retry upload</strong>', 'Re-send a failed photo without retaking it.'],
          ['<strong>Sign out</strong>', 'End your session. Always sign out on shared devices.'],
        ],
      },
      {
        title: "Status tags you'll see",
        rows: [
          ['<strong>Active</strong> (green)', 'Shop is operating normally.'],
          ['<strong>Closed</strong> (red)', 'Shop has shut down. No active orders.'],
          ['<strong>Pending review</strong>', "You submitted, supervisor hasn't decided yet."],
          ['<strong>Approved</strong>', 'Your last submission was approved — change is live.'],
          ['<strong>Needs correction</strong>', 'Supervisor sent it back. Open and fix.'],
        ],
      },
      {
        title: 'Who to contact',
        rows: [
          ['Forgot password / locked out', 'Your manager — they reset in 30 seconds.'],
          ['Photo or GPS not working', 'Try the manual fallback. Then your supervisor.'],
          ['Wrong info in the master', 'Submit an enrichment with the correction.'],
        ],
      },
    ],
  },
  footer: 'NMWC Customer Master · Salesman Guide · v1.0 · 2026-05-10',
};

const SUPERVISOR_EN: Guide = {
  role: 'supervisor',
  lang: 'en',
  rolePill: 'FOR SUPERVISORS',
  brandLine: 'Customer Master — Approval App',
  coverTitle: 'Supervisor User Guide',
  coverSubtitle: 'NMWC Customer Master · v1.0 · 2026-05',
  filename: 'NMWC-Supervisor-Guide-EN',
  welcome: {
    heading: 'Welcome',
    body: 'You are the gate between field-collected data and the master record. Every salesman submission lands in your queue. Your job is to approve good ones quickly, reject bad ones with a clear reason, and use bulk actions when a batch is uniformly good. This guide walks you through every screen.',
  },
  sections: [
    {
      number: 1,
      title: 'Logging in',
      steps: [
        {
          html: 'Open <strong>https://nmwc-cm.vercel.app</strong> on your phone or laptop.',
          img: '01-login.png',
        },
        { html: 'Sign in with your supervisor username and password.' },
        { html: 'After signing in you land on the Approvals page automatically.' },
      ],
    },
    {
      number: 2,
      title: 'Open the approval queue',
      steps: [
        {
          html: 'Tap <strong>Approvals</strong> in the menu.',
          img: '08-supervisor-approvals-queue.png',
        },
        { html: 'You see every pending submission from salesmen who report to you, oldest first.' },
        {
          html: 'Each row shows: customer name, NMWC code, number of changed fields, who submitted, and how long ago.',
        },
        {
          html: 'Age tags: <strong>green</strong> &lt; 24h, <strong>amber</strong> 1-3 days, <strong>red</strong> &gt; 3 days. Clear the reds first.',
        },
      ],
    },
    {
      number: 3,
      title: 'Review one edit (Before / After diff)',
      steps: [
        {
          html: 'Tap any row to open the edit detail page.',
          img: '09-supervisor-approval-diff.png',
        },
        { html: 'You see a Before / After diff for every field that changed.' },
        { html: 'Compare the values. Anything wrong, missing, or suspicious?' },
        { html: 'If a photo changed, tap it to view full size.' },
        {
          html: 'Tap <strong>Open profile</strong> to see the full customer record (other fields, branches, history).',
        },
      ],
    },
    {
      number: 4,
      title: 'Approve, reject, or send back',
      callouts: [
        {
          kind: 'tip',
          title: '✓ Approve',
          body: 'The change is correct. Tap the green <strong>Approve</strong> button. A confirmation popup asks you to confirm. The change goes live on the master immediately.',
        },
        {
          kind: 'warn',
          title: '✗ Reject (send back for correction)',
          body: 'Something needs fixing. Tap the red <strong>Reject</strong> button. Pick a category (Bad photo, Wrong GPS, Missing field, Wrong info, Other), pick a canned reason from the suggestion pills, or type your own (5+ letters). The salesman sees this exactly and can re-submit after fixing.',
        },
        {
          kind: 'danger',
          title: "Don't approve your own work",
          body: 'The system blocks you from approving your own submissions. If you ever submitted as a salesman first, that edit must go to another supervisor or to your manager.',
        },
      ],
    },
    {
      number: 5,
      title: 'Bulk approve / bulk reject',
      intro: 'When a batch is uniformly good (or uniformly bad).',
      steps: [
        {
          html: 'On the queue page, tick the checkbox next to each edit you want to handle. Use <strong>Select all</strong> to grab everything on the page.',
        },
        {
          html: 'A sticky bar appears at the bottom with <strong>Approve N</strong> and <strong>Reject N</strong> buttons.',
        },
        {
          html: '<strong>Bulk approve</strong> runs each one in its own transaction. If a few fail (concurrent edits, missing fields), the others still go through. You see a clear list of which ones need attention.',
        },
        {
          html: '<strong>Bulk reject</strong> sends the same category and reason to every selected edit. Use only when the issue is truly the same on all of them.',
        },
      ],
      callouts: [
        {
          kind: 'tip',
          title: 'Tip — when not to bulk-approve',
          body: 'If even one edit looks suspicious, open it and review individually. Bulk-approve is for trust + speed, not for skipping the check.',
        },
      ],
    },
    {
      number: 6,
      title: 'Reject categories — when to use which',
      table: {
        headers: ['Category', 'Use it when…'],
        rows: [
          [
            '<strong>Bad photo</strong>',
            "Photo is blurry, taken from too far, or doesn't show what it should (e.g. CR photo where the writing is unreadable).",
          ],
          [
            '<strong>Wrong GPS</strong>',
            'GPS coordinates point to the wrong place — e.g. salesman captured GPS at the office instead of the shop.',
          ],
          ['<strong>Missing field</strong>', 'A required field is empty or has a placeholder.'],
          [
            '<strong>Wrong info</strong>',
            "A field has data that doesn't match the photo or what we know about the shop.",
          ],
          ['<strong>Other</strong>', 'Anything else — type a clear reason.'],
        ],
      },
    },
    {
      number: 7,
      title: 'Common situations',
      table: {
        headers: ['Message you see', 'What it means'],
        rows: [
          [
            '"Edit was just decided by another reviewer"',
            'Another supervisor or manager approved/rejected before you. Refresh the queue.',
          ],
          [
            '"This value conflicts with an existing record"',
            'Two salesmen submitted the same phone or CR number. Reject one and ask them to verify.',
          ],
          [
            '"Required fields are now missing"',
            'Salesman deleted a required field (e.g. CR photo) between submitting and your approving. Reject — they need to re-upload at the shop.',
          ],
          [
            '"You are not authorized to act on this edit"',
            "The customer is no longer in your team's scope (route reassigned, customer merged). Forward to your manager.",
          ],
        ],
      },
    },
  ],
  ref: {
    title: '8. Quick reference card',
    tables: [
      {
        title: 'Buttons',
        rows: [
          ['<strong>✓ Approve</strong>', 'Apply the change to the master.'],
          ['<strong>✗ Reject</strong>', 'Send back to salesman with a category and reason.'],
          ['<strong>Open profile</strong>', 'View the full customer record.'],
          ['<strong>Approve N</strong> (sticky bar)', 'Bulk approve every selected edit.'],
          ['<strong>Reject N</strong> (sticky bar)', 'Bulk reject every selected edit.'],
        ],
      },
      {
        title: 'Triage by age',
        rows: [
          ['<strong>Green tag</strong> (under 24h)', 'Newest. Review when you can.'],
          ['<strong>Amber tag</strong> (1-3 days)', 'Getting old. Aim to clear today.'],
          ['<strong>Red tag</strong> (over 3 days)', 'Late — clear these first every morning.'],
        ],
      },
    ],
  },
  footer: 'NMWC Customer Master · Supervisor Guide · v1.0 · 2026-05-10',
};

const MANAGER_EN: Guide = {
  role: 'manager',
  lang: 'en',
  rolePill: 'FOR MANAGERS',
  brandLine: 'Customer Master — Region App',
  coverTitle: 'Manager User Guide',
  coverSubtitle: 'NMWC Customer Master · v1.1 · 2026-09',
  filename: 'NMWC-Manager-Guide-EN',
  welcome: {
    heading: 'Welcome',
    body: "You own the customer master in your region. Your salesmen report to you directly, so every update they submit comes to you for approval; you also approve reactivations of closed shops, manage your team's access (passwords, route assignments), keep an eye on data quality, and can download a report of exactly what the field force changed. This guide covers everything specific to your role.",
  },
  sections: [
    {
      number: 1,
      title: 'Logging in',
      steps: [
        { html: 'Open <strong>https://nmwc-cm.vercel.app</strong>.', img: '01-login.png' },
        { html: 'Sign in with your manager credentials.' },
      ],
    },
    {
      number: 2,
      title: 'Daily dashboard check',
      steps: [
        { html: 'Tap <strong>Dashboard</strong> in the menu.', img: '10-manager-dashboard.png' },
        {
          html: 'You see totals for your region: active customers, pending approvals, reactivation requests, recent activity.',
        },
        { html: 'Use it as a 30-second morning check before opening anything else.' },
      ],
    },
    {
      number: 3,
      title: "Approve your salesmen's updates",
      intro:
        'Since go-live (September 2026) there are no Supervisor accounts: every update a salesman submits for a customer in your region comes to you.',
      steps: [
        {
          html: 'Tap <strong>Approvals</strong> in the menu. You see every pending submission from your region&rsquo;s salesmen, oldest first, with the number of changed fields, who submitted and how long ago.',
          img: '08-supervisor-approvals-queue.png',
        },
        {
          html: 'Tap a row. You see a <strong>Before / After</strong> diff for every field that changed (channel names, not codes).',
          img: '09-supervisor-approval-diff.png',
        },
        {
          html: 'Below the diff, <strong>Photos &amp; location on file</strong> shows the CR document, shop front, signboard and any extra photos — tap one to open it full size — and <strong>Open in Google Maps</strong> for the location on file and for the proposed location when it changed.',
        },
        {
          html: 'Tap <strong>✓ Approve</strong> (a confirmation pops up) and the change goes live on the master immediately, or <strong>✗ Reject</strong> with a category and a reason — the salesman sees it under <em>Needs correction</em> and re-submits after fixing.',
        },
      ],
      callouts: [
        {
          kind: 'warn',
          title: 'Check the pin and the photos together',
          body: 'Compare the map pin with the shop address and the shop-front photo. A manually entered location shows a <strong>Manual</strong> tag with the salesman&rsquo;s reason — make sure it is plausible before approving.',
        },
        {
          kind: 'danger',
          title: "Don't approve your own work",
          body: 'The system blocks you from approving anything you submitted yourself. Ask a peer manager.',
        },
      ],
    },
    {
      number: 4,
      title: 'Field-update report (Excel) — what was edited, what was not',
      steps: [
        {
          html: 'Tap <strong>Export</strong> in the menu. In the <strong>Field-update report</strong> box pick the window (from / until) and tap <strong>Download field-update report</strong>. Region and route ticks above apply to it too.',
        },
        {
          html: 'Sheet <strong>Customers</strong>: every customer in your region, one row per branch. Each cell a salesman changed and you approved inside the window is <strong>yellow</strong> — hover it for the old value, who changed it and when. <strong>Orange</strong> cells carry a proposal not yet approved (the cell shows the current value). Cells with no colour were not touched.',
        },
        {
          html: 'Sheet <strong>Changes</strong>: one row per change (before → after, submitted by, approved by, when). Sheet <strong>By salesman</strong>: per-salesman totals — customers updated, fields changed, photos added, GPS captured, still pending.',
        },
        { html: 'Tick <strong>Only customers with changes</strong> to drop the untouched rows.' },
      ],
    },
    {
      number: 5,
      title: 'Approve or reject reactivations',
      intro:
        'Reactivations bring closed shops back into the active master. Only managers can approve them.',
      steps: [
        {
          html: 'Tap <strong>Reactivations</strong> in the menu.',
          img: '11-manager-reactivations.png',
        },
        { html: 'You see all closed shops your salesmen have asked to reopen.' },
        {
          html: "Each row shows the salesman's reason and the photo they captured today at the shop.",
        },
        { html: 'Tap the photo to see it full size and confirm the shop is genuinely open.' },
        {
          html: "Tap <strong>✓ Reactivate</strong> if you're satisfied — the branch goes back to ACTIVE.",
        },
        { html: 'Tap <strong>Keep closed</strong> to reject. The salesman sees your decision.' },
      ],
      callouts: [
        {
          kind: 'warn',
          title: 'Photo evidence freshness',
          body: 'The photo must be captured AFTER the shop was marked closed. The system rejects pre-closure photos automatically. If you see one that slipped through, reject the reactivation and ask the salesman to re-photograph.',
        },
      ],
    },
    {
      number: 6,
      title: 'Manage your team',
      steps: [
        { html: 'Tap <strong>Users</strong> in the menu.', img: '12-manager-users.png' },
        {
          html: 'You see the users in your region: salesmen, supervisors, anyone reporting up to you. The list opens on the <strong>Active</strong> tab — the accounts that can be used. <strong>Disabled</strong> and <strong>All</strong> sit next to it, with the count of what the current tab is hiding shown under the title.',
        },
        {
          html: '<strong>Reset password</strong> — for a salesman who forgot theirs. Set a temporary password; the system forces them to change it on next login.',
        },
        {
          html: '<strong>Disable</strong> — when a salesman leaves the company. They can no longer log in. Their history stays in audit logs.',
        },
        {
          html: '<strong>Reassign route</strong> — if a salesman switches routes. The new owner can immediately see those customers.',
        },
      ],
    },
    {
      number: 7,
      title: 'Routes and regions',
      steps: [
        { html: 'Tap <strong>Routes &amp; regions</strong> in the menu.' },
        { html: 'Add a new route, mark one inactive, see which salesman owns each route.' },
        { html: 'Routes belong to regions; you only manage routes in regions assigned to you.' },
      ],
    },
    {
      number: 8,
      title: 'Audit log — when investigating',
      intro: 'Use this when something looks unusual or HR asks who did what.',
      steps: [
        { html: 'Tap <strong>Audit log</strong> in the menu.' },
        {
          html: 'Every action by every user is logged: login, login fail, customer create/update, approval, reject, reactivation, photo capture, password reset, etc.',
        },
        {
          html: 'Each row shows: who, when, from what IP, what action, on what record. Old/new values too.',
        },
        { html: 'Filter by user, date range, action type, or customer to narrow down.' },
      ],
      callouts: [
        {
          kind: 'info',
          title: 'Audit logs are immutable',
          body: 'Once written, no one — not even you, not the steward — can edit or delete an audit row. This is by design. It is the trustworthy paper trail for your region.',
        },
      ],
    },
    {
      number: 9,
      title: 'Common situations',
      table: {
        headers: ['Situation', 'What to do'],
        rows: [
          [
            'A salesman says "Submit is greyed out"',
            'The form lists what is still missing (photos, GPS, phone …). They can save a draft and finish at the shop. Nothing reaches you until it is submitted.',
          ],
          [
            '"Required fields are now missing on this customer"',
            'A required photo was removed after the submit. Reject with "Missing field" so the salesman re-captures it and re-submits.',
          ],
          [
            '"Photo was captured before the last status change"',
            'A salesman tried to use an old photo for a reactivation. Reject — they need to take a fresh photo at the shop today.',
          ],
          [
            '"My team can\'t log in"',
            'Check Audit log for "LOGIN_FAIL" entries. Usually a typed password (system locks them out for 1 minute after 5 wrong tries).',
          ],
          [
            '"Cannot approve your own request"',
            'You submitted the request originally. Forward to a peer manager.',
          ],
          [
            '"You have no managed regions assigned"',
            "Your account hasn't been assigned a region yet. Contact head office.",
          ],
          [
            'Salesman moved to another route',
            'Use the Users page → Reassign route. New customers visible immediately.',
          ],
          [
            'Salesman left the company',
            'Disable on the Users page. Their audit trail is preserved.',
          ],
        ],
      },
    },
  ],
  ref: {
    title: '10. Quick reference card',
    tables: [
      {
        title: 'Manager-only actions',
        rows: [
          ['<strong>✓ Approve / ✗ Reject</strong>', "Decide a salesman's update (Approvals)."],
          ['<strong>✓ Reactivate</strong>', 'Bring a closed shop back to ACTIVE.'],
          ['<strong>Keep closed</strong>', 'Reject a reactivation request.'],
          ['<strong>Reset password</strong>', 'Generate a temporary password for a team member.'],
          ['<strong>Disable user</strong>', 'Block a leaver from logging in.'],
          ['<strong>Reassign route</strong>', 'Move a route to another salesman.'],
          ['<strong>Force override</strong>', 'Edit the master directly. Use sparingly — logged.'],
        ],
      },
      {
        title: 'Where to look',
        rows: [
          ['<strong>Dashboard</strong>', 'Daily morning check. Region totals.'],
          ['<strong>Reactivations</strong>', 'Closed shops asking to reopen.'],
          ['<strong>Users</strong>', 'Your team. Passwords, status, route ownership.'],
          ['<strong>Audit log</strong>', 'Every action ever taken in your region.'],
          ['<strong>Approvals</strong>', "Your salesmen's pending updates — review with photos and map, approve or reject."],
          ['<strong>Export</strong>', 'Customer master .xlsx and the field-update report (changes highlighted).'],
        ],
      },
    ],
  },
  footer: 'NMWC Customer Master · Manager Guide · v1.1 · 2026-09-10',
};

// ────────────────────────────────────────────────────────────────────
// Content — Steward (English only, head-office data role)
// ────────────────────────────────────────────────────────────────────

const STEWARD_EN: Guide = {
  role: 'steward',
  lang: 'en',
  rolePill: 'FOR DATA STEWARDS',
  brandLine: 'Customer Master — Data Operations',
  coverTitle: 'Data Steward User Guide',
  coverSubtitle: 'NMWC Customer Master · v1.0 · 2026-05',
  filename: 'NMWC-Steward-Guide-EN',
  welcome: {
    heading: 'Welcome',
    body: "You own the integrity of the customer master from head office. Your work is heavier than the field roles — you bulk-import lists from the ERP, merge duplicates that the field can't see across regions, monitor the entire audit trail, and export the cleaned master back to downstream systems. This guide covers every screen you will use, with a focus on the safety rules: every steward action is high-trust, immediately visible across the company, and logged forever.",
  },
  sections: [
    {
      number: 1,
      title: 'Logging in and your scope',
      intro:
        'Your account sees everything: every region, every route, every customer. Other roles cannot.',
      steps: [
        {
          html: 'Open <strong>https://nmwc-cm.vercel.app</strong> on your laptop. The steward workflow is desktop-first because of the bulk-import / export / duplicate-review screens.',
          img: '01-login.png',
        },
        { html: 'Sign in with your steward credentials.' },
        {
          html: 'After login you land on the <strong>Import</strong> page by default. The left sidebar shows your full menu: Import, Export, Customers, Duplicates, Work items.',
        },
      ],
      callouts: [
        {
          kind: 'danger',
          title: 'Your power and your responsibility',
          body: 'You can edit, soft-delete, and merge any customer in any region. There is no four-eyes approval on most steward actions — the audit log is your accountability. Always cross-check before any bulk action.',
        },
      ],
    },
    {
      number: 2,
      title: 'Browse the customer master',
      intro: 'See the full master across all regions and routes.',
      steps: [
        { html: 'Tap <strong>Customers</strong> in the sidebar.', img: 'steward-02-customers.png' },
        {
          html: 'You see every customer in every region. Filter by region, channel, payment terms, or completeness score.',
        },
        {
          html: 'The search box runs on legal name, NMWC code, or primary phone — partial matches work (e.g. "lulu" finds every Lulu branch).',
        },
        {
          html: 'Click any row to open the customer profile and see the full record + branches + edit history + audit trail.',
        },
      ],
    },
    {
      number: 3,
      title: 'Import — bulk upload from xlsx',
      intro:
        'Two distinct importers, one entry point, and a fixed order. The templates for both files are in docs/import-templates (account-master-template.xlsx, customer-master-template.xlsx) with an Instructions tab each.',
      steps: [
        {
          html: '<strong>Before any import:</strong> make sure the <strong>Manager</strong> and <strong>Steward</strong> accounts already exist in <strong>Users</strong>. The import deliberately cannot create or promote those two roles — no administrator can ever be minted from a spreadsheet. Managers must exist first because the account master then assigns them their regions.',
        },
        { html: 'Tap <strong>Import</strong> in the sidebar.', img: 'steward-03-import.png' },
        {
          html: '<strong>Account Master</strong> (left card) goes <strong>first</strong>: a workbook with three sheets — <strong>Regions</strong>, <strong>Routes</strong>, <strong>Users</strong>. Existing rows with matching keys are <em>updated</em> in place; new rows are <em>added</em>; an existing user keeps their password, role and supervisor unless a column says otherwise. Routes must exist before the customers that reference them.',
        },
        {
          html: '<strong>Customer Master</strong> (right card) goes <strong>second</strong>: a single-sheet workbook, one row per branch. Region and route are matched on their <strong>codes</strong>, never their names. It goes to a <em>staged batch</em> first — nothing changes in the live master until you review and promote.',
        },
        {
          html: 'Both cards have an <strong>Expected columns</strong> expandable — read it once before your first import to confirm header names match.',
        },
        {
          html: 'Click <strong>Choose File</strong>, pick the .xlsx, then click <strong>Upload</strong>. Wait for the upload to finish.',
        },
      ],
      callouts: [
        {
          kind: 'tip',
          title: 'Recommended monthly cadence',
          body: 'Import account master changes (new salesman, retired route) within 24h of HR notifying you. Import customer master refreshes from the ERP at month-end after the ERP team confirms their export is final.',
        },
        {
          kind: 'warn',
          title: 'Account master writes immediately',
          body: 'Unlike the customer master, the account-master path applies its changes the moment the upload completes (after Zod validation). There is no staging step. Double-check the workbook before clicking Upload.',
        },
      ],
    },
    {
      number: 4,
      title: 'Review, promote and reconcile a staged customer batch',
      intro:
        'A customer-master import is staged, promoted in passes, and then reconciled. It is not finished when the screen stops moving — it is finished when the six figures add up.',
      steps: [
        {
          html: 'After the customer-master upload finishes, you land on the batch page. The <strong>Recent batches</strong> table on the Import page also lists every batch.',
        },
        {
          html: 'The page shows six figures: <strong>Total · Clean · Quarantined · Promoted · Rejected · Left to promote</strong>. Rows that need a decision (<strong>REJECTED</strong> and <strong>QUARANTINED</strong>) are always listed <em>first</em> in the table below, each with its reason, so none can hide further down a long file.',
        },
        {
          html: 'Review the <strong>QUARANTINED</strong> rows first — bad phone format, an unknown channel or visit-day code, a duplicate phone or CR on a different customer. Fix the source row in your copy of the xlsx and re-import it, or accept that it stays out. Quarantined rows are never promoted.',
        },
        {
          html: 'Click <strong>Promote N clean rows</strong>. On a full master this <strong>runs in passes</strong> — the button reads “Promoting… 1,200 done, 2,100 left” and keeps going by itself. Leave the tab open until it reports <strong>Done</strong>.',
        },
        {
          html: 'If it is interrupted — tab closed, connection dropped — nothing is lost. Everything already promoted is saved. The page shows <strong>Promote interrupted</strong> with a <strong>Resume promote</strong> button that continues exactly where it stopped, and the batch appears in your <strong>Work</strong> list as “Import to resume” so it cannot be forgotten.',
        },
        {
          html: 'Only <strong>one</strong> customer import can be promoted at a time. A second attempt is refused and names the file already running — finish (or abandon) that one first.',
        },
        {
          html: 'When it finishes, <strong>reconcile</strong>: <em>Left to promote</em> must be 0, and <em>Promoted + Rejected + Quarantined</em> must equal <em>Total</em>. Then open every <strong>REJECTED</strong> row: a rejected row is <strong>not</strong> in the master. Typical reasons are a branch code that already belongs to another customer, or a Temix code recorded on a different customer. Correct the source and re-import those customers.',
        },
        {
          html: 'Record the six figures (a screenshot of the batch page is enough) as the evidence that the load was checked. The load is complete only when every rejected and quarantined row is resolved or formally accepted as excluded.',
        },
      ],
      callouts: [
        {
          kind: 'info',
          title: 'Why staging, and why passes?',
          body: 'A bad bulk-import that lands directly into the master is hard to undo, so the batch is staged and you see exactly what would change before committing. A real master is thousands of rows — far too many for one request — so promotion works through it in passes, each pass committing its customers and recording an audit row. No customer is ever loaded twice and none is skipped, however many times the load is resumed.',
        },
        {
          kind: 'warn',
          title: 'A technical fault is not a rejection',
          body: 'If the database falters mid-pass, the affected customers are not rejected — they are retried on the next pass. If a pass makes no progress at all the load stops and tells you; escalate that to IT rather than clicking Resume repeatedly.',
        },
        {
          kind: 'danger',
          title: 'Imported customers skip the approval chain',
          body: 'Customers loaded this way are created directly — they do not go through Supervisor → Finance → GM → Accountant. That is deliberate (they are existing customers being migrated) and it is why importing is yours alone and fully audited. Every customer created in the field after go-live follows the chain in full.',
        },
      ],
    },
    {
      number: 5,
      title: 'Find and merge duplicates',
      intro: "Duplicates are the master's biggest enemy. The steward's queue surfaces three kinds.",
      steps: [
        {
          html: 'Tap <strong>Duplicates</strong> in the sidebar.',
          img: 'steward-06-duplicates.png',
        },
        {
          html: 'Each pair card shows the match reason at the top — <strong>PHONE</strong> (exact phone number match across two customers), <strong>CR</strong> (same Commercial Registration number), or <strong>NAME</strong> (fuzzy similarity ≥ 0.7).',
        },
        {
          html: 'Compare the two cards side-by-side: NMWC code, phone, CR, branch count. The customer with more branches and a higher completeness score is usually the better keeper.',
        },
        {
          html: 'Three actions:<ul><li><strong>Mark distinct</strong> — these are NOT duplicates. The pair is recorded in the audit log and will not surface again.</li><li><strong>Keep ←</strong> — the LEFT customer is the survivor. The right one is soft-deleted. Its branches and edit history move to the survivor.</li><li><strong>Keep →</strong> — same, but the RIGHT customer survives.</li></ul>',
        },
      ],
      callouts: [
        {
          kind: 'warn',
          title: 'Cross-region merges need a reason',
          body: 'If the two customers are in different regions, the merge requires you to confirm explicitly and write a 5+ character reason. The reason ends up in the audit trail.',
        },
        {
          kind: 'danger',
          title: 'Merges are permanent',
          body: 'A merge soft-deletes one customer. It can be reversed only by a steward intervention via the audit log + a manual restore. Be sure before you click Keep.',
        },
      ],
    },
    {
      number: 6,
      title: 'Export — the master for the ERP, and the field-update report',
      intro:
        'When the field team has enriched enough records, you push the cleaned master back downstream — and you can see exactly what they changed.',
      steps: [
        { html: 'Tap <strong>Export</strong> in the sidebar.', img: 'steward-05-export.png' },
        {
          html: 'Pick filters: region(s), route(s), status, payment terms (cash / credit), completeness threshold (e.g. only records ≥ 80% complete), updated since.',
        },
        {
          html: 'Click <strong>Download .xlsx</strong> — one row per branch. It is a report, not an import file: do not re-upload it (region, channel and status columns differ from what the importer expects); for bulk changes start from the import template. <strong>Download all (no filters)</strong> gives the whole master (up to 60,000 rows in one file).',
        },
        {
          html: '<strong>Field-update report:</strong> in the amber box pick the window (from / until) and click <strong>Download field-update report</strong>. Sheet <em>Customers</em> is the same master with every cell changed by an approved salesman edit in the window in <strong>yellow</strong> (hover for was → now, by, when), pending proposals in <strong>orange</strong>, photos added in yellow; sheet <em>Changes</em> lists every change, <em>By salesman</em> the totals, <em>Legend</em> the colours. Unhighlighted cells were not touched.',
        },
        {
          html: 'If a download fails with "too large", narrow by region or route and try again.',
        },
      ],
      callouts: [
        {
          kind: 'tip',
          title: 'A good completeness threshold',
          body: 'For mid-pilot exports use 60% — gets you the rows with names, phones, GPS, and at least one photo. For year-end exports use 90% — gives you only the records the field has fully validated.',
        },
      ],
    },
    {
      number: 7,
      title: 'Audit log — your investigation tool',
      intro: 'Every action by every user, immutable, queryable.',
      steps: [
        { html: 'Tap <strong>Audit log</strong> in the sidebar.', img: 'steward-07-audit.png' },
        {
          html: 'Each row: who, when, from what IP and user-agent, what action (CREATE / UPDATE / APPROVE / REJECT / MERGE / IMPORT / REACTIVATE / LOGIN / LOGIN_FAIL / FORCE_OVERRIDE / DELETE / SOFT_DELETE / PHOTO_VIEW), on what entity, with old and new values stored as JSON.',
        },
        {
          html: 'Filter by user (e.g. investigate one salesman), date range (e.g. last week), entity type (Customer / Branch / CustomerEdit / User), or action type.',
        },
        {
          html: 'For an HR investigation: filter by user + date range + entity type Customer to see exactly what they changed.',
        },
        {
          html: 'For a "what happened" investigation on one customer: open the customer, click <strong>History</strong> — same data filtered to that record.',
        },
      ],
      callouts: [
        {
          kind: 'info',
          title: 'Audit logs are immutable',
          body: 'Once written, no one — not even you — can edit or delete an audit row. By design. This is the trustworthy paper trail. Even FORCE_OVERRIDE actions by managers leave a row.',
        },
      ],
    },
    {
      number: 8,
      title: 'Routes, regions, and channel taxonomy',
      intro: 'The fixed reference tables that everything else depends on.',
      steps: [
        {
          html: 'Tap <strong>Routes &amp; regions</strong> in the sidebar.',
          img: 'steward-08-routes.png',
        },
        {
          html: 'You see every region (e.g. Muscat) and every route under it (C1, C4, MH01, etc.).',
        },
        {
          html: "Add a new route when a new salesman starts. Mark a route inactive when it's consolidated. Don't delete — it would break audit trails for past customers.",
        },
        {
          html: 'The <strong>Channel taxonomy</strong> (General Trade, HORECA, Modern Trade, sub-channels) is locked — see PRD Appendix A. If a sub-channel is missing, file an ops ticket; do not edit the taxonomy live.',
        },
      ],
    },
    {
      number: 9,
      title: 'User management — view-only for stewards',
      intro: 'Stewards see all users for visibility but most user-edit actions belong to managers.',
      steps: [
        { html: 'Tap <strong>Users</strong> in the sidebar.', img: 'steward-09-users.png' },
        {
          html: 'You see users in every region. Useful for understanding "who reports to whom" and confirming the org chart matches what HR has.',
        },
        {
          html: 'The list opens on the <strong>Active</strong> tab, which is NOT every account: the pilot and QA accounts kept for their audit history are deactivated, and they sit on <strong>Disabled</strong>. When you reconcile the roster against HR, read it from the <strong>All</strong> tab — otherwise the counts will not match and accounts will look missing.',
        },
        {
          html: "Reset password, disable, and reassign-route actions live with the user's manager. Forward HR requests to the right manager.",
        },
        {
          html: "You CAN onboard a new manager (since managers don't have a higher-rank approver) — head office hands you the request, you create the user record with the MANAGER role and the regions they cover.",
        },
      ],
    },
    {
      number: 10,
      title: 'Backup, recovery, and your responsibilities',
      intro:
        'You are not the database admin, but you are the first to know when something goes wrong.',
      table: {
        headers: ['Concern', 'What you do'],
        rows: [
          [
            '<strong>Daily DB backup</strong> — check the GitHub Actions tab once a week to confirm the nightly run is green.',
            'If a run is red two days in a row, alert ops. The dump goes to the <code>nmwc-backups</code> R2 bucket as <code>db/&lt;DATE&gt;.sql.gz</code>.',
          ],
          [
            '<strong>Photo storage</strong> — R2 lifecycle deletes "gc-marked" photos after 7 days.',
            "You don't touch this. It runs on its own. If you suspect lost photos, check the audit log first.",
          ],
          [
            '<strong>"I deleted the wrong customer"</strong>',
            'Open the audit log, find the SOFT_DELETE row for that customer, get the JSON of the prior state, and restore it via a steward-only Prisma script (head-office ops can write this).',
          ],
          [
            '<strong>"I promoted a bad batch"</strong>',
            "Audit log filters action=IMPORT — find the batch row, then write a one-off undo script with ops. Don't try to revert via the UI.",
          ],
          [
            '<strong>Quarterly drill</strong>',
            'Run the manual <em>restore-drill</em> GitHub Action. Confirms the latest dump can actually be restored into a Neon branch.',
          ],
        ],
      },
      callouts: [
        {
          kind: 'warn',
          title: 'Never run scripts against the production DB without ops',
          body: 'Stewards have full read access to everything. Direct write scripts to fix mistakes must be run by head-office ops, peer-reviewed, and committed to git. Never run an unsaved one-off SQL command on prod.',
        },
      ],
    },
    {
      number: 11,
      title: 'Common situations',
      table: {
        headers: ['Situation', 'What to do'],
        rows: [
          [
            '"Cannot promote — quarantined rows"',
            'Open the batch, fix or reject the QUARANTINED rows, then re-promote.',
          ],
          [
            '"Phone now belongs to X (Y) — reject and ask the salesman"',
            'A salesman submitted a phone that conflicts with another customer in the master. Reject the edit; the salesman fixes at the shop.',
          ],
          [
            '"Manager creates regions silently"',
            'A new region was added without the usual ticket. Check audit log for action=CREATE entityType=Region. If unauthorized, escalate.',
          ],
          [
            '"Customer master has many duplicates"',
            'Run a duplicate review session. Sort by similarity. Tackle PHONE matches first (1.0 similarity = same phone), then CR, then NAME.',
          ],
          [
            '"Export failed"',
            "Check the row's error message. Most are network blips — re-run. If it persists, check the date range — exports over 50k rows can time out.",
          ],
          [
            '"User left the company"',
            'Forward to their manager. The manager uses the Users page → Disable. Their audit trail stays.',
          ],
        ],
      },
    },
  ],
  ref: {
    title: '12. Quick reference card',
    intro: 'For your desk.',
    tables: [
      {
        title: 'Steward-only actions',
        rows: [
          [
            '<strong>Upload account master</strong>',
            'Bulk upload Regions/Routes/Users xlsx. Applied immediately after validation.',
          ],
          [
            '<strong>Upload customer master</strong>',
            'Bulk upload customer xlsx. Goes to staged batch first.',
          ],
          ['<strong>Promote batch</strong>', 'Apply CLEAN rows to the live master.'],
          [
            '<strong>Mark distinct</strong>',
            'A pair the detector flagged is actually two different customers.',
          ],
          ['<strong>Keep ← / Keep →</strong>', 'Merge a duplicate. The chosen side survives.'],
          ['<strong>Generate export</strong>', 'Produce a filtered xlsx for the ERP team.'],
          ['<strong>Audit log</strong>', 'Every action ever taken — searchable.'],
        ],
      },
      {
        title: 'When to use which action',
        rows: [
          ['HR sends new org-chart', 'Edit account-master xlsx → Upload account master.'],
          [
            'ERP team sends month-end customer list',
            'Upload customer master → review staged batch → fix QUARANTINED → Promote.',
          ],
          [
            'Salesman flags a duplicate at the shop',
            'Open Duplicates, find the pair, decide Keep ← or Keep → after reviewing both records.',
          ],
          [
            'ERP team asks for the cleaned master',
            'Export with completeness ≥ 60% (mid-pilot) or ≥ 90% (year-end).',
          ],
          ['HR investigates a salesman', 'Audit log → filter by user + date range.'],
          [
            'Customer profile shows wrong info, no one knows why',
            'Audit log → filter by entity Customer + entityId from URL.',
          ],
        ],
      },
      {
        title: 'Severity guide',
        rows: [
          [
            '<strong>🟢 Routine</strong>',
            'Customer-master uploads, weekly duplicate review, monthly exports.',
          ],
          [
            '<strong>🟡 Care needed</strong>',
            'Cross-region merges, batch promotions, account-master uploads.',
          ],
          [
            '<strong>🔴 High-stakes</strong>',
            'Restoring soft-deleted customers, undoing a bad import, anything that touches data outside the staging pipeline.',
          ],
        ],
      },
    ],
  },
  footer: 'NMWC Customer Master · Data Steward Guide · v1.0 · 2026-05-10',
};

// ────────────────────────────────────────────────────────────────────
// Content — Arabic (translations of the same content)
// ────────────────────────────────────────────────────────────────────

const SALESMAN_AR: Guide = {
  role: 'salesman',
  lang: 'ar',
  rolePill: 'لمندوبي المبيعات',
  brandLine: 'نظام بيانات العملاء — تطبيق الميدان',
  coverTitle: 'دليل مندوب المبيعات',
  coverSubtitle: 'NMWC نظام إدارة بيانات العملاء · الإصدار 1.0 · 2026-05',
  filename: 'NMWC-Salesman-Guide-AR',
  welcome: {
    heading: 'مرحبًا',
    body: 'هذا دليلك اليومي. تطبيق NMWC لإدارة بيانات العملاء يساعدك في تحديث بيانات كل محل في خط سيرك مباشرةً من الميدان. هذا الدليل يأخذك خطوة بخطوة في كل ما ستحتاج إليه: تسجيل الدخول، إيجاد المحل، إصلاح البيانات الناقصة، التقاط الصور، تحديد الموقع، إرسال للموافقة، والتعامل مع المحلات المغلقة أو المعاد فتحها.',
  },
  sections: [
    {
      number: 1,
      title: 'تسجيل الدخول',
      intro: 'تقوم بهذا في أول مرة فقط، ثم مرة في اليوم أو الأسبوع.',
      steps: [
        {
          html: 'افتح من هاتفك: <strong>https://nmwc-cm.vercel.app</strong>. احفظه كاختصار في شاشة هاتفك الرئيسية.',
          img: '01-login.png',
        },
        { html: 'اكتب <strong>اسم المستخدم</strong> الخاص بك. مديرك يعطيك إياه في أول يوم.' },
        {
          html: 'اكتب <strong>كلمة المرور</strong>. اضغط زر <strong>تسجيل الدخول</strong> الأزرق.',
        },
        {
          html: 'هل هذه أول مرة؟ قد يطلب منك التطبيق تعيين كلمة مرور جديدة. هذا لحماية حسابك — اختر شيئًا تعرفه أنت فقط.',
        },
      ],
      callouts: [
        {
          kind: 'tip',
          title: 'هل نسيت كلمة المرور؟',
          body: 'لا تحاول تخمينها أكثر من 5 مرات — النظام سيقفل حسابك مدة دقيقة. كلّم مديرك مباشرة — يستطيع إعادة ضبطها خلال 30 ثانية.',
        },
      ],
    },
    {
      number: 2,
      title: 'البحث عن المحل الذي ستزوره',
      intro: 'افتح بيانات العميل بضغطتين فقط.',
      steps: [
        {
          html: 'اضغط على <strong>اليوم</strong> في القائمة. ترى المحلات المجدولة في خط سيرك اليوم.',
          img: '02-salesman-today.png',
        },
        {
          html: 'إذا لم يكن المحل في قائمة اليوم، اضغط على <strong>العملاء</strong> وابحث بالاسم أو برقم NMWC.',
          img: '03-salesman-customers-list.png',
        },
        { html: 'اضغط على أي صف لفتح ملف ذلك المحل.' },
      ],
      callouts: [
        {
          kind: 'info',
          title: 'ما الفرق بين العميل والفرع؟',
          body: '"العميل" هو الكيان القانوني (اسم الشركة في السجل التجاري). "الفرع" هو المحل الفعلي الذي تزوره. أغلب العملاء لديهم فرع واحد ("الرئيسي"). السلاسل الكبيرة لديها عدة فروع.',
        },
      ],
    },
    {
      number: 3,
      title: 'تحديث بيانات المحل',
      intro: 'املأ ما هو ناقص. الحقول الإلزامية معلّمة بـ *.',
      steps: [
        {
          html: 'في ملف العميل، اضغط زر <strong>تحديث البيانات</strong> الأزرق في أعلى يسار الشاشة.',
          img: '04-salesman-customer-profile.png',
        },
        {
          html: 'قسم <strong>الهوية</strong>: الاسم القانوني، رمز NMWC، رقم السجل التجاري، القناة، القناة الفرعية، الشخص المسؤول، الهاتف الرئيسي.',
          img: '05-salesman-enrichment-top.png',
        },
        {
          html: 'يجب أن يكون رقم الهاتف رقمًا عمانيًا صحيحًا، مثل: <strong>+96891234567</strong>.',
        },
        {
          html: 'القناة تحدد نوع المحل — اختر الأقرب (تجارة عامة، فنادق ومطاعم، تجارة حديثة، إلخ).',
        },
      ],
    },
    {
      number: 4,
      title: 'التقاط الصور',
      intro:
        'دائمًا التقط صورًا جديدة في المحل اليوم. الصور القديمة من المعرض مرفوضة. صورة واجهة المحل مطلوبة للإرسال؛ الصور الأخرى ترفع نسبة الاكتمال.',
      steps: [
        {
          html: 'اضغط على خانة صورة فارغة. الكاميرا ستفتح.',
          img: '06-salesman-enrichment-photos.png',
        },
        { html: '<strong>واجهة المحل</strong> (مطلوبة) — تظهر مدخل المحل بوضوح. لعميل التوصيل المنزلي: مدخل المبنى.' },
        { html: '<strong>اللافتة</strong> — لافتة المحل التي يظهر عليها الاسم، إن وُجدت.' },
        { html: '<strong>السجل التجاري</strong> — وثيقة السجل التجاري الرسمية، إذا كان العميل منشأة مسجّلة.' },
        {
          html: 'التطبيق يرفع الصورة تلقائيًا. إذا كانت شبكتك ضعيفة، يحاول مرة أخرى لوحده. إذا فشل، اضغط <strong>إعادة الرفع</strong> — صورتك محفوظة، لا تحتاج لإعادة التقاطها.',
        },
      ],
      callouts: [
        {
          kind: 'warn',
          title: 'التقط الصور في المحل، ليس من المعرض',
          body: 'الصور التي عمرها أكثر من 24 ساعة مرفوضة. المشرفون يرون متى التُقطت كل صورة. التقاطها على الفور هو الطريقة الوحيدة.',
        },
      ],
    },
    {
      number: 5,
      title: 'تحديد الموقع الجغرافي (GPS)',
      steps: [
        { html: 'اضغط زر <strong>تحديد الموقع</strong> وأنت واقف عند مدخل المحل.' },
        { html: 'هاتفك سيطلب الإذن — اضغط <strong>السماح</strong>.' },
        {
          html: 'إذا لم يعمل GPS (داخل مبنى، إشارة ضعيفة)، اضغط <strong>إدخال الإحداثيات يدويًا</strong>. اضغط على الخريطة في موقع المحل، أو اكتب خطي العرض والطول. أضف سببًا قصيرًا حتى يفهم المشرف أن الإدخال يدوي.',
        },
      ],
    },
    {
      number: 6,
      title: 'إرسال للموافقة',
      steps: [
        {
          html: 'انزل إلى أسفل الصفحة — سترى شريطًا ثابتًا فيه زرّان.',
          img: '07-salesman-enrichment-bottom.png',
        },
        { html: 'اضغط زر <strong>إرسال للموافقة</strong> الأزرق (على اليسار).' },
        { html: 'سترى رسالة تأكيد. حالة المحل تصبح <strong>قيد المراجعة</strong> حتى يقرر مشرفك.' },
        {
          html: 'إذا قطعك أحد، اضغط <strong>حفظ مسودة</strong> بدلًا من ذلك — تبقى في هاتفك 7 أيام.',
        },
      ],
    },
    {
      number: 7,
      title: 'تأشير المحل كمغلق نهائيًا',
      intro: 'استخدم هذا فقط إذا أُغلق المحل فعلًا (ترك العمل، انتقل، إلخ).',
      steps: [
        { html: 'في ملف العميل، اضغط زر <strong>تأشير كمغلق</strong> الأحمر على بطاقة الفرع.' },
        {
          html: 'التقط صورة جديدة تظهر فيها أن المحل مغلق بوضوح (الأبواب منزّلة، اللافتة مرفوعة، فارغ).',
        },
        { html: 'اكتب سببًا قصيرًا — على الأقل 5 أحرف. مثلاً: "أغلق المحل، اللافتة مرفوعة."' },
        { html: 'اضغط <strong>إرسال الإغلاق</strong>. مشرفك يراجعه.' },
      ],
      callouts: [
        {
          kind: 'warn',
          title: 'تأكد قبل أن تأشره',
          body: 'الصورة المشوّشة أو الملتقطة من بعيد سترفض. أظهر المدخل المغلق بوضوح.',
        },
      ],
    },
    {
      number: 8,
      title: 'طلب إعادة تفعيل محل مغلق',
      intro: 'استخدم هذا عندما يعيد محل مغلق فتح أبوابه.',
      steps: [
        { html: 'افتح ملف المحل المغلق. الفرع يظهر عليه وسم <strong>مغلق</strong>.' },
        { html: 'اضغط زر <strong>طلب إعادة التفعيل</strong> الأخضر.' },
        { html: 'التقط صورة جديدة تظهر أن المحل مفتوح ويعمل اليوم.' },
        { html: 'اكتب سببًا وأرسل. <strong>المدير</strong> (وليس مشرفك) يوافق على إعادة التفعيل.' },
      ],
      callouts: [
        {
          kind: 'info',
          title: 'لماذا صورة جديدة؟',
          body: 'النظام يتحقق أن الصورة التُقطت بعد إغلاق المحل. هذا يمنع أي شخص من استخدام صورة قديمة لتزوير إعادة فتح.',
        },
      ],
    },
    {
      number: 9,
      title: 'مواقف شائعة',
      table: {
        headers: ['الموقف', 'ما العمل'],
        rows: [
          [
            'رفع الصورة يفشل باستمرار',
            'انتقل إلى الخارج أو قرب نافذة. انتظر بضع ثوانٍ. التطبيق يحاول تلقائيًا. إذا استمر التعذر، اضغط "إعادة الرفع" — صورتك محفوظة.',
          ],
          [
            'GPS لا يلتقط',
            'اضغط "إدخال الإحداثيات يدويًا" داخل قسم GPS. اضغط على الخريطة أو اكتب الأرقام. أضف سببًا قصيرًا.',
          ],
          [
            '"هذا العميل ليس في خط سيرك"',
            'يمكنك تحديث المحلات في خط سيرك المحدد فقط. اطلب من المدير إعادة تعيينه إن لزم.',
          ],
          [
            'طلبي مرفوض',
            'اقرأ سبب المشرف. المحل يظهر في قائمة "يحتاج تصحيح". افتحه، صحّح ما طلبه، وأعد الإرسال.',
          ],
          [
            'أنا في وسط النموذج وأحتاج للمغادرة',
            'اضغط "حفظ مسودة". يمكنك العودة خلال 7 أيام والإكمال.',
          ],
        ],
      },
    },
  ],
  ref: {
    title: '10. بطاقة مرجعية سريعة',
    intro: 'احتفظ بهذه الصفحة معك في أول أسابيعك.',
    tables: [
      {
        title: 'الأزرار التي ستستخدمها',
        rows: [
          ['<strong>تحديث البيانات</strong> (أزرق، أعلى يسار)', 'افتح النموذج لتحديث المحل.'],
          ['<strong>حفظ مسودة</strong>', 'احفظ عملك دون إرسال. تبقى 7 أيام.'],
          ['<strong>إرسال للموافقة</strong>', 'أرسل تغييراتك إلى المشرف.'],
          ['<strong>تأشير كمغلق</strong> (أحمر)', 'أخبر النظام أن هذا المحل أُغلق نهائيًا.'],
          ['<strong>طلب إعادة التفعيل</strong> (أخضر)', 'محل مغلق أُعيد فتحه — يُرسل إلى المدير.'],
          ['<strong>إعادة الرفع</strong>', 'إعادة إرسال صورة فشل رفعها دون إعادة التقاطها.'],
          ['<strong>تسجيل خروج</strong>', 'إنهاء جلستك. سجّل خروج دومًا على أي جهاز مشترك.'],
        ],
      },
      {
        title: 'وسوم الحالات التي ستراها',
        rows: [
          ['<strong>نشط</strong> (أخضر)', 'المحل يعمل بشكل طبيعي.'],
          ['<strong>مغلق</strong> (أحمر)', 'المحل أُغلق. لا توجد طلبيات نشطة.'],
          ['<strong>قيد المراجعة</strong>', 'أرسلت ولم يقرر المشرف بعد.'],
          ['<strong>تمت الموافقة</strong>', 'آخر إرسال لك تم اعتماده — التغيير حيّ.'],
          ['<strong>يحتاج تصحيح</strong>', 'المشرف أعاده. افتحه وصحّحه.'],
        ],
      },
      {
        title: 'بمن تتصل',
        rows: [
          ['نسيت كلمة المرور / مقفل', 'مديرك — يعيد ضبطها خلال 30 ثانية.'],
          ['الصورة أو GPS لا يعمل', 'جرّب البديل اليدوي. ثم مشرفك.'],
          ['بيانات خاطئة في النظام', 'أرسل تحديثًا فيه التصحيح.'],
        ],
      },
    ],
  },
  footer: 'NMWC نظام بيانات العملاء · دليل المندوب · الإصدار 1.0 · 2026-05-10',
};

const SUPERVISOR_AR: Guide = {
  role: 'supervisor',
  lang: 'ar',
  rolePill: 'للمشرفين',
  brandLine: 'نظام بيانات العملاء — تطبيق الموافقات',
  coverTitle: 'دليل المشرف',
  coverSubtitle: 'NMWC نظام إدارة بيانات العملاء · الإصدار 1.0 · 2026-05',
  filename: 'NMWC-Supervisor-Guide-AR',
  welcome: {
    heading: 'مرحبًا',
    body: 'أنت البوابة بين البيانات الميدانية وسجل العملاء الرئيسي. كل إرسال من المندوبين يأتي إلى قائمتك. مهمتك هي اعتماد الجيد بسرعة، رفض الخطأ بسبب واضح، واستخدام الإجراءات الجماعية عندما تكون المجموعة جيدة. هذا الدليل يأخذك خلال كل شاشة.',
  },
  sections: [
    {
      number: 1,
      title: 'تسجيل الدخول',
      steps: [
        {
          html: 'افتح <strong>https://nmwc-cm.vercel.app</strong> على الهاتف أو الحاسوب.',
          img: '01-login.png',
        },
        { html: 'سجّل الدخول باسم المستخدم وكلمة المرور الخاصين بالمشرف.' },
        { html: 'بعد تسجيل الدخول، تنتقل تلقائيًا إلى صفحة الموافقات.' },
      ],
    },
    {
      number: 2,
      title: 'فتح قائمة الموافقات',
      steps: [
        {
          html: 'اضغط على <strong>الموافقات</strong> في القائمة.',
          img: '08-supervisor-approvals-queue.png',
        },
        { html: 'ترى كل الإرسالات المعلّقة من المندوبين الذين يتبعون لك، الأقدم أولًا.' },
        { html: 'كل صف يظهر: اسم العميل، رمز NMWC، عدد الحقول المتغيرة، من أرسل، ومتى.' },
        {
          html: 'وسوم العمر: <strong>أخضر</strong> أقل من 24 ساعة، <strong>كهرماني</strong> 1-3 أيام، <strong>أحمر</strong> أكثر من 3 أيام. ابدأ بالحمراء.',
        },
      ],
    },
    {
      number: 3,
      title: 'مراجعة عملية تحرير واحدة (مقارنة قبل / بعد)',
      steps: [
        {
          html: 'اضغط على أي صف لفتح صفحة تفاصيل التحرير.',
          img: '09-supervisor-approval-diff.png',
        },
        { html: 'سترى مقارنة قبل / بعد لكل حقل تم تغييره.' },
        { html: 'قارن القيم. هل هناك شيء خاطئ، ناقص، أو مشكوك فيه؟' },
        { html: 'إذا تغيّرت صورة، اضغط عليها لرؤيتها بحجمها الكامل.' },
        {
          html: 'اضغط <strong>فتح الملف</strong> لرؤية بيانات العميل الكاملة (الحقول الأخرى، الفروع، السجل التاريخي).',
        },
      ],
    },
    {
      number: 4,
      title: 'الموافقة، الرفض، أو الإرجاع',
      callouts: [
        {
          kind: 'tip',
          title: '✓ موافقة',
          body: 'التغيير صحيح. اضغط زر <strong>موافقة</strong> الأخضر. ستظهر نافذة تأكيد. التغيير يصبح حيًّا في السجل الرئيسي فورًا.',
        },
        {
          kind: 'warn',
          title: '✗ رفض (إعادة للتصحيح)',
          body: 'هناك ما يحتاج إصلاح. اضغط زر <strong>رفض</strong> الأحمر. اختر الفئة (صورة سيئة، GPS خطأ، حقل ناقص، معلومة خاطئة، أخرى)، اختر سببًا جاهزًا من الاقتراحات، أو اكتب سببك بنفسك (5 أحرف على الأقل). المندوب سيرى هذا تمامًا ويستطيع إعادة الإرسال بعد الإصلاح.',
        },
        {
          kind: 'danger',
          title: 'لا تعتمد عملك أنت',
          body: 'النظام يمنعك من اعتماد ما أرسلته أنت. إذا أرسلت سابقًا كمندوب، يجب أن يذهب إلى مشرف آخر أو إلى المدير.',
        },
      ],
    },
    {
      number: 5,
      title: 'الموافقة الجماعية / الرفض الجماعي',
      intro: 'عندما تكون المجموعة موحدة (كلها جيدة أو كلها سيئة).',
      steps: [
        {
          html: 'في صفحة القائمة، ضع علامة بجانب كل تحرير تريد التعامل معه. استخدم <strong>تحديد الكل</strong> لاختيار كل ما في الصفحة.',
        },
        {
          html: 'يظهر شريط ثابت في الأسفل فيه أزرار <strong>اعتماد N</strong> و <strong>رفض N</strong>.',
        },
        {
          html: '<strong>الموافقة الجماعية</strong> تشغّل كل واحدة في معاملة منفصلة. إذا فشل بعضها (تحريرات متزامنة، حقول ناقصة)، تستمر الباقية. ترى قائمة بما يحتاج انتباهًا.',
        },
        {
          html: '<strong>الرفض الجماعي</strong> يرسل نفس الفئة والسبب لكل تحرير محدد. استخدمها فقط إذا كانت المشكلة واحدة في كلها.',
        },
      ],
      callouts: [
        {
          kind: 'tip',
          title: 'متى لا تستخدم الموافقة الجماعية',
          body: 'إذا بدا تحرير واحد مشكوكًا فيه، افتحه وراجعه فرديًا. الموافقة الجماعية للسرعة والثقة، ليست لتفويت الفحص.',
        },
      ],
    },
    {
      number: 6,
      title: 'فئات الرفض — متى تستخدم أي منها',
      table: {
        headers: ['الفئة', 'استخدمها عندما...'],
        rows: [
          [
            '<strong>صورة سيئة</strong>',
            'الصورة مشوّشة، التقطت من بعيد، أو لا تظهر ما يجب أن تظهره (مثلًا: صورة سجل تجاري والكتابة غير مقروءة).',
          ],
          [
            '<strong>GPS خطأ</strong>',
            'إحداثيات GPS تشير إلى مكان خاطئ — مثلاً المندوب التقط GPS في المكتب بدل المحل.',
          ],
          ['<strong>حقل ناقص</strong>', 'حقل إلزامي فارغ أو يحتوي على نص توضيحي.'],
          [
            '<strong>معلومة خاطئة</strong>',
            'الحقل فيه بيانات لا تطابق الصورة أو ما نعرفه عن المحل.',
          ],
          ['<strong>أخرى</strong>', 'أي شيء آخر — اكتب سببًا واضحًا.'],
        ],
      },
    },
    {
      number: 7,
      title: 'مواقف شائعة',
      table: {
        headers: ['الرسالة التي تراها', 'معناها'],
        rows: [
          [
            '"تم اتخاذ قرار في هذا التحرير من قبل مراجع آخر"',
            'مشرف آخر أو مدير اعتمد/رفض قبلك. أعد تحميل القائمة.',
          ],
          [
            '"هذه القيمة تتعارض مع سجل موجود"',
            'مندوبان أرسلا نفس رقم الهاتف أو السجل التجاري. ارفض أحدهما واطلب التحقق.',
          ],
          [
            '"الحقول الإلزامية ناقصة الآن"',
            'المندوب حذف حقلاً إلزاميًا (مثل صورة السجل التجاري) بين الإرسال واعتمادك. ارفض — يحتاج إعادة الرفع في المحل.',
          ],
          [
            '"غير مخوّل بالتصرف في هذا التحرير"',
            'العميل لم يعد ضمن صلاحية فريقك (تغيير خط، دمج عميل). أعد توجيهه إلى مديرك.',
          ],
        ],
      },
    },
  ],
  ref: {
    title: '8. بطاقة مرجعية سريعة',
    tables: [
      {
        title: 'الأزرار',
        rows: [
          ['<strong>✓ موافقة</strong>', 'تطبيق التغيير على السجل الرئيسي.'],
          ['<strong>✗ رفض</strong>', 'إعادة إلى المندوب مع فئة وسبب.'],
          ['<strong>فتح الملف</strong>', 'عرض بيانات العميل الكاملة.'],
          ['<strong>اعتماد N</strong> (الشريط الثابت)', 'موافقة جماعية على كل المحدد.'],
          ['<strong>رفض N</strong> (الشريط الثابت)', 'رفض جماعي لكل المحدد.'],
        ],
      },
      {
        title: 'الترتيب حسب العمر',
        rows: [
          ['<strong>وسم أخضر</strong> (أقل من 24 ساعة)', 'الأحدث. راجع عندما يمكنك.'],
          ['<strong>وسم كهرماني</strong> (1-3 أيام)', 'يكبر. اهدف لتنظيفها اليوم.'],
          ['<strong>وسم أحمر</strong> (أكثر من 3 أيام)', 'متأخر — نظّفها أول كل صباح.'],
        ],
      },
    ],
  },
  footer: 'NMWC نظام بيانات العملاء · دليل المشرف · الإصدار 1.0 · 2026-05-10',
};

const MANAGER_AR: Guide = {
  role: 'manager',
  lang: 'ar',
  rolePill: 'للمديرين',
  brandLine: 'نظام بيانات العملاء — تطبيق المنطقة',
  coverTitle: 'دليل المدير',
  coverSubtitle: 'NMWC نظام إدارة بيانات العملاء · الإصدار 1.1 · 2026-09',
  filename: 'NMWC-Manager-Guide-AR',
  welcome: {
    heading: 'مرحبًا',
    body: 'أنت تملك السجل الرئيسي للعملاء في منطقتك. مندوبوك يتبعون لك مباشرةً، فكل تحديث يرسلونه يصل إليك للاعتماد؛ كما تعتمد إعادة تفعيل المحلات المغلقة، وتدير صلاحيات فريقك (كلمات المرور، تعيين الخطوط)، وتراقب جودة البيانات، وتستطيع تنزيل تقرير يبيّن بالضبط ما غيّره الفريق الميداني. هذا الدليل يغطي كل ما يخص دورك.',
  },
  sections: [
    {
      number: 1,
      title: 'تسجيل الدخول',
      steps: [
        { html: 'افتح <strong>https://nmwc-cm.vercel.app</strong>.', img: '01-login.png' },
        { html: 'سجّل الدخول ببيانات اعتماد المدير.' },
      ],
    },
    {
      number: 2,
      title: 'الفحص اليومي للوحة المعلومات',
      steps: [
        {
          html: 'اضغط على <strong>لوحة المعلومات</strong> في القائمة.',
          img: '10-manager-dashboard.png',
        },
        {
          html: 'ترى مجاميع منطقتك: العملاء النشطون، الموافقات المعلّقة، طلبات إعادة التفعيل، النشاط الأخير.',
        },
        { html: 'استخدمها كفحص صباحي مدته 30 ثانية قبل أن تفتح أي شيء آخر.' },
      ],
    },
    {
      number: 3,
      title: 'اعتماد تحديثات مندوبيك',
      intro:
        'منذ الإطلاق (سبتمبر 2026) لا يوجد حسابات مشرفين: كل تحديث يرسله مندوب لعميل في منطقتك يصل إليك أنت.',
      steps: [
        {
          html: 'اضغط على <strong>الموافقات</strong> في القائمة. ترى كل الطلبات المعلّقة من مندوبي منطقتك، الأقدم أولًا، مع عدد الحقول المتغيرة ومن أرسلها ومنذ متى.',
          img: '08-supervisor-approvals-queue.png',
        },
        {
          html: 'اضغط على أي صف. ترى مقارنة <strong>قبل / بعد</strong> لكل حقل تغيّر (أسماء القنوات وليس رموزًا).',
          img: '09-supervisor-approval-diff.png',
        },
        {
          html: 'أسفل المقارنة قسم <strong>الصور والموقع المسجّلان حاليًا</strong>: صورة السجل التجاري، واجهة المحل، اللوحة، وأي صور إضافية — اضغط على أي صورة لفتحها بالحجم الكامل — ورابط <strong>فتح في خرائط جوجل</strong> للموقع المسجّل وللموقع المقترح إذا تغيّر.',
        },
        {
          html: 'اضغط <strong>✓ اعتماد</strong> (يطلب تأكيدًا) فيصبح التغيير فعّالًا في السجل فورًا، أو <strong>✗ رفض</strong> مع الفئة والسبب — يراه المندوب تحت <em>يحتاج تصحيحًا</em> ويعيد الإرسال بعد الإصلاح.',
        },
      ],
      callouts: [
        {
          kind: 'warn',
          title: 'تحقق من الموقع والصور معًا',
          body: 'قارن الدبوس على الخريطة بعنوان المحل وصورة الواجهة. الموقع المُدخل يدويًا يظهر بعلامة <strong>يدوي</strong> مع سبب المندوب — تأكد أنه معقول قبل الاعتماد.',
        },
        {
          kind: 'danger',
          title: 'لا تعتمد عملك أنت',
          body: 'النظام يمنعك من اعتماد أي طلب أرسلته بنفسك. اطلب من مدير زميل.',
        },
      ],
    },
    {
      number: 4,
      title: 'تقرير التحديثات الميدانية (إكسل) — ما عُدّل وما لم يُعدّل',
      steps: [
        {
          html: 'اضغط على <strong>تصدير</strong> في القائمة. في مربع <strong>تقرير التحديثات الميدانية</strong> اختر الفترة (من / إلى) واضغط <strong>تنزيل تقرير التحديثات الميدانية</strong>. اختيارات المنطقة والخط في الأعلى تنطبق عليه أيضًا.',
        },
        {
          html: 'الورقة <strong>Customers</strong>: كل عملاء منطقتك، صف لكل فرع. كل خلية غيّرها مندوب واعتمدتها خلال الفترة ملوّنة <strong>بالأصفر</strong> — مرّر الفأرة فوقها لترى القيمة السابقة ومن غيّرها ومتى. الخلايا <strong>البرتقالية</strong> تحمل اقتراحًا لم يُعتمد بعد (الخلية تعرض القيمة الحالية). الخلايا غير الملوّنة لم تُلمس.',
        },
        {
          html: 'الورقة <strong>Changes</strong>: صف لكل تغيير (قبل ← بعد، من أرسل، من اعتمد، متى). الورقة <strong>By salesman</strong>: مجاميع كل مندوب — عملاء محدّثون، حقول متغيرة، صور مضافة، مواقع ملتقطة، ما زال معلّقًا.',
        },
        { html: 'اختر <strong>العملاء الذين لديهم تغييرات فقط</strong> لحذف الصفوف غير المتغيرة.' },
      ],
    },
    {
      number: 5,
      title: 'الموافقة على إعادة التفعيل أو رفضها',
      intro: 'إعادة التفعيل تعيد المحلات المغلقة إلى السجل النشط. المديرون فقط يستطيعون اعتمادها.',
      steps: [
        {
          html: 'اضغط على <strong>إعادة التفعيل</strong> في القائمة.',
          img: '11-manager-reactivations.png',
        },
        { html: 'ترى كل المحلات المغلقة التي طلب مندوبوك إعادة فتحها.' },
        { html: 'كل صف يظهر سبب المندوب والصورة التي التقطها اليوم في المحل.' },
        { html: 'اضغط على الصورة لرؤيتها بالحجم الكامل وتأكيد أن المحل مفتوح فعلًا.' },
        { html: 'اضغط <strong>✓ تفعيل</strong> إذا اقتنعت — الفرع يعود إلى نشط.' },
        { html: 'اضغط <strong>إبقاء مغلق</strong> للرفض. المندوب يرى قرارك.' },
      ],
      callouts: [
        {
          kind: 'warn',
          title: 'حداثة الصورة كدليل',
          body: 'يجب أن تكون الصورة قد التُقطت بعد إغلاق المحل. النظام يرفض الصور قبل الإغلاق تلقائيًا. إذا رأيت واحدة تسلّلت، ارفض إعادة التفعيل واطلب من المندوب إعادة التصوير.',
        },
      ],
    },
    {
      number: 6,
      title: 'إدارة فريقك',
      steps: [
        { html: 'اضغط على <strong>المستخدمون</strong> في القائمة.', img: '12-manager-users.png' },
        {
          html: 'ترى المستخدمين في منطقتك: المندوبون، المشرفون، أي شخص يتبع لك. تفتح القائمة على تبويب <strong>النشِطون</strong> — أي الحسابات القابلة للاستخدام. وبجانبه <strong>المعطَّلون</strong> و<strong>الكل</strong>، مع عدد ما يخفيه التبويب الحالي أسفل العنوان.',
        },
        {
          html: '<strong>إعادة ضبط كلمة المرور</strong> — لمندوب نسي كلمته. عيّن كلمة مؤقتة؛ النظام يجبره على تغييرها عند الدخول التالي.',
        },
        {
          html: '<strong>تعطيل</strong> — عندما يترك مندوب الشركة. لا يستطيع تسجيل الدخول. سجل أعماله يبقى في سجل التدقيق.',
        },
        {
          html: '<strong>إعادة تعيين الخط</strong> — إذا غيّر مندوب خطه. المالك الجديد يرى عملاءه فورًا.',
        },
      ],
    },
    {
      number: 7,
      title: 'الخطوط والمناطق',
      steps: [
        { html: 'اضغط على <strong>الخطوط والمناطق</strong> في القائمة.' },
        { html: 'أضف خطًا جديدًا، علّم خطًا كغير نشط، شاهد المندوب المالك لكل خط.' },
        { html: 'الخطوط تتبع المناطق؛ تستطيع إدارة الخطوط في المناطق المعينة لك فقط.' },
      ],
    },
    {
      number: 8,
      title: 'سجل التدقيق — عند التحقيق',
      intro: 'استخدم هذا عندما يبدو شيء غير معتاد أو يسأل قسم الموارد البشرية عن من فعل ماذا.',
      steps: [
        { html: 'اضغط على <strong>سجل التدقيق</strong> في القائمة.' },
        {
          html: 'كل عمل من كل مستخدم مسجل: تسجيل دخول، فشل دخول، إنشاء/تعديل عميل، موافقة، رفض، إعادة تفعيل، التقاط صورة، إعادة ضبط كلمة مرور، إلخ.',
        },
        {
          html: 'كل صف يظهر: من، متى، من أي IP، أي عمل، على أي سجل. القيم القديمة والجديدة أيضًا.',
        },
        { html: 'استخدم الفلترة بالمستخدم، نطاق التاريخ، نوع العمل، أو العميل لتضييق البحث.' },
      ],
      callouts: [
        {
          kind: 'info',
          title: 'سجلات التدقيق غير قابلة للتعديل',
          body: 'بعد كتابتها، لا أحد — حتى أنت، حتى أمين البيانات — يستطيع تحريرها أو حذفها. هذا تصميم متعمد. هذا هو السجل الموثوق لمنطقتك.',
        },
      ],
    },
    {
      number: 9,
      title: 'مواقف شائعة',
      table: {
        headers: ['الموقف', 'ما العمل'],
        rows: [
          [
            'مندوب يقول "زر الإرسال رمادي"',
            'النموذج يعرض ما ينقص (صور، موقع، هاتف…). يستطيع حفظ مسودة وإكمالها في المحل. لا يصلك شيء قبل الإرسال.',
          ],
          [
            '"حقول مطلوبة ناقصة الآن في هذا العميل"',
            'صورة مطلوبة حُذفت بعد الإرسال. ارفض بفئة "حقل ناقص" ليعيد المندوب التقاطها ويرسل من جديد.',
          ],
          [
            '"الصورة التُقطت قبل آخر تغيير حالة"',
            'مندوب حاول استخدام صورة قديمة لإعادة التفعيل. ارفض — يحتاج صورة جديدة في المحل اليوم.',
          ],
          [
            '"فريقي لا يستطيع تسجيل الدخول"',
            'تحقق من سجل التدقيق لإدخالات "فشل دخول". عادةً كلمة مرور خاطئة (النظام يقفل دقيقة بعد 5 محاولات خاطئة).',
          ],
          ['"لا يمكنك اعتماد طلبك"', 'أنت أرسلت الطلب أصلًا. أعد توجيهه إلى مدير زميل.'],
          ['"لا توجد مناطق معينة لك"', 'حسابك لم يُعيَّن منطقة بعد. اتصل بالمكتب الرئيسي.'],
          [
            'مندوب انتقل إلى خط آخر',
            'استخدم صفحة المستخدمون → إعادة تعيين خط. العملاء الجدد ظاهرون فورًا.',
          ],
          ['مندوب ترك الشركة', 'علّمه كمعطّل في صفحة المستخدمون. سجل تدقيقه محفوظ.'],
        ],
      },
    },
  ],
  ref: {
    title: '10. بطاقة مرجعية سريعة',
    tables: [
      {
        title: 'إجراءات للمدير فقط',
        rows: [
          ['<strong>✓ اعتماد / ✗ رفض</strong>', 'البتّ في تحديث أرسله مندوب (الموافقات).'],
          ['<strong>✓ تفعيل</strong>', 'إعادة محل مغلق إلى نشط.'],
          ['<strong>إبقاء مغلق</strong>', 'رفض طلب إعادة تفعيل.'],
          ['<strong>إعادة ضبط كلمة المرور</strong>', 'توليد كلمة مرور مؤقتة لعضو في الفريق.'],
          ['<strong>تعطيل مستخدم</strong>', 'منع شخص ترك الشركة من تسجيل الدخول.'],
          ['<strong>إعادة تعيين خط</strong>', 'نقل خط إلى مندوب آخر.'],
          ['<strong>تجاوز إجباري</strong>', 'تحرير السجل مباشرةً. استخدمه باعتدال — يُسجَّل.'],
        ],
      },
      {
        title: 'أين تنظر',
        rows: [
          ['<strong>لوحة المعلومات</strong>', 'الفحص اليومي الصباحي. مجاميع المنطقة.'],
          ['<strong>إعادة التفعيل</strong>', 'محلات مغلقة تطلب الفتح.'],
          ['<strong>المستخدمون</strong>', 'فريقك. كلمات المرور، الحالة، ملكية الخط.'],
          ['<strong>سجل التدقيق</strong>', 'كل عمل في منطقتك على الإطلاق.'],
          ['<strong>الموافقات</strong>', 'تحديثات مندوبيك المعلّقة — راجعها مع الصور والخريطة، ثم اعتمد أو ارفض.'],
          ['<strong>تصدير</strong>', 'ملف إكسل للسجل الرئيسي وتقرير التحديثات الميدانية (التغييرات ملوّنة).'],
        ],
      },
    ],
  },
  footer: 'NMWC نظام بيانات العملاء · دليل المدير · الإصدار 1.1 · 2026-09-10',
};

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

const ALL_GUIDES: Guide[] = [
  SALESMAN_EN,
  SALESMAN_AR,
  SUPERVISOR_EN,
  SUPERVISOR_AR,
  MANAGER_EN,
  MANAGER_AR,
  STEWARD_EN,
];

async function main() {
  const outDir = resolve('docs/guide');
  await mkdir(outDir, { recursive: true });

  console.log('Writing HTML files…');
  for (const g of ALL_GUIDES) {
    const html = renderHtml(g);
    const path = resolve(outDir, `${g.filename}.html`);
    await writeFile(path, html, 'utf8');
    console.log(`  → ${path}`);
  }

  console.log('\nRendering PDFs…');
  // GUIDE_CHROMIUM lets a machine with a different Playwright browser build render
  // the PDFs without re-downloading browsers.
  const browser = await chromium.launch(
    process.env.GUIDE_CHROMIUM ? { executablePath: process.env.GUIDE_CHROMIUM } : {}
  );
  const ctx = await browser.newContext();
  for (const g of ALL_GUIDES) {
    const page = await ctx.newPage();
    const htmlPath = resolve(outDir, `${g.filename}.html`);
    const pdfPath = resolve(outDir, `${g.filename}.pdf`);
    await page.goto(`file://${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="font-size:8pt;color:#94a3b8;width:100%;text-align:center;padding:0 12mm;direction:ltr;">' +
        'NMWC · ' +
        g.filename +
        ' · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    await page.close();
    console.log(`  → ${pdfPath}`);
  }
  await browser.close();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
