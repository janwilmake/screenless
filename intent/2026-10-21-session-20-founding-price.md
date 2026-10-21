# Session 20 — a founding price: $200 for 40 hours, on a bet that the voice gets cheaper

author: Wijnand (wijnand@hyre.io), via Claude Code in the work session

What 40 hours a month of calls and meetings costs, and what to charge for it.
What landed:

- **The real cost, measured.** The OpenAI usage page showed $10.33 of
  `gpt-live-1` from 14 to 21 October, against 193 minutes billed in the ledger
  over the same days: ~5.4¢ a minute, close to the $0.05 list price. The
  wrangler.jsonc note from 18 October (15–18¢) was wrong and is replaced. A
  meeting minute is ~6.5¢ with Recall; a phone minute up to ~12¢ with the
  ring-back's telephony and Stripe. Telnyx's Dutch-mobile rate and Recall's
  `web_4_core` surcharge are still estimates.
- **GPT-Live stays in meetings, listening the whole time.** Offered: open the
  voice only when the bot is addressed (~$120 → ~$12 for 40 hours), or a
  cheaper turn-taking model with a `delegate` function. Declined: the bot is
  to become more proactive, and that needs it listening.
- **One plan, a founding price.** Offered three tiers ($79 / $200 / $500).
  Chosen instead: one plan, $500 struck through, $200 a month for 40 hours of
  calls and meetings and unlimited WhatsApp, locked for 12 months. Roughly
  break-even for a team that uses all of it; the bet is that GPT-Live-level
  voice drops toward 2¢ a minute within the year. A later raise is only for
  new teams: each subscription carries its own Stripe price.
- **15¢ overage**, from 40¢, above the ~12¢ break-even of a phone minute.
- **A 2-hour trial**, from 30 minutes, so a real meeting fits in it.
- The only subscriber on the $79 plan was the owner, so nobody is migrated.

Open: whether price is what stops businesses at all — the session argued
trust and setup are likelier; a spending cap (warn at 80%, stop at 100%
unless an admin allows overage) was suggested and not asked for.

---

> conside this:
>
> [pasted: a claude.ai conversation on cheaper alternatives to GPT-Live — Gemini 3.8 Live, Qwen3.8-Omni, Grok Voice, open full-duplex models (NemotronLabs VoiceChat, Qwen3-Omni, Moshi) — and on when GPT-Live quality under 1¢ a minute might arrive, for 40 hours of meetings a month under $50]
>
> how much it cost for 40 hours a month of calls and meetups? 2h a working day. so with our current set up? and how can we bring it down?

> would we have teh same functionality by replacigng gptlive with another full-duplex model?

> ok u know what... if we do keep a tiny margin its still quite good. maybe we can just drop our margins a bit on the overage. i dont wanna change the meetings to another model or to disable/enable it, cuz i wanna make it more proactive in the future, and wanna keep experimenting with that. so.... how much is our cost right now per minute?

> i mean the whole team benefits from it and the total cost for the remo is like 200+100+400=700, so its kinda premium but its good enough i'd say. however it feels kinda unpredictable, which is a harder purchasing decision. maybe it's better to have a second plan for like $200/month and a third at $500, when selling this to businesses? wdyt?

> its likely though that future models will come out making the 0.05/minute drop to about 0.02. if we'd bet that to happen in the next months, maybe we can offer a much cheaper one and start with way less margin. but ofc, only if it matters for businesses if they'd find it too expensive otherwise. how to go about it?

> Can't we keep it simple now, and keep 1 tier? maybe we can do $500 crossed out and $200 / month now for the founding customers. and give them 40 hours for this? i think we'll break even, which is fine because we can raise to 500 anytime and we can use dropped price in the coming year

*Asked: overage at 15¢, the founding price locked for 12 months, a 2-hour trial, and whether anyone is on the $79 plan.*

> 1 yes 2 sounds good 3 ok 4 non existant, just me. go ahead.

> can you look at usage on platform.openai.com to get the real costprice?
