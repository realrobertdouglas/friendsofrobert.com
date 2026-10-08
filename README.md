# Build your own dead man's switch

This repo is the public face of [friendsofrobert.com](https://friendsofrobert.com).
Right now it's a placeholder. If its owner stops checking in for long enough,
an automated process publishes a set of files here and emails a list of
friends to say so. Nothing sensitive lives in this repo until that moment.

This guide explains how the whole thing is built so you can make your own.
It costs nothing to run. The working files are in the [`guide/`](guide/) folder.

## What it does

1. Every so often you get an email with one button: **I'm alive**.
2. Tapping it shows a page with the next reminder date and the release date.
3. If you never tap, and never confirm any other way, the switch fires: your
   prepared files go live on a public website and your friends get a letter
   telling them where to look.

## The pieces

```
 you ──tap──▶ Cloudflare Worker ◀──daily status check── GitHub Actions watchdog
               (alive.yourdomain)                          (private "vault" repo)
               stores last check-in                              │
               emails reminders                        on day N: copies vault/contents/
               manages friends list                    into the public site repo ──▶ GitHub Pages
               sends the friends letter                                              (yourdomain.com)
```

| Piece | Where | Job |
|---|---|---|
| Public site repo | GitHub, public | Served by GitHub Pages at your domain. Placeholder until release. |
| Vault repo | GitHub, **private** | Holds `contents/` (what gets published) and two workflows: check-in and watchdog. |
| Worker | Cloudflare, free plan | Sends the reminder emails, serves the confirmation page, keeps the friends list, sends the letter. |
| DNS | Cloudflare | Points the domain at GitHub Pages; gives the Worker a subdomain; lets it send email from your domain. |

Why two repos: a public repo exposes its whole history, so the material can't
sit there early. The vault is private; only the watchdog can push from it to
the site, using a deploy key.

Why a Worker and not just GitHub: GitHub has no way to give you a one-click
link in an email, and no cheap way to send mail. Cloudflare Workers are free,
can send email from your own domain, and run a daily cron.

## Step by step

### 1. Domain and site

1. Buy a domain anywhere. Add it to a free Cloudflare account and switch the
   registrar's nameservers to the two Cloudflare gives you.
2. Create a **public** GitHub repo. Put an `index.html` placeholder in it, a
   `CNAME` file containing your domain, and an empty `.nojekyll`. Enable GitHub
   Pages from the `main` branch and set the custom domain.
3. In Cloudflare DNS, add four `A` records on the root pointing at GitHub
   Pages (`185.199.108.153`, `.109.153`, `.110.153`, `.111.153`) and a `CNAME`
   for `www` to `yourname.github.io`. Leave them **DNS only** (grey cloud) so
   GitHub can issue the HTTPS certificate. Once it has, turn on
   "Enforce HTTPS" in the Pages settings.

### 2. The vault

1. Create a **private** repo. Copy in [`guide/vault/`](guide/vault/): the
   `switch.conf`, the `contents/` folder, and `.github/workflows/`.
2. Edit `switch.conf`: your site repo name, your GitHub username, and the day
   counts. `WARN_DAYS` opens a nagging issue; `RELEASE_DAYS` publishes.
3. Generate an SSH keypair. Add the public half to the **site** repo as a
   deploy key with write access. Add the private half to the **vault** as a
   secret named `SITE_DEPLOY_KEY`. Deploy keys never expire, which matters for
   something that must still work in three years.
4. Create two labels in the vault, `warning` and `released`.

The watchdog runs daily. It commits a tiny file every run so GitHub never
disables the schedule for inactivity (it does that after 60 quiet days, which
would otherwise defeat the whole point). Past `RELEASE_DAYS` it clones the site
repo with the deploy key, copies `contents/` on top, pushes, writes a
`RELEASED` marker so it can never fire twice, and opens an issue.

### 3. The Worker

1. Install Node 22 and copy [`guide/worker/`](guide/worker/). Run
   `npx wrangler login`.
2. Create a KV namespace (`npx wrangler kv namespace create STATE`) and paste
   its id into `wrangler.toml`. Fill in your account id, your email, your
   domain, and the schedule.
3. In Cloudflare, enable **Email Routing** on the zone (it adds MX and SPF
   records; harmless for the website) and make sure your own address is a
   verified destination address.
4. Deploy with `npx wrangler deploy`. Set the secrets:
   - `TOKEN_SECRET` and `STATUS_KEY`: long random strings
     (`openssl rand -hex 32`).
   - `ADMIN_KEY`: another random string. It protects the friends page.
   - `CF_API_TOKEN`: a Cloudflare API token with only
     *Account › Email Routing Addresses › Edit*, scoped to your account.
5. Back in the vault, add a repo variable `ALIVE_URL` with the Worker's URL
   and a secret `ALIVE_STATUS_KEY` with the same value as `STATUS_KEY`.

### 4. Friends

Open `https://alive.yourdomain/friends` and press the one button. The Worker
emails you a manager link (bookmark it; anyone with it can edit the list).
There you add a friend's address: Cloudflare sends them a one-time
"verify your email" message, and the page shows who has clicked. Only verified
people get the letter. The letter itself is written and saved on the same page,
with a live preview of exactly what will land in their inbox.

Tell friends to expect that verification email before you add them. It comes
from Cloudflare, not you, and looks like spam otherwise.

### 5. Test it, then put the real files in

In the vault: Actions › Watchdog › Run workflow, tick `force_release`. It
publishes for real, so use placeholder content. Confirm the site changed and
the "released" issue appeared, then reset: revert that commit in the site
repo, delete `RELEASED` in the vault, run a check-in. Do this again once a
year. An untested switch is a wish.

Then replace the placeholder in `contents/` with what you actually want
published. `index.html` there becomes the homepage; add any other pages or
files alongside it.

## Things that will bite you

- **Scheduled workflows die after 60 idle days.** The watchdog commits on every
  run to stay alive. Don't remove that.
- **Tokens expire.** Fine-grained GitHub tokens last a year at most. Use a deploy
  key instead. Cloudflare API tokens can be made with no expiry; do that.
- **Email providers cache images and prefetch links.** Don't put a live
  countdown in the email; label the number with the date it was computed. And
  never make a `GET` request do something irreversible, because mail scanners
  follow links. The confirmation link here is safe: the worst a scanner can do
  is confirm you're alive.
- **Inbox takeover.** Anyone who can read your email can keep tapping the button.
  If that matters, add a PIN to the confirmation page that is never emailed.
- **Hospital, not death.** A long illness looks the same as silence. Give one
  trusted person write access to the vault so they can run the check-in for
  you. Pick a release window longer than any plausible trip.
- **Legal weight.** This is software. For anything that matters legally, also
  leave a sealed copy with a person.

## Costs

GitHub free, Cloudflare free, a domain (about $10 a year). Email sending uses
Cloudflare's free Email Routing, which only delivers to verified addresses,
hence the verify-your-friends step. If you'd rather friends didn't have to
click anything, Cloudflare's paid Email Sending or a service like Resend removes
that constraint for a few dollars a month.

## Files

- [`guide/vault/`](guide/vault/): `switch.conf`, placeholder `contents/`, and the
  `checkin.yml` and `watchdog.yml` workflows.
- [`guide/worker/`](guide/worker/): `wrangler.toml` and `src/index.js`, the whole
  Worker: reminders, confirmation page, friends manager, letter.

Replace the names in them with yours. Nothing in them is secret; all secrets
live in GitHub and Cloudflare settings.
