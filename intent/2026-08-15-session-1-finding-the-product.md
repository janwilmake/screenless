# 2026-08-15 · Session 1 — from "voice-calling alternatives" to screenless

Session `3139bc46`, 06:58–10:16 UTC, run from `~/Desktop/oss`. This is the
session the product was found in: it opens as vendor research for Dutch-language
voice AI, becomes a working Telnyx call, and dies on an upstream bug.

**What landed in the code:** Telnyx over Twilio/Vapi/Bland (EU media anchoring,
Deepgram Flux `multi` for Dutch/English code-switching), phone-number SSO by OTP
instead of Google, a Cloudflare Worker to hold the API key, per-call assistants
torn down afterwards, and `press` as a nightly PDF.

**The open wound:** from 08:39 to 09:07 the assistant connects and stays silent.
Reproduced against Telnyx's own browser demo, which worked — so it is the
telephony path, not the assistant. Raised with support and still open. The
comments in `worker/src/telnyx.ts` carry that scar.

**Why the number is American:** the Dutch number's regulatory review was
declined repeatedly over the business name — a one-person company with a short
trade name does not satisfy "registered legal name including legal suffix". The
US fallback in `wrangler.jsonc` exists because of this, not by preference.

**Redactions:** an API key, a home address, a contact name, a phone number and
an OTP have been removed. From 09:08 the session turned to unrelated personal
business — freelance outreach and private career matters — and that stretch is
deliberately not recorded here. Only its product-relevant remarks are kept.

---

**06:58** — yo i wanna know about voice-calling ai alternatives. i am curious about features like interrupt, repsonse-time, calls in dutch language

**06:59** — did you use regular websearch or did you use parallel?

**07:00** — use parallel from now on for all research

**07:06** — ok i am interested in latency from the netherlands and i wanna use dutch language. pls gimme top 3

**07:11** — ok so which has code switching?

**07:11** — ok so which has code switching? and i cant afford enterprise rn

**07:13** — ok so what do u recommend

**07:14** — ok with vapi + deepgram flux multilingual, can i also get it to call me from a phone number?

**07:16** — ok with telnyx + deepgram multilingual, can i also get it to call me from a phone number?

**07:20** — cool what are the steps required to get to a poc which is a simple cli that will first have a setup where you authenticate (eg google sso), the phone number to call is set up, and then running the cli main command 'call "prompt here"' will call you on that number and have a conversation, it will block until thats done, and respond with the transcript. pls make a repo

**07:22** — actually lets not sso with google, lets sso with the pohne number, receive a call or text with a code , so you are authenticated as that number

**07:22** — and i assume we need a backend so we can host the api key that allows actually placing calls etc right

**07:23** — for that lets use cloudflare worker

**07:35** — are we using just telnyx or we need deepgram too? what api keys should i make for u so u can do the rest?

**07:37** — api key: `[REDACTED]`. can u do the rest?

**07:41** — i addded money. i shoudl also be logged in to wrangler already. can u keep going?

**07:53** — *(supplying company details for the Dutch number's regulatory order — legal name, address and contact redacted)*

**08:01** — can u see the status on my order?

**08:02** — pls poll the status and setup + call me once it is active

**08:05** — oh it got declined. the business name was declined. the phone numberi s just my personal number so maybe thqats the reason. the company name needs: The full legal name of the company associated with the phone number, exactly as registered with the relevant national company registry. The name must include any legal suffix such as 'LLC', 'Ltd.', 'GmbH', 'S.A.', 'S.r.l.', or equivalent. Maximum 150 characters, minimum 1 character. Trade names and informal abbreviations without legal status are not acceptable; the registered legal name is required.

**08:07** — its actually '[trade name]' the trade name

**08:07** — its eenmanszaak

**08:16** — it seems theres no connection/application set up yet for the number, it says its required for calls

**08:16** — i can select default, forward only, or ai-assistant-a728f...

**08:20** — the name got declined.

**08:26** — i have a chat under this order, shall i put a msg there?

**08:33** — it got declined again. maybe they are checking if the number was registered with that business? or do you thiunk they auto-decline because of the formatting and/or the short name

**08:33** — it got declined , but no asnwer on support and no reason at all

**08:39** — i got called and said hello but then it didnt say anything to me

**08:42** — btw, pls open the worker code in vscode so i can take a look :)

**08:43** — still no response

**08:48** — it said nothing and hung up immdiatley

**08:50** — are we using an ai-assistant? cus i just tried that via a demo on their site and works perfectly

**08:51** — still hangs up after 1 s

**08:53** — it worked!

**08:55** — it doesnt say anything back

**08:56** — no it is quiet

**08:58** — ye the demo that worked was in the browser only.

**08:58** — i am curious though. you did everything using apis. but maybe you can browse using chrome to see if you did the whole setup correctly? did you go by docs/guides also?

**09:00** — im logged in now

**09:03** — nothing

**09:07** — it ssilent

**09:08** — look up the best way to tell them this and contact them

*(09:09–09:35 — unrelated personal business, not recorded. Product-relevant
remarks from that stretch only:)*

**09:22** — the bug is now in support and the dutch number is also handled in another support ticket, so lets stop with those things for now

**09:32** — cool lets give up the poc for now then. we stuck

**10:05** — can u also - in the meantime - draft me a x thread of what we just did with telnyx? in my style pls
