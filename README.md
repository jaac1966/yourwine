# YourWine

**Live demo:** _(URL pending — Cloudflare Pages)_

Standing in the wine aisle, your glasses tell you which bottle you'll actually enjoy — and which one your partner would — before you pay for it. Built for the Meta Global AI Developer Hackathon 2026 (Indie track).

## Try the hosted demo in 2 minutes
_(to be completed when the demo is deployed)_

## Run it locally
```bash
cp .env.example .env   # add your own keys
npm install
npm run smoke:meta     # one call to Muse Spark 1.3 (text, or a label photo if you pass a path)
npm run smoke:baseten  # one call to Muse Spark Open on Baseten
```

## Before the hackathon
- Research on wine-taste profiling (four axes: acidity, sweetness, tannin, body).
- A private dataset of Mexican supermarket wines. A **sample** is included in `data/` (facts only: name, grape, region, vintage, alcohol, and the four axes).
- Test photos and videos of wine labels, taken by the author (`demo/labels/`).

## Built during the hackathon (Oct 27 – Nov 4, 2026)
All code in this repository was written during the event. _(Keep this list current.)_
- Repo setup, smoke tests against the Meta Model API and Baseten.

## Meta tools used
| Step | Tool |
|---|---|
| Voice in | Muse Voice Transcribe |
| Read the label, infer the wine profile | Muse Spark 1.3 (Muse Wonder for low-confidence cases) |
| Personal explanation | Muse Spark Open (`meta-models/muse-spark-open-1026`, Baseten) |
| Compatibility score | deterministic algorithm, no model |

## License
This repository is **source-available**, not open source. See `LICENSE` (PolyForm Noncommercial 1.0.0): you may view, run and evaluate the code; commercial use requires permission.

## Trademarks, label images and responsible use

Wine names, labels and logos that appear in this repository, the app and the demo video
are trademarks or copyrighted works of their respective owners. They are shown only to
identify products. YourWine is not affiliated with, sponsored by or endorsed by any
winery, brand or retailer.

All label photos in this repository were taken by the author. Product descriptions,
tasting notes and images from third-party websites are not included.

Compatibility verdicts are personal predictions based on each user's own taste profile.
They are not ratings or assessments of any wine's quality.

YourWine is intended only for adults of legal drinking age in their country
(18+ in Mexico, 21+ in the United States). It does not sell alcohol and makes no
health claims. Please enjoy wine responsibly.

## Measurements log

### Oct 27 � first calls, Windows laptop, Quer�taro
| Call | Input | Latency | Prompt tok | Reasoning tok | Result |
|---|---|---|---|---|---|
| Muse Spark 1.3 | text only (fictional label) | 4.0 s | 43 | 742 | full JSON, conf 0.99 |
| Muse Spark 1.3 | full-size photo from Ray-Ban Meta, bottle in hand, 6 bottles behind | 8.1 s | 4,057 | 946 | correct bottle, conf 0.95; grapes/region left empty (not on front label) |
| Muse Spark Open (Baseten) | 2-sentence explanation, default reasoning | 5.1 s | 304 | 1,390 | good text |
| Muse Spark Open (Baseten) | same, `reasoning_effort: low` | 3.1 s | 304 | 763 | good text, kept |

Takeaways: both models spend most output tokens on reasoning, so `max_tokens` must be = 2,000 or the answer is empty. Photo size drives Spark cost and latency ? resize to ~1024 px before sending. Score is deterministic and instant; the explanation arrives as a second message.
