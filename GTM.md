# Go to market

Two audiences, one wedge, four motions, and a gate you should not walk through
early.

## The wedge

**The paper is free. The call is $99.**

This is not a pricing trick, it is a sequencing decision. The paper is built and
demoable today; the call is the part that does not exist yet. So the free
surface is the one that works, and it does the acquiring while `rounds` gets
built. Someone who has had a printable paper about their own product landing
every morning for two weeks is a warm prospect for a call about it. Someone who
has heard about it is not.

It also fixes the trial problem. A 7-day trial of a call that cannot yet read
your pull requests produces churn and bad word of mouth in exactly the community
you need. A free paper produces neither.

## Who, and why these two

**Your X audience — solo devs, eng leaders, SF.** Already assembled, already
watching you build this, already running agents overnight. They install from a
terminal without being sold to, and $99 is an impulse. This is the volume
audience.

**Dutch devs — LinkedIn, Amsterdam, AI Builders, Hackadam.** Warm, in-person,
and the only audience where you can watch someone's face while they use it. This
is the *learning* audience. Ten conversations in a room in Amsterdam will tell
you more about whether a phone call is the right shape than a thousand X
impressions.

Do not pick. They serve different purposes and cost different things.

## Positioning: design partner, not customer

Say the incompleteness out loud and turn it into the offer:

> Early access. The telephony works, the paper ships nightly, and the part that
> reads your PRs is being built now — with the first fifty people, in the open.
> $99/month, locked for as long as you stay.

Three reasons this beats selling the finished vision. Senior engineers can smell
a demo, and pretending costs you the exact people you want. A price locked
forever is a real reason to join early rather than wait. And it gives you
permission to ship rough things weekly, which is the only way this gets built.

## Four motions, in this order

**1. Build in public on X — now, continuously.**
You already posted the Telnyx thread and it worked. Keep going: the
silent-assistant bug and how it was diagnosed, the DKIM key you verified by
decoding rather than trusting, the form-encoding bug that would have broken
every inbound call, `curl | bash` in one command. Ship a post per real artifact,
not per milestone. This compounds and costs nothing but the writing.

The paper is unusually postable — it is a *picture*. Post the actual PDF of your
own repo weekly. Nobody else's dev tool produces something you can hold.

**2. Dutch rooms — now, weekly.**
AI Builders and Hackadam. Do not pitch; demo the paper and ask two questions:
*what would you have wanted the call to ask you this morning?* and *what would
you have said back?* That is `rounds`' spec, gathered for the price of a beer.
Target ten design partners from these rooms who let you watch them use it.

**3. Hand-recruited design partners — the first fifty, gated.**
From 1 and 2. Onboard each personally. Weekly check-in. They get the locked
price. Stop at fifty until the call works — a hundred people churning through a
broken call is worse than fifty who saw it get fixed.

**4. Launch moment — later, once, when `rounds` works.**
HN and Product Hunt on the same day, with a working call and the paper as the
proof object. Hold this. A launch spike into an unfinished product converts
attention you cannot buy again into churn. The trigger is: three design partners
took a real morning call for five consecutive days and kept doing it.

## Sequence

| Phase | Gate to leave it | What you're doing |
|---|---|---|
| **Now** | `rounds` runs once, for real | Build in public. Free paper only. Dutch rooms weekly. No paid push. |
| **Design partners** | 3 partners × 5 consecutive real calls | Fifty people, hand-onboarded. Call trial on. Weekly interviews. |
| **Launch** | Retention holds past week two | HN + PH. Stripe live. Widen paid acquisition. |

## What to measure

Only four things matter early, and none of them is signups.

- **Papers delivered per week, per user.** Is the loop actually running
  unattended? This is the product's heartbeat.
- **Second-call rate.** Did someone who took one morning call take another?
  This is the whole thesis in one number.
- **Call completion vs. hang-up.** A drained queue should end the call. Early
  hang-ups mean the agenda is wrong.
- **Free → paid conversion**, once the call is real. Not before; the number is
  meaningless while `rounds` is missing.

Vanity: impressions, stars, waitlist size.

## The honest risks

- **The call may not be the right shape.** Voice is a terrible medium for
  anything needing a diff. If design partners keep saying "send me that one", the
  product is the paper plus a notification, not a call. Find out in Amsterdam,
  cheaply, before building more.
- **Telephony is a real COGS**, and the 30-minute promise is currently unenforced
  (see TODO). A heavy user on $99 can cost more than they pay. Fix before volume.
- **The free paper is not free to you** — it is Resend plus your time. Cheap, but
  cap it if it is abused.
- **You are the bottleneck.** Every motion here is you writing, demoing or
  interviewing. Two motions done well beat four done thinly; if something has to
  give, keep X and the Dutch rooms.

## The next three things

1. Make the loop run once, unattended, against hyre. Post the paper it produces.
2. Take ten of those papers to AI Builders and ask the two questions.
3. Build the smallest `rounds` that can hold a five-minute call about three real
   PRs — then take that call yourself, five mornings running.

Everything in this document is downstream of step 3 working.
