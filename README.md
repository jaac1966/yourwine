# YourWine

**Your Meta Adventurer glasses tell you whether you'll like a wine before you buy it — based on your own taste, not the crowd's.**

**Live demo:** https://yourwine.net · **API:** https://api.yourwine.net · **Video:** https://youtu.be/9-52TjrFd38

Built for the Meta Global AI Developer Hackathon 2026 (Indie track), Oct 27 – Nov 4. Built with Muse Code, Muse Spark 1.3, Muse Voice Transcribe and Muse Spark Open.

Standing in the wine aisle, you pick up a bottle and your glasses tell you — out loud, in seconds — whether you'll actually enjoy it, and whether your wife would, before you pay for it. It runs as an Android companion app for the glasses, with a web version so anyone can try it without hardware.

## Run it locally (judges)

You only need a Meta Model API key — no Baseten key, no Cloudflare account, nothing to sign up for.

```bash
git clone https://github.com/jaac1966/yourwine.git
cd yourwine/api
npm install
cp .dev.vars.example .dev.vars   # Windows PowerShell: copy .dev.vars.example .dev.vars
# paste your key into META_API_KEY (BASETEN_API_KEY optional, see below)
npm run dev                      # answer Y to the one-time D1 migration prompt
```

The API is now at `http://127.0.0.1:8787` (use `127.0.0.1`, not `localhost` — PowerShell 5 can't resolve it against wrangler).

Then, in a second terminal from the repo root:

```bash
npm run demo:learn -- --photo samples/bread-and-butter-glasses.jpg
```

What you'll see, step by step:

1. `POST /reset` — demo profiles restored.
2. `POST /scan` — the label is read by **Muse Spark 1.3** (real call, your key), the wine is stored in the local D1 and scored with 4AM: a score in the high 80s / low 90s, `cache_hit 0, read_by spark`. Spark's four-axis reading varies by about ±1 between runs (we have seen 88 and 94 for this bottle); once the wine is stored, the row keeps it stable.
3. `POST /explain` — `explained_by: template`: a deterministic two-sentence explanation built from the same axes as the score.
4. `POST /feedback loved` — the red-wine profile moves toward this wine.
5. `POST /scan` of the same photo — `cache_hit 1`, same wine row, **different score** (the profile learned).
6. `GET /usage` — tokens, scans, cache hits, daily cap and remaining scans.

The script exits with an error if the second scan isn't a cache hit or the score didn't move, so it doubles as a smoke test.

**What `BASETEN_API_KEY` adds:** with it, `/explain` is written by **Muse Spark Open** (`meta-models/muse-spark-open-1026` on Baseten) and the response says `explained_by: spark-open-baseten`. The hosted demo at `yourwine.net` runs with Baseten. The score is identical either way — it never depends on a model.

The sample photo was taken with Meta Adventurer glasses, bottle in hand, in a supermarket aisle, and reduced to 1024 px.

`/scan` is capped at 300 label reads per day (`SCAN_DAILY_CAP` in `wrangler.toml`); `GET /usage` shows `cap` and `remaining`.

**Measured on a clean clone (Nov 4, Windows 11 laptop):** `git clone` → first verdict in about 12 minutes (`npm install` 41 s; the two label reads took 17 s and 12 s). That run produced a FAIL — the second scan was not a cache hit — which turned out to be a real bug: Spark sometimes returns the name with the vintage inside, so the same bottle got two ids. Fixed the same morning (`601abf3`, canonical name feeds `wineId()`), re-verified on a fresh local D1: miss → hit, then hit → hit.

### Web demo (no hardware)

```bash
cd web
npm install
npm run dev
```

Opens at `http://localhost:5173`, talking to `https://api.yourwine.net` by default (set `VITE_API_URL=http://127.0.0.1:8787` to use your local API). Same flow as the glasses: scan a label with the phone camera or choose a photo, get your score and your Winebuddies' scores, read the explanation, say "I loved it" or "Not for me", scan again.

`yourwine.net` is the same code on Cloudflare Pages. It uses a **shared demo profile** — tap *Reset* to start from the base taste profile. Append `?debug=1` to see the raw profile, per-axis deltas, `read_by`, `cache_hit` and `explained_by` on every response.

### Developer scripts

```bash
cp .env.example .env     # repo root; same two keys
npm run smoke:meta       # one call to Muse Spark 1.3 (text, or a label photo if you pass a path)
npm run smoke:baseten    # one call to Muse Spark Open on Baseten
cd api; npm test         # 67 tests, no network
```

## Why glasses

Choosing wine is a hands-busy, eyes-on-the-shelf moment. A phone app means putting the bottle down, unlocking, framing a photo, reading a screen. With glasses the whole interaction is: look at the label, ask, listen.

YourWine is built for Meta Adventurer glasses from the ground up:

- **Camera** reads the label — the bottle in your hand, not the twenty behind it.
- **Microphone** takes the question ("would I like this?", "and my wife?").
- **Speaker** gives the verdict and a one-breath explanation, so you never look at a screen.

The phone stays in your pocket. It runs the companion Android app that bridges the glasses to the backend through Meta's Wearables Device Access Toolkit.

## How it works

**Step 0, once:** open YourWine on your phone when you walk into the store. The app connects to the glasses through the Device Access Toolkit and stays listening; the phone goes back in your pocket. From here on, everything happens on the glasses.

```
Meta Adventurer glasses ──photo + voice──▶ Android companion app (Kotlin, DAT)
        ▲                                     (already open, listening)
                                              │
                                              ▼
                                   YourWine API (Cloudflare Worker + D1)
                                              │
            ┌─────────────────────────────────┼──────────────────────────────┐
            ▼                                 ▼                              ▼
   Muse Spark 1.3 reads the label   4AM: deterministic score     Muse Spark Open writes the
   and infers the wine's profile    vs. your taste profile        personal explanation (Baseten)
            └─────────────────────────────────┼──────────────────────────────┘
                                              ▼
                       "88% for you. 56% for your wife." ──voice──▶ glasses
```

The score comes back first — it is arithmetic, not a model, so it is instant. The explanation follows a few seconds later as a second spoken message while you are still holding the bottle.

**The model reasons, the algorithm decides.** In four runs on the same photo, Spark inferred different grapes each time (Zinfandel, Pinot Noir, none) but returned the same four axes — and 4AM returned the same score. That is why the verdict is verifiable: `api/src/fourAxisMatch.ts` reads in a minute, and the depth is in its tests.

**4AM — Four-Axis Match.** Every wine and every drinker is a point on four axes: acidity, sweetness, tannin, body (each 1–5). Score = 100 × (1 − weighted distance / 4). Weights depend on the wine's color (tannin barely counts for whites and rosés). The explanation model receives the score and the per-axis deltas as facts and is told never to contradict them.

**It learns your taste from you — the Rule of 5 Wines.** No crowd ratings, no critics, no quiz about coffee and chocolate. You taste five wines and say how much you liked each one; from those five, YourWine builds your profile per color (red, white, rosé; sparkling uses white). Everything that follows is a prediction about *you*, never a rating of the wine.

**It learns.** After you drink it: "loved it" or "not for me", by voice. The profile moves toward (or away from) that wine with an adaptive step — the first "loved" covers about 45 % of the distance, the fifth about 15 % — and the next verdict changes. Learning has a cost: after loving a Beaujolais, a previous 88 % Cabernet came back at 85 %.

**Winebuddies.** One scan answers for everyone you drink with: your match and theirs. Ana and Luis are demo profiles.

**Next, not in this submission:** "which one should I take?" across two or three bottles, and "Hey Meta, start YourWine" (voice invocation needs app registration with Meta's Developer Center and does not run in Developer Mode; today a tap on the phone starts listening, with a beep).

## Android companion app

`android/` — Kotlin + Jetpack Compose, minSdk 31, Wearables Device Access Toolkit 1.0.1 in Developer Mode. Open it in Android Studio (or `cd android && ./gradlew assembleDebug`) and install on a phone paired with the glasses in the Meta AI app (Developer Mode on, DAT SDK component installed on the glasses, camera permission granted to YourWine).

Flow: **Ask** → beep → the glasses' mic (Bluetooth SCO, `MODE_IN_COMMUNICATION` so Meta AI doesn't take the call) → WAV → `POST /transcribe` (**Muse Voice Transcribe**) → keyword intents (`like` / `this one` / empty → scan; `and for <name>` → that buddy's score; `loved` / `not for me` → feedback) → `capturePhoto(LARGE)` on the glasses → HEIC normalized to JPEG and reduced to 1024 px on the phone → `POST /scan` → verdict spoken with Android TextToSpeech → `POST /explain` spoken as a second message → `POST /feedback` by `scan_id`.

A debug-only path uses the Mock Device Kit with a label photo from the phone, so the whole flow can be exercised without glasses.

**Honest dates.** Live runs on Meta Adventurer glasses: **Oct 28** (first full scan, ~10 s to spoken verdict) and **Oct 30** (voice in, ~23 s). Nov 3 app changes (feedback by `scan_id`, 1024 px photo, single `API_BASE`) were verified on the phone against production through the Mock Device Kit path: on our unit, DAT photo capture stopped delivering after the Meta AI app auto-updated to 297 on Nov 3 (capture timeout after 30 s, `openChannel` failures in Meta AI logs; mic over SCO and manual capture with the glasses' button still work). This is the DAT data channel between Meta AI and the glasses, not the app code; the Oct 28 and Oct 30 runs are measured below.

## Meta tools used

| Step | Tool |
|---|---|
| Capture (photo) | Meta Adventurer glasses via Wearables Device Access Toolkit 1.0.1 |
| Voice in | Muse Voice Transcribe 1.0 (`POST /v1/asr/transcribe`, PUSH_TO_TALK, 16 kHz WAV) |
| Voice out | Android TextToSpeech (system voice, not a model) |
| Read the label, infer the wine's axes | Muse Spark 1.3 (escalates once to Muse Wonder 1.0 when confidence < 0.7; `read_by` in the response) |
| Personal explanation | Muse Spark Open (`meta-models/muse-spark-open-1026`, Baseten, `reasoning_effort: low`) |
| Compatibility score | 4AM, deterministic, no model |
| Build | Muse Code (Worker, tests, Android app, web demo) |

## Data

Scans and profiles live in Cloudflare D1 (`yourwine-db`; `npm run dev` creates a local SQLite with the same migrations):

- **wines** — label facts (producer, name, vintage, region, country, grapes, ABV, color) plus the four taste axes, `source` (`seed`, `spark` or `wonder`) and scan count. The wine id is derived from producer + name + vintage, so the same bottle always maps to the same row even when Spark phrases the name differently.
- **profiles** — one row per user: base axes plus the per-color overlays that feedback moves.
- **scans** — one row per scan: user, wine, score, buddies, cache hit, reader, latency and feedback.

**Where the seed data comes from.** `api/data/wines.sample.json` holds 8 wines (3 red, 3 white, 1 rosé, 1 sparkling) written by hand by the author before the event: factual fields only (name, grape, region, vintage, ABV) plus the four axes assigned by the author. Nothing copied from retailer or winery sites. The three profiles in api/data/profiles.json (`alex`, `ana`, `luis`) are demo profiles.

What is not stored: the photo is never saved — it is sent to the label model and discarded.

A repeat scan still calls Spark to identify the bottle; the cache buys **consistency** (same bottle → same axes, even when Spark's reading varies) and history, not speed.

Judges: `POST /reset` restores the demo (re-seeds profiles, clears scans, keeps wines).

## Before the hackathon

- Research on wine-taste profiling (the four axes).
- The 8-wine sample dataset described above, and label photos taken by the author with Meta Adventurer glasses and a phone.
- The YourWine/TuVino brand and visual identity (name, wordmark, colors, typefaces) existed before the event. **All code in this repository, including the web UI, was written during it.**

## Built during the hackathon (Oct 27 – Nov 4, 2026)

- **Oct 27** — Repo. Smoke tests against the Meta Model API and Baseten. First real label read from a glasses photo.
- **Oct 28** — Cloudflare Worker (`/scan`, `/explain`, `/feedback`, `/usage`), 4AM + tests, Wonder escalation, Android app with DAT. **23:01: first full scan on real Meta Adventurer glasses** (L.A. Cetto Merlot, 75 %, spoken verdict).
- **Oct 29** — `yourwine.net`, `api.yourwine.net`, Workers Logs, repo security (secret scanning, CodeQL, `SECURITY.md`). Voice input: `/transcribe` + keyword intents, HFP mic routing. **Oct 30, 00:44: first end-to-end voice flow on the glasses.**
- **Oct 30–31** — D1: `wines` / `profiles` / `scans`, `/reset`, `wineId()`, `demo:learn` script.
- **Nov 1** — Judge path: `.dev.vars.example`, explanation fallback without Baseten, real sample photo. Web demo (`web/`, Vite).
- **Nov 2** — `yourwine.net` live on Pages. `/explain` grounded on the score and per-axis deltas; adaptive learning step; single `getProfile()` for every route (fixed a bug where each route read a different profile); deterministic template fallback; web restyle; `?debug=1`. Three live scans in a supermarket aisle.
- **Nov 3** — Web: Known / New bottle chip, model names in the loading states, "or choose a photo". Android: feedback by `scan_id`, 1024 px photo, single API base — verified on the phone against production. Meta AI 297 broke DAT photo capture on our unit (see above).
- **Nov 4** — Worker: daily scan cap; display name = producer + name without repeats or trailing vintage. The judge-path run on a clean clone caught a real bug (same bottle → two ids when Spark includes the vintage in the name); fixed: one canonical name feeds `wineId()`, lookup, insert and the response. 67 tests. README, judge-path timing, video.

## Measurements log

### Oct 20 (before the event) — 31-bottle label test, private prototype
62 photos of 31 supermarket bottles (front + back), run with the author's pre-event prototype against the same Muse Spark 1.3 API; that prototype's code is not in this repository. **31/31 identified** (front + back); front only 30/31. Vintage 28/28 and alcohol 30/30 where printed; in the 8 wines whose label does not name the grape, Spark inferred it from the appellation (Gamay, Mencía, Tempranillo…) and flagged it as inferred. The 4 poor readings all had confidence ≤ 0.62 and no good reading fell below 0.75 — that is where the 0.7 Wonder threshold comes from. Median 8.0 s per photo.

### Oct 27 — first calls, Windows laptop, Querétaro
| Call | Input | Latency | Prompt tok | Reasoning tok | Result |
|---|---|---|---|---|---|
| Muse Spark 1.3 | text only (fictional label) | 4.0 s | 43 | 742 | full JSON, conf 0.99 |
| Muse Spark 1.3 | full-size photo from Meta Adventurer, bottle in hand, 6 bottles behind | 8.1 s | 4,057 | 946 | correct bottle, conf 0.95; grapes/region left empty (not on front label) |
| Muse Spark Open (Baseten) | 2-sentence explanation, default reasoning | 5.1 s | 304 | 1,390 | good text |
| Muse Spark Open (Baseten) | same, `reasoning_effort: low` | 3.1 s | 304 | 763 | good text, kept |

Takeaways: both models spend most output tokens on reasoning, so `max_tokens` must be 2,000 or more or the answer comes back empty. Photo size drives Spark cost and latency.

### Oct 28 — same photo, four runs
Spark inferred different grapes each run (Cab/Merlot/Zinfandel, Cab/Merlot/Pinot Noir, none) with the same four axes → same scores (88 / 69 / 75). The model reasons, the algorithm decides.

### Oct 28, 23:01 — first full scan on real Meta Adventurer
LARGE capture 155 KB HEIC, capture + Bluetooth transfer 5.5 s, `/scan` ~4 s, `/explain` ~4 s, **Ask → spoken verdict ~10 s**. L.A. Cetto Merlot 2024: 75 %.

### Oct 30, 00:44 — first end-to-end voice flow on real glasses
HFP mic (Meta Glasses 05N2), 4.2 s recording (1.0 s speech, 92.8 KB WAV), `/transcribe` 1.5 s, capture ~11 s, `/scan` 4.6 s, `/explain` 4.7 s, **Ask → verdict ~23 s**. Heard "goal I like this" for "would I like this"; keyword intents still routed correctly.

### Oct 31 — D1 in production, `demo:learn`
Full-size glasses photo: miss 7.7 s → loved → hit 6.0 s, **88 → 89**; ~5,400 Meta tokens per scan. The cache hit is not faster (Spark still reads the photo to identify the bottle); it buys consistency.

### Nov 1 — photo reduced to 1024 px
Same photo at 1024 px: ~3,300 Meta tokens per scan (about half), same axes, same verdict (88 → 89).

### Nov 2 — live supermarket shelf, yourwine.net
Phone camera, mobile data. **3/3 labels read** (Carmenere 75 %, Crianza 75 %, Chianti 69 %); **7–16 s photo → verdict**. Beaujolais-Villages 2021 (Gamay, axes 4/1/2/2) against the reset profile 2/2/4/4: 56 % · Ana 88 % · Luis 69 %.

### Nov 2 — learning with the adaptive step (production)
Montes Alpha Cabernet 88 % → Beaujolais 62 % (after a "loved" on the Montes) → "I loved it" → **73 %** (+11).

### Nov 3 — learning, phone screen recording (the clip in the video)
Reset profile 2/2/4/4. Montes 88 % (Ana 56 · Luis 63) → Beaujolais **56 %** Mixed → "I loved it" → same Beaujolais **76 %** Likely match, Known bottle (+20). Rescanning the Montes afterwards: **88 → 85 %** — learning has a cost.

### Nov 3 — same bottle, glasses vs. phone
L.A. Cetto Merlot 2024: **75 %** with the glasses on Oct 28 and **75 %** with the phone camera on `yourwine.net` on Nov 3 (different camera, different photo, six days apart).

### Nov 3 — Android app → production
Real phone, 1000 Stories Bourbon Barrel-Aged Zinfandel: 92 / 56 / 63, Known bottle; "Loved it" by `scan_id` moved the red profile toward higher tannin and body.

### Nov 3–4 — `demo:learn` against production and on a fresh local D1
Production, Worker `87e9fed2` (Nov 3): hit 13.8 s → loved → hit 9.0 s, **88 → 93**.
Fresh local D1, Worker `601abf3` (Nov 4, the judge's case): miss 17.4 s (**94** — Spark read tannin 4 this time) → loved → hit 14.0 s, **97**; second run hit → hit. One row in `wines`.
Production, Worker `289e9bc3` (Nov 4, submitted): hit 10.6 s → loved → hit 11.3 s, **88 → 93**, `explained_by: spark-open-baseten`, `/usage` → `cap 300, remaining 294`.

## Troubleshooting

- Meta AI answering instead of the app → fixed by setting `MODE_IN_COMMUNICATION` before the SCO device.
- Glasses deliver HEIC → normalized to JPEG on the phone.
- First `createSession` fails → retried after 2 s.
- Recording cut before speech → beep + speech-gated silence detection.
- `/explain` came back empty → Spark spent the whole budget reasoning (`finish_reason: length`); `max_tokens` raised, then replaced by the deterministic template when Baseten is absent.
- Second scan of the same bottle was a cache miss on a fresh DB (Nov 4) → Spark sometimes includes the vintage in the name, producing a second id; now one canonical name (producer + name, repeats and trailing vintage stripped) feeds `wineId()` for lookup, insert and response. Caught by the judge-path run, not by the unit tests.
- DAT photo capture times out after Meta AI 297 → see Android companion app; not fixed on our unit as of Nov 4.

## Submission

- Tag: `submission` on `main`.
- Worker in production = this commit, Cloudflare version `289e9bc3` (deployed Nov 4, 10:55 CDMX, commit `601abf3`). Deploys are manual with Wrangler; `main` is not touched after the deadline.
- Web: Cloudflare Pages builds `main` automatically.
- Video: _(YouTube link)_ → - Video: https://youtu.be/9-52TjrFd38 (3 min, unlisted)

## License

This repository is **source-available**, not open source. See `LICENSE` (PolyForm Noncommercial 1.0.0): you may view, run and evaluate the code; commercial use requires permission.

## Trademarks, label images and responsible use

Wine names, labels and logos that appear in this repository, the app and the demo video
are trademarks or copyrighted works of their respective owners. They are shown only to
identify products. YourWine is not affiliated with, sponsored by or endorsed by any
winery, brand or retailer. Meta Adventurer, Muse and Meta are trademarks of their owners;
YourWine is an independent hackathon project.

All label photos in this repository were taken by the author. Product descriptions,
tasting notes and images from third-party websites are not included.

Compatibility verdicts are personal predictions based on each user's own taste profile.
They are not ratings or assessments of any wine's quality.

YourWine is intended only for adults of legal drinking age in their country
(18+ in Mexico, 21+ in the United States). It does not sell alcohol and makes no
health claims. Please enjoy wine responsibly.
