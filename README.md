# YourWine

**Live demo:** _(URL pending — Cloudflare Pages)_

**YourWine is an app for Meta Adventurer glasses that tells you whether you'll like a wine before you buy it — based on your own taste, not the crowd's.** It runs as an Android companion app for the glasses, with a web version so anyone can try it without hardware.

Standing in the wine aisle, you pick up a bottle and your glasses tell you — out loud, in seconds — whether you'll actually enjoy it, and whether your partner would, before you pay for it.

Built for the Meta Global AI Developer Hackathon 2026 (Indie track).

## Why glasses

Choosing wine is a hands-busy, eyes-on-the-shelf moment. A phone app means putting the bottle down, unlocking, framing a photo, reading a screen. With glasses the whole interaction is: look at the label, ask, listen.

YourWine is built for Meta Adventurer glasses from the ground up:

- **Camera** reads the label — the bottle in your hand, not the twenty behind it.
- **Microphone** takes the question ("would I like this?", "and Mary?").
- **Speaker** gives the verdict and a one-breath explanation, so you never look at a screen.

The phone stays in your pocket. It runs the companion Android app that bridges the glasses to the backend through Meta's Wearables Device Access Toolkit.

## How it works

**Step 0, once:** open YourWine on your phone when you walk into the store. The app connects to the glasses through the Device Access Toolkit and stays listening; the phone goes back in your pocket. From here on, everything happens on the glasses.

```
Meta Adventurer glasses ──photo + voice──▶ Android companion app (Kotlin, DAT)
        ▲                                     (already open, listening)
                                              │
                                              ▼
                                   YourWine API (Cloudflare Worker)
                                              │
            ┌─────────────────────────────────┼──────────────────────────────┐
            ▼                                 ▼                              ▼
   Muse Spark 1.3 reads the label   deterministic compatibility    Muse Spark Open writes the
   and infers the wine's profile    score vs. your taste profile   personal explanation (Baseten)
            └─────────────────────────────────┼──────────────────────────────┘
                                              ▼
                       "78% for you. 91% for Mary." ──voice──▶ glasses
```

The score comes back first — it is arithmetic, not a model, so it is instant. The explanation follows a few seconds later as a second spoken message while you are still holding the bottle.

**It learns your taste from you — the Rule of 5 Wines.** No crowd ratings, no critics, no quiz about coffee and chocolate. You taste five wines and say how much you liked each one; from those five, YourWine builds your profile on four axes (acidity, sweetness, tannin, body — each 1–5). The same rule applies per color: five reds, five whites, five rosés, each unlocking its own profile. Everything that follows is a prediction about *you*, never a rating of the wine.

**Winebuddies.** Connect with the people you drink with. One scan answers for everyone: your match and theirs.

**It learns.** After you drink it: "loved it" or "not for me", by voice. The profile shifts and the next verdict changes.

**It compares.** Point at two or three bottles: "which one should I take?" The answer names the one to grab, not a score per label.

## Try the hosted demo in 2 minutes
_(to be completed when the demo is deployed)_

## Run it locally
```bash
cp .env.example .env   # add your own keys
npm run smoke:meta     # one call to Muse Spark 1.3 (text, or a label photo if you pass a path)
npm run smoke:baseten  # one call to Muse Spark Open on Baseten
```

API:
```bash
cd api && npm install && npm run dev
```
```bash
npm test
curl -X POST http://localhost:8787/scan -F photo=@label.jpg -F user=alex -F buddies=ana,luis
```

## Before the hackathon
- Research on wine-taste profiling (four axes: acidity, sweetness, tannin, body).
- A private dataset of Mexican supermarket wines. A **sample** is included in `data/` (facts only: name, grape, region, vintage, alcohol, and the four axes).
- Test photos and videos of wine labels, taken by the author with Meta Adventurer glasses and a phone (`demo/labels/`).

## Built during the hackathon (Oct 27 – Nov 4, 2026)
All code in this repository was written during the event.
- **Oct 27** — Repo setup. Smoke tests against the Meta Model API and Baseten. First real label read from a glasses photo. See measurements below.

## Meta tools used
| Step | Tool |
|---|---|
| Capture (photo, voice in, voice out) | Meta Adventurer glasses via Wearables Device Access Toolkit |
| Voice in | Muse Voice Transcribe |
| Read the label, infer the wine profile | Muse Spark 1.3 (Muse Wonder for low-confidence cases) |
| Personal explanation | Muse Spark Open (`meta-models/muse-spark-open-1026`, Baseten) |
| Compatibility score | deterministic algorithm, no model |

## Measurements log

### Oct 27 — first calls, Windows laptop, Querétaro
| Call | Input | Latency | Prompt tok | Reasoning tok | Result |
|---|---|---|---|---|---|
| Muse Spark 1.3 | text only (fictional label) | 4.0 s | 43 | 742 | full JSON, conf 0.99 |
| Muse Spark 1.3 | full-size photo from Meta Adventurer, bottle in hand, 6 bottles behind | 8.1 s | 4,057 | 946 | correct bottle, conf 0.95; grapes/region left empty (not on front label) |
| Muse Spark Open (Baseten) | 2-sentence explanation, default reasoning | 5.1 s | 304 | 1,390 | good text |
| Muse Spark Open (Baseten) | same, `reasoning_effort: low` | 3.1 s | 304 | 763 | good text, kept |

Takeaways: both models spend most output tokens on reasoning, so `max_tokens` must be 2,000 or more or the answer comes back empty. Photo size drives Spark cost and latency: resize to about 1024 px before sending. Score is deterministic and instant; the explanation arrives as a second message.

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
