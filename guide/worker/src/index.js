// Dead man's switch heartbeat for yourdomain.com.
//
// - Daily cron: if the last confirmation is older than REMIND_AFTER_DAYS, email
//   the owner a signed one-time link (then again every REMIND_EVERY_DAYS).
// - GET /alive?t=TOKEN: the link target. Records the confirmation and shows a
//   page with the next email date and the release date.
// - GET /status  (header X-Status-Key): JSON for the GitHub watchdog.
// - POST /checkin (header X-Status-Key): confirmation from the GitHub workflow.
// - POST /send   (header X-Status-Key): send a reminder right now (testing).

import { EmailMessage } from "cloudflare:email";

const DAY = 86_400_000;
const STATE_KEY = "state";

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/alive" && req.method === "GET") return handleAlive(url, env);
    if (path === "/") return html(landing(), 200);

    // Friends manager (owner only; key travels in the URL and is emailed to the owner on request)
    if (path === "/friends" && req.method === "GET") return html(friendsFront(env, url), 200);
    if (path === "/friends/link" && req.method === "POST") return friendsSendLink(env);
    if (path.startsWith("/friends/")) return friendsAdmin(req, url, path, env);

    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
    if (path === "/status" && req.method === "GET") return json(await status(env));
    if (path === "/notify" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      return json(await notifyFriends(env, body));
    }
    if (path === "/checkin" && req.method === "POST") {
      const s = await setCheckin(env, "github-workflow");
      return json(await status(env, s));
    }
    if (path === "/send" && req.method === "POST") {
      const s = await getState(env);
      await sendReminder(env, s, Date.now(), true);
      return json({ sent: true, ...(await status(env)) });
    }
    return json({ error: "not found" }, 404);
  },
};

// ---------- state ----------

async function getState(env) {
  const raw = await env.STATE.get(STATE_KEY);
  if (raw) return JSON.parse(raw);
  // First run: treat deploy time as a confirmation so the clock starts now.
  const s = { lastCheckin: Date.now(), lastEmail: null, nonce: null, usedNonce: null, source: "deploy", count: 0 };
  await env.STATE.put(STATE_KEY, JSON.stringify(s));
  return s;
}

async function putState(env, s) {
  await env.STATE.put(STATE_KEY, JSON.stringify(s));
  return s;
}

async function setCheckin(env, source) {
  const s = await getState(env);
  s.lastCheckin = Date.now();
  s.lastEmail = null;          // reminder cadence restarts from this confirmation
  s.usedNonce = s.nonce;       // the link that was clicked keeps showing the confirmation page
  s.nonce = null;              // no other outstanding link is valid
  s.source = source;
  s.count = (s.count || 0) + 1;
  return putState(env, s);
}

function cfg(env) {
  return {
    remindAfter: Number(env.REMIND_AFTER_DAYS),
    remindEvery: Number(env.REMIND_EVERY_DAYS),
    releaseDays: Number(env.RELEASE_DAYS),
  };
}

function schedule(env, s, now = Date.now()) {
  const { remindAfter, remindEvery, releaseDays } = cfg(env);
  const days = (now - s.lastCheckin) / DAY;
  const releaseOn = s.lastCheckin + releaseDays * DAY;
  let nextEmail = s.lastCheckin + remindAfter * DAY;
  if (s.lastEmail) nextEmail = s.lastEmail + remindEvery * DAY;
  if (nextEmail >= releaseOn) nextEmail = null;
  return { days, releaseOn, nextEmail };
}

async function status(env, s) {
  s = s || (await getState(env));
  const { days, releaseOn, nextEmail } = schedule(env, s);
  return {
    last_checkin: new Date(s.lastCheckin).toISOString(),
    last_checkin_date: new Date(s.lastCheckin).toISOString().slice(0, 10),
    days_since_checkin: Math.floor(days),
    next_email: nextEmail ? new Date(nextEmail).toISOString() : null,
    release_on: new Date(releaseOn).toISOString(),
    release_days: cfg(env).releaseDays,
    last_email: s.lastEmail ? new Date(s.lastEmail).toISOString() : null,
    source: s.source,
    confirmations: s.count || 0,
  };
}

// ---------- cron ----------

async function tick(env) {
  const s = await getState(env);
  const now = Date.now();
  const { remindAfter, remindEvery, releaseDays } = cfg(env);
  const days = (now - s.lastCheckin) / DAY;
  if (days >= releaseDays) return;              // past the deadline: GitHub watchdog handles release
  if (days < remindAfter) return;               // not time yet
  const sinceEmail = s.lastEmail ? (now - s.lastEmail) / DAY : Infinity;
  if (sinceEmail < remindEvery) return;         // already nagged recently
  await sendReminder(env, s, now, false);
}

// ---------- email ----------

async function sendReminder(env, s, now, isTest) {
  const nonce = randomHex(16);
  const token = `${nonce}.${await hmac(env.TOKEN_SECRET, nonce)}`;
  const link = `${env.SITE_URL}/alive?t=${token}`;
  const { releaseOn } = schedule(env, s, now);
  const daysLeft = Math.max(0, Math.ceil((releaseOn - now) / DAY));
  const when = fmt(releaseOn, env.TIMEZONE);
  const sentOn = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: env.TIMEZONE }).format(new Date(now));

  const releaseShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: env.TIMEZONE }).format(new Date(releaseOn));
  const subject = isTest
    ? `TEST: confirm you are still with us (release ${releaseShort})`
    : `Still with us? Confirm before ${releaseShort}`;

  const text = [
    `This is your yourdomain.com check-in.`,
    ``,
    `Open this link to confirm you are alive:`,
    link,
    ``,
    `If nobody confirms, the contents are published on or shortly after ${when}.`,
    ``,
    `The link works once. Each reminder sends a fresh one.`,
  ].join("\n");

  const mono = "font-family:ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";
  const body = `
<!doctype html><html><body style="margin:0;padding:32px 12px;background:#0b0d0b;color:#d6e0d6;${mono};font-size:14px;line-height:1.7">
<div style="max-width:620px;margin:0 auto;background:#111411;border:1px solid #2a302a;border-radius:10px;overflow:hidden">
  <div style="background:#1a1e1a;border-bottom:1px solid #2a302a;padding:9px 14px;color:#6f7a6f;font-size:12px">
    <span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:#ff5f57"></span>&nbsp;<span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:#febc2e"></span>&nbsp;<span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:#28c840"></span>
    &nbsp;&nbsp; you@yourdomain: ~/alive${isTest ? " &nbsp;[TEST]" : ""}
  </div>
  <div style="padding:20px 22px 24px">
    <div style="color:#f3c969;font-size:11px;letter-spacing:.2em;text-transform:uppercase">// alive &middot; check-in due</div>
    <div style="color:#fff;font-size:24px;font-weight:bold;line-height:1.2;margin:6px 0 18px">Still with us?</div>
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:separate;border-spacing:0 0"><tr>
      <td style="width:50%;padding:0 7px 0 0"><div style="border:1px solid #223027;background:#0a0e0c;border-radius:8px;padding:12px 14px;text-align:center"><div style="font-size:36px;line-height:1;color:#f3c969;font-weight:bold">${daysLeft}</div><div style="color:#7f8a7f;font-size:11px;margin-top:6px">days to release, as of ${esc(sentOn)}</div><div style="color:#f3c969;font-size:13px;font-weight:bold;margin-top:8px">${esc(when)}</div></div></td>
      <td style="width:50%;padding:0 0 0 7px"><div style="border:1px solid #223027;background:#0a0e0c;border-radius:8px;padding:12px 14px;text-align:center"><div style="font-size:36px;line-height:1;color:#5af78e;font-weight:bold">1</div><div style="color:#7f8a7f;font-size:11px;margin-top:6px">tap to reset the clock</div><div style="color:#aab5aa;font-size:12px;margin-top:8px">link works once</div></div></td>
    </tr></table>
    <div style="margin:20px 0 0"><a href="${link}" style="display:block;text-align:center;background:#5af78e;color:#07090a;text-decoration:none;font-weight:bold;${mono};font-size:16px;padding:14px 22px;border-radius:8px">I'm alive</a></div>
    <div style="color:#6f7a6f;font-size:11.5px;margin-top:16px"># each reminder sends a fresh link. if the button fails, open:</div>
    <div style="color:#6f7a6f;font-size:11.5px;word-break:break-all">${link}</div>
  </div>
</div></body></html>`;

  const msgId = `<${randomHex(12)}@${env.FROM_EMAIL.split("@")[1]}>`;
  const boundary = `b${randomHex(12)}`;
  const raw = [
    `From: ${env.FROM_NAME} <${env.FROM_EMAIL}>`,
    `To: ${env.OWNER_EMAIL}`,
    `Subject: ${subject}`,
    `Message-ID: ${msgId}`,
    `Date: ${new Date(now).toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    text,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    body,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");

  await env.EMAIL.send(new EmailMessage(env.FROM_EMAIL, env.OWNER_EMAIL, raw));

  s.nonce = nonce;
  s.lastEmail = now;
  await putState(env, s);
}

// ---------- the click ----------

async function handleAlive(url, env) {
  const t = url.searchParams.get("t") || "";
  const [nonce, sig] = t.split(".");
  const s = await getState(env);
  if (!nonce || !sig || sig !== (await hmac(env.TOKEN_SECRET, nonce))) {
    return html(page({ title: "alive: invalid link", tag: "// alive · rejected", warn: true,
      h1: "That link is not valid.",
      msg: "It is damaged or was not issued by this service. Wait for the next reminder email, or confirm from GitHub." }), 400);
  }
  if (nonce === s.usedNonce) return html(confirmation(env, s, true), 200);
  if (nonce !== s.nonce) {
    return html(page({ title: "alive: stale link", tag: "// alive · stale", warn: true,
      h1: "A newer link replaced this one.",
      msg: `Use the most recent reminder email. Last confirmation on record: ${fmt(s.lastCheckin, env.TIMEZONE)}.` }), 410);
  }
  const updated = await setCheckin(env, "email-link");
  return html(confirmation(env, updated, false), 200);
}

function confirmation(env, s, repeat) {
  const { releaseOn, nextEmail } = schedule(env, s);
  const now = Date.now();
  const { releaseDays } = cfg(env);
  const used = Math.min(releaseDays, Math.max(0, (now - s.lastCheckin) / DAY));
  const pct = Math.max(1.5, (used / releaseDays) * 100);
  return page({
    title: repeat ? "alive: already confirmed" : "alive: confirmed",
    tag: repeat ? "// alive · already confirmed" : "// alive · confirmed",
    h1: repeat ? "Already confirmed. Clock was reset." : "You're alive. Clock reset.",
    counters: [
      { n: nextEmail ? wholeDays(nextEmail, now) : "—", label: "days to next reminder", sub: nextEmail ? fmt(nextEmail, env.TIMEZONE) : "none before release" },
      { n: wholeDays(releaseOn, now), label: "days to release if silent", sub: fmt(releaseOn, env.TIMEZONE), warn: true },
    ],
    bar: { pct, left: `confirmed ${fmt(s.lastCheckin, env.TIMEZONE)}`, right: `release · ${releaseDays} days` },
    foot: repeat
      ? "# this link was already used. confirming again at any time pushes both dates out."
      : "# confirming again at any time pushes both dates out.",
  });
}

function wholeDays(ts, now) {
  return Math.max(0, Math.ceil((ts - now) / DAY));
}

// ---------- friends: who gets told when the switch fires ----------
//
// Friends are stored in KV ("friends": [{email, name, added}]). Adding one also
// creates a Cloudflare Email Routing destination address through the API, which
// makes Cloudflare send that person a one-time "verify your email" message. Only
// verified addresses can be emailed, so /notify checks verification at send time.

const FRIENDS_KEY = "friends";
const LETTER_KEY = "letter";
const LINK_COOLDOWN_KEY = "friends-link-sent";
const DEFAULT_LETTER = {
  subject: "A message from me",
  text: "Hi,\n\nIf you're reading this, I haven't checked in for a long time and an automatic process I set up has published some things I wanted you to have.\n\nThey're here:\n\n{site}\n\nPlease take a look when you can. Thank you for being one of the people I trusted with this.\n\nYour Name",
};

async function getLetter(env) {
  const raw = await env.STATE.get(LETTER_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function getFriends(env) {
  return JSON.parse((await env.STATE.get(FRIENDS_KEY)) || "[]");
}
async function putFriends(env, list) {
  await env.STATE.put(FRIENDS_KEY, JSON.stringify(list));
}

function cfApi(env, method, pathname, body) {
  if (!env.CF_API_TOKEN) throw new Error("CF_API_TOKEN secret is not set");
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || `Cloudflare API ${r.status}`);
    return j.result;
  });
}

// Map of lowercase email -> { verified: bool, id }
async function cfAddresses(env) {
  const out = {};
  for (let page = 1; page < 20; page++) {
    const list = await cfApi(env, "GET", `/email/routing/addresses?per_page=50&page=${page}`);
    for (const a of list || []) out[a.email.toLowerCase()] = { verified: !!a.verified, id: a.id };
    if (!list || list.length < 50) break;
  }
  return out;
}

function adminOk(env, url, form) {
  const k = url.searchParams.get("k") || (form && form.get("k")) || "";
  return env.ADMIN_KEY && k.length > 0 && k === env.ADMIN_KEY;
}

async function friendsAdmin(req, url, path, env) {
  const form = req.method === "POST" ? await req.formData().catch(() => null) : null;
  if (!adminOk(env, url, form)) return html(plainPage("Not authorized", `<p>This page needs the manager link. <a href="/friends">Request it</a>.</p>`), 401);
  const k = env.ADMIN_KEY;

  if (path === "/friends/manage" && req.method === "GET") {
    const friends = await getFriends(env);
    let addrs = {}, apiErr = "";
    try { addrs = await cfAddresses(env); } catch (e) { apiErr = String(e.message || e); }
    const notice = url.searchParams.get("m") || "";
    const letter = (await getLetter(env)) || DEFAULT_LETTER;
    return html(friendsManagePage(env, k, friends, addrs, apiErr, notice, letter), 200);
  }

  if (path === "/friends/letter" && form) {
    const subject = String(form.get("subject") || "").trim();
    const text = String(form.get("text") || "").replace(/\r\n/g, "\n").trim();
    if (!subject || !text) return redirectManage(k, "The letter needs both a subject and a message.");
    await env.STATE.put(LETTER_KEY, JSON.stringify({ subject, text, updated: new Date().toISOString() }));
    return redirectManage(k, "Letter saved. This is what friends will receive.");
  }

  if (path === "/friends/add" && form) {
    const email = String(form.get("email") || "").trim().toLowerCase();
    const name = String(form.get("name") || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return redirectManage(k, "That doesn't look like an email address.");
    try {
      await cfApi(env, "POST", "/email/routing/addresses", { email });
    } catch (e) {
      if (!/already|exists|duplicate/i.test(String(e.message))) return redirectManage(k, `Cloudflare refused: ${e.message}`);
    }
    const friends = await getFriends(env);
    if (!friends.some((f) => f.email === email)) friends.push({ email, name, added: new Date().toISOString() });
    else if (name) friends.find((f) => f.email === email).name = name;
    await putFriends(env, friends);
    return redirectManage(k, `Added ${email}. Cloudflare has emailed them a verification link.`);
  }

  if (path === "/friends/remove" && form) {
    const email = String(form.get("email") || "").trim().toLowerCase();
    const friends = (await getFriends(env)).filter((f) => f.email !== email);
    await putFriends(env, friends);
    try {
      const addrs = await cfAddresses(env);
      if (addrs[email]) await cfApi(env, "DELETE", `/email/routing/addresses/${addrs[email].id}`);
    } catch (_) { /* keep going; KV is the source of who gets the letter */ }
    return redirectManage(k, `Removed ${email}.`);
  }

  if (path === "/friends/reverify" && form) {
    const email = String(form.get("email") || "").trim().toLowerCase();
    try {
      const addrs = await cfAddresses(env);
      if (addrs[email]) await cfApi(env, "DELETE", `/email/routing/addresses/${addrs[email].id}`);
      await cfApi(env, "POST", "/email/routing/addresses", { email });
    } catch (e) { return redirectManage(k, `Could not resend: ${e.message}`); }
    return redirectManage(k, `Verification email resent to ${email}.`);
  }

  if (path === "/friends/test-letter" && form) {
    const r = await notifyFriends(env, { test: true });
    return redirectManage(k, r.sent ? `Test letter sent to ${env.OWNER_EMAIL}.` : `Test failed: ${JSON.stringify(r.results)}`);
  }

  return json({ error: "not found" }, 404);
}

function redirectManage(k, m) {
  return new Response(null, { status: 303, headers: { location: `/friends/manage?k=${encodeURIComponent(k)}&m=${encodeURIComponent(m)}` } });
}

function friendsFront(env, url) {
  const m = url.searchParams.get("m") || "";
  return plainPage("Friends list", `
    <p>This is where ${esc(env.FROM_NAME)} keeps the list of people to notify. Only the owner can open it.</p>
    <form method="post" action="/friends/link"><button>Email me the manager link</button></form>
    ${m ? `<p class="note">${esc(m)}</p>` : ""}`);
}

async function friendsSendLink(env) {
  const last = Number((await env.STATE.get(LINK_COOLDOWN_KEY)) || 0);
  if (Date.now() - last < 10 * 60 * 1000) {
    return new Response(null, { status: 303, headers: { location: "/friends?m=" + encodeURIComponent("A link was sent recently. Check your inbox, or try again in 10 minutes.") } });
  }
  if (!env.ADMIN_KEY) return html(plainPage("Not configured", "<p>ADMIN_KEY is not set on the Worker.</p>"), 500);
  const link = `${env.SITE_URL}/friends/manage?k=${encodeURIComponent(env.ADMIN_KEY)}`;
  await sendMail(env, env.OWNER_EMAIL, "Your friends-list manager link",
    `Open this link to manage who gets notified when the switch fires:\n\n${link}\n\nBookmark it. Anyone with this link can edit the list, so keep it to yourself.`,
    plainPage("Friends-list manager", `<p>Open this link to manage who gets notified when the switch fires:</p><p><a href="${link}">${link}</a></p><p class="note">Bookmark it. Anyone with this link can edit the list, so keep it to yourself.</p>`));
  await env.STATE.put(LINK_COOLDOWN_KEY, String(Date.now()));
  return new Response(null, { status: 303, headers: { location: "/friends?m=" + encodeURIComponent(`Sent to ${env.OWNER_EMAIL}.`) } });
}

function friendsManagePage(env, k, friends, addrs, apiErr, notice, letter) {
  const rows = friends.length ? friends.map((f) => {
    const a = addrs[f.email];
    const st = apiErr ? `<span class="dim">unknown</span>` : a ? (a.verified ? `<span class="ok">verified</span>` : `<span class="warn">waiting for them to click</span>`) : `<span class="warn">not registered</span>`;
    return `<tr><td>${esc(f.name || "")}</td><td>${esc(f.email)}</td><td>${st}</td><td class="acts">
      ${a && a.verified ? "" : `<form method="post" action="/friends/reverify"><input type="hidden" name="k" value="${esc(k)}"><input type="hidden" name="email" value="${esc(f.email)}"><button>resend verification</button></form>`}
      <form method="post" action="/friends/remove" onsubmit="return confirm('Remove ${esc(f.email)}?')"><input type="hidden" name="k" value="${esc(k)}"><input type="hidden" name="email" value="${esc(f.email)}"><button class="danger">remove</button></form>
    </td></tr>`;
  }).join("") : `<tr><td colspan="4" class="dim">No friends yet.</td></tr>`;
  const verified = friends.filter((f) => addrs[f.email] && addrs[f.email].verified).length;
  return plainPage("Who gets notified", `
    ${notice ? `<p class="note">${esc(notice)}</p>` : ""}
    ${apiErr ? `<p class="note warn">Cannot read verification status: ${esc(apiErr)}</p>` : ""}
    <p>When the switch fires, the letter goes to every <b>verified</b> person below, and a copy to ${esc(env.OWNER_EMAIL)}. ${friends.length} listed, ${verified} verified.</p>
    <table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <h2>Add a friend</h2>
    <form method="post" action="/friends/add" class="row"><input type="hidden" name="k" value="${esc(k)}">
      <input name="name" placeholder="Name (optional)"><input name="email" type="email" placeholder="email@example.com" required><button>Add</button></form>
    <p class="dim">They'll get a one-time "verify your email address" message from Cloudflare. Once they click it, they show as verified here. Nothing else is sent to them until the switch fires.</p>
    <h2>The letter friends receive</h2>
    <p class="dim">Sent to every verified friend (and you) when the switch fires. <code>{site}</code> becomes ${esc(env.PUBLIC_SITE)}.${letter.updated ? ` Last saved ${esc(letter.updated.slice(0, 10))}.` : " Not saved yet; this is the default."}</p>
    <form method="post" action="/friends/letter"><input type="hidden" name="k" value="${esc(k)}">
      <label class="dim">Subject</label><input name="subject" value="${esc(letter.subject)}" style="width:100%" required>
      <label class="dim">Message</label><textarea name="text" rows="12" style="width:100%" required>${esc(letter.text)}</textarea>
      <div class="row" style="margin-top:8px"><button>Save letter</button></div></form>
    <form method="post" action="/friends/test-letter" style="margin-top:10px"><input type="hidden" name="k" value="${esc(k)}">
      <button>Email me a test of the saved letter</button></form>
    <h2>Preview <span id="pv-state" class="badge"></span></h2>
    <p class="dim">Updates as you type. This is what lands in a friend's inbox.</p>
    <div class="mail">
      <div class="mailhead">
        <div><span class="dim">From</span> ${esc(env.FROM_NAME)} &lt;${esc(env.FROM_EMAIL)}&gt;</div>
        <div><span class="dim">To</span> &lt;each verified friend&gt;</div>
        <div><span class="dim">Subject</span> <b id="pv-subject"></b></div>
      </div>
      <div class="mailbody" id="pv-body"></div>
    </div>
    <script>
    (function () {
      var site = ${JSON.stringify(env.PUBLIC_SITE)};
      var saved = { subject: ${JSON.stringify(letter.subject)}, text: ${JSON.stringify(letter.text)} };
      var subj = document.querySelector('input[name="subject"]'), text = document.querySelector('textarea[name="text"]');
      var pvS = document.getElementById("pv-subject"), pvB = document.getElementById("pv-body"), pvState = document.getElementById("pv-state");
      function esc(t) { return t.replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
      function render() {
        var sv = subj.value.trim(), tv = text.value.replace(/\\r\\n/g, "\\n").trim().replace(/\\{site\\}/g, site);
        pvS.textContent = sv || "(no subject)";
        pvB.innerHTML = tv ? tv.split(/\\n{2,}/).map(function (p) {
          return "<p>" + esc(p).replace(/\\n/g, "<br>").replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1">$1</a>') + "</p>";
        }).join("") : '<p class="dim">(empty message)</p>';
        var dirty = sv !== saved.subject || text.value.replace(/\\r\\n/g, "\\n").trim() !== saved.text;
        pvState.textContent = dirty ? "unsaved changes" : "matches what is saved";
        pvState.className = "badge " + (dirty ? "warn" : "ok");
      }
      subj.addEventListener("input", render); text.addEventListener("input", render); render();
    })();
    </script>`);
}

// Called by the GitHub watchdog at release (or in test mode). body: { subject, text, test }
async function notifyFriends(env, body) {
  const saved = await getLetter(env);
  const subject = (saved?.subject || body.subject || DEFAULT_LETTER.subject).trim();
  const text = (saved?.text || body.text || DEFAULT_LETTER.text).replace(/\{site\}/g, env.PUBLIC_SITE).trim();
  if (!text) return { sent: 0, failed: 0, results: [], error: "empty message" };
  const friends = await getFriends(env);
  let addrs = {}, apiErr = "";
  try { addrs = await cfAddresses(env); } catch (e) { apiErr = String(e.message || e); }
  const targets = body.test ? [] : friends.map((f) => f.email);
  const results = [];
  for (const to of targets) {
    const a = addrs[to];
    if (!apiErr && !(a && a.verified)) { results.push({ to, ok: false, error: "not verified" }); continue; }
    try { await sendMail(env, to, subject, text, letterHtml(env, subject, text)); results.push({ to, ok: true }); }
    catch (e) { results.push({ to, ok: false, error: String(e.message || e) }); }
  }
  const summary = results.length
    ? `\n\n---\nSent to: ${results.filter((r) => r.ok).map((r) => r.to).join(", ") || "nobody"}\nFailed: ${results.filter((r) => !r.ok).map((r) => `${r.to} (${r.error})`).join(", ") || "none"}`
    : (body.test ? "\n\n---\n(test: sent to you only)" : "\n\n---\nNo friends on the list.");
  try { await sendMail(env, env.OWNER_EMAIL, (body.test ? "TEST: " : "") + subject, text + summary, letterHtml(env, subject, text + summary)); }
  catch (e) { results.push({ to: env.OWNER_EMAIL, ok: false, error: String(e.message || e) }); }
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, api_error: apiErr || undefined, results };
}

function letterHtml(env, subject, text) {
  const paras = text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join("");
  return plainPage(subject, paras);
}

async function sendMail(env, to, subject, text, htmlBody) {
  const boundary = `b${randomHex(12)}`;
  const raw = [
    `From: ${env.FROM_NAME} <${env.FROM_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${randomHex(12)}@${env.FROM_EMAIL.split("@")[1]}>`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`, `Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: 8bit`, ``, text, ``,
    `--${boundary}`, `Content-Type: text/html; charset=utf-8`, `Content-Transfer-Encoding: 8bit`, ``, htmlBody, ``,
    `--${boundary}--`, ``,
  ].join("\r\n");
  await env.EMAIL.send(new EmailMessage(env.FROM_EMAIL, to, raw));
}

// Plain readable page/email body (no rain): used for the friends manager and the letter.
function plainPage(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
  body{margin:0;background:#f6f4ef;color:#1d1b17;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;padding:24px 12px}
  main{max-width:680px;margin:0 auto;background:#fff;border:1px solid #e3ded3;border-radius:10px;padding:28px}
  h1{font-size:24px;margin:0 0 14px}h2{font-size:17px;margin:26px 0 8px}
  table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #eee;vertical-align:middle}th{color:#6b665c;font-weight:normal}
  .acts{white-space:nowrap}.acts form{display:inline-block;margin:0 2px}
  button{font:inherit;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid #c9c2b4;background:#f3efe6;cursor:pointer}button.danger{color:#a3321e}
  input,textarea{font:inherit;padding:8px 10px;border:1px solid #c9c2b4;border-radius:6px;margin:4px 0}
  .row{display:flex;gap:8px;flex-wrap:wrap}.row input{flex:1;min-width:160px}
  label{display:block;margin-top:8px}code{background:#f3efe6;padding:1px 4px;border-radius:4px}
  .badge{font-size:12px;font-weight:normal;padding:2px 8px;border-radius:10px;background:#eee;vertical-align:middle}.badge.ok{background:#e3f4e8;color:#1d7a3c}.badge.warn{background:#fbf0d6;color:#9a6b00}
  .mail{border:1px solid #e3ded3;border-radius:8px;overflow:hidden;margin-top:6px}.mailhead{background:#f3efe6;padding:10px 14px;font-size:13px;line-height:1.7}.mailhead .dim{display:inline-block;width:62px}
  .mailbody{padding:18px 16px;background:#fff;font-size:15px}.mailbody p{margin:0 0 1em}.mailbody p:last-child{margin:0}
  .ok{color:#1d7a3c;font-weight:600}.warn{color:#9a6b00}.dim{color:#6b665c;font-size:14px}.note{background:#f3efe6;border-radius:6px;padding:10px 12px;font-size:14px}
  a{color:#b4472e}
</style></head><body><main><h1>${esc(title)}</h1>${inner}</main></body></html>`;
}

// ---------- helpers ----------

function authorized(req, env) {
  const k = req.headers.get("x-status-key") || "";
  return k.length > 0 && k === env.STATUS_KEY;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fmt(ts, tz) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: tz, timeZoneName: "short",
  }).format(new Date(ts));
}

function daysUntil(ts, now) {
  const d = (ts - now) / DAY;
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} hours`;
  const n = Math.round(d);
  return `${n} day${n === 1 ? "" : "s"}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function html(body, status) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

function landing() {
  return page({ title: "alive", tag: "// alive", h1: "Nothing to see here.", msg: "" });
}

// Countdown board layout. o = { title, tag, h1, warn?, msg?, counters?, bar?, foot? }
function page(o) {
  const counters = (o.counters || []).map((c) =>
    `<div class="n${c.warn ? " w" : ""}"><b>${esc(c.n)}</b><small>${esc(c.label)}</small><span>${esc(c.sub)}</span></div>`).join("");
  const bar = o.bar ? `<div class="bar"><i style="width:${Number(o.bar.pct).toFixed(1)}%"></i></div><div class="leg"><span>${esc(o.bar.left)}</span><span>${esc(o.bar.right)}</span></div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(o.title)}</title>
<style>
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; background:#07090a; color:#cfd8cf; font:15px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; display:flex; align-items:center; justify-content:center; padding:24px 16px; overflow:hidden; }
  #rain { position:fixed; inset:0; width:100%; height:100%; z-index:0; pointer-events:none; }
  .vig { position:fixed; inset:0; z-index:1; pointer-events:none; background:radial-gradient(ellipse at center, rgba(7,9,10,.15) 0%, rgba(7,9,10,.92) 75%); }
  .p { position:relative; z-index:2; width:100%; max-width:600px; }
  .tag { color:#5af78e; font-size:12px; letter-spacing:.2em; text-transform:uppercase; }
  .tag.w { color:#f3c969; }
  h1 { margin:6px 0 20px; font-size:clamp(24px, 5vw, 32px); line-height:1.2; font-weight:bold; color:#fff; letter-spacing:-.01em; }
  .msg { color:#aab5aa; font-size:14px; max-width:48ch; }
  .nums { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin:0 0 16px; }
  .n { border:1px solid #223027; background:rgba(10,14,12,.88); border-radius:8px; padding:14px 16px; text-align:center; }
  .n b { display:block; font-size:clamp(34px, 8vw, 44px); line-height:1; color:#5af78e; }
  .n.w b { color:#f3c969; }
  .n small { display:block; color:#7f8a7f; font-size:12px; margin-top:7px; }
  .n span { display:block; color:#aab5aa; font-size:12.5px; margin-top:9px; }
  .bar { height:10px; border:1px solid #2a3a2e; border-radius:6px; overflow:hidden; background:#0e1410; }
  .bar i { display:block; height:100%; background:linear-gradient(90deg, #5af78e, #9bffc0); box-shadow:0 0 12px #5af78e; }
  .leg { display:flex; justify-content:space-between; gap:12px; color:#6f7a6f; font-size:11.5px; margin-top:7px; }
  .ft { margin-top:18px; color:#6f7a6f; font-size:12.5px; }
  @media (max-width:420px) { .nums { grid-template-columns:1fr; } body { padding:16px 12px; } }
</style></head>
<body><canvas id="rain" aria-hidden="true"></canvas><div class="vig"></div>
<div class="p">
  <div class="tag${o.warn ? " w" : ""}">${esc(o.tag)}</div>
  <h1>${esc(o.h1)}</h1>
  ${o.msg ? `<p class="msg">${esc(o.msg)}</p>` : ""}
  ${counters ? `<div class="nums">${counters}</div>` : ""}
  ${bar}
  ${o.foot ? `<div class="ft">${esc(o.foot)}</div>` : ""}
</div>
<script>
(function () {
  var c = document.getElementById("rain");
  if (!c || !c.getContext) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) { c.remove(); return; }
  var ctx = c.getContext("2d");
  var chars = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789$#@%&*+-=<>";
  var S = 14, cols = 0, d = [], sp = [], dpr = Math.min(window.devicePixelRatio || 1, 2);
  function rs() {
    c.width = Math.floor(innerWidth * dpr); c.height = Math.floor(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(innerWidth / S); d = []; sp = [];
    for (var i = 0; i < cols; i++) { d[i] = Math.random() < 0.6 ? Math.random() * innerHeight / S : -1e9; sp[i] = 0.5 + Math.random(); }
    ctx.fillStyle = "#07090a"; ctx.fillRect(0, 0, innerWidth, innerHeight);
    ctx.font = S + "px ui-monospace, Menlo, Consolas, monospace";
  }
  addEventListener("resize", rs); rs();
  var last = 0;
  function f(t) {
    requestAnimationFrame(f);
    if (t - last < 55) return; last = t;
    ctx.fillStyle = "rgba(7,9,10,0.14)"; ctx.fillRect(0, 0, innerWidth, innerHeight);
    for (var i = 0; i < cols; i++) {
      if (d[i] < -1e8) { if (Math.random() < 0.002) d[i] = 0; continue; }
      var X = i * S, Y = d[i] * S;
      ctx.fillStyle = "#9fd8b0"; ctx.fillText(chars.charAt(Math.random() * chars.length | 0), X, Y);
      ctx.fillStyle = "rgba(90,247,142,0.35)"; ctx.fillText(chars.charAt(Math.random() * chars.length | 0), X, Y - S);
      d[i] += sp[i];
      if (Y > innerHeight && Math.random() > 0.97) { d[i] = 0; sp[i] = 0.5 + Math.random(); }
    }
  }
  requestAnimationFrame(f);
})();
</script>
</body></html>`;
}
