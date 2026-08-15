# Session 5 — the landing page had a voice but no argument

**15 August 2026, from 20:35 UTC.**

One prompt, one surface. The landing page was rewritten from a page that
assumed agreement into a page that argues for itself: a problem section, a
"try it in sixty seconds" section built around `screenless test`, the
no-credentials boundary as its own trust block, eight FAQ answers, and the
design-partner honesty promoted out of the closing fine print into a section
of its own.

Two skills were installed from `skills.sh` and used rather than improvised
around: `autonnel/autonnel-skills@landing-page-conversion-audit` (13.8K
installs) for the audit, `onewave-ai/claude-skills@landing-page-copywriter`
(5.6K) for the copy frameworks.

**What landed:** `site/src/index.html` rewritten, keeping the newsprint design
language and the call transcript intact. `site/src/_headers` added so the
installer, which the page now invites people to read before piping it to bash,
serves as UTF-8 instead of rendering every em dash as mojibake.

**Where it drifted:** a claimed mobile-overflow bug that did not exist.
Headless Chrome on macOS has a 500px minimum window width, so a 390px
screenshot is a 500px layout cropped — it looks exactly like horizontal
overflow. Two "fixes" were written on that basis. Measuring properly, through
an iframe at a true 390px, showed `scrollWidth == 390` on both the new page
and the original. One fix was reverted; the nav-wrap one was kept because
measuring also showed a real defect underneath it — five nav items squeeze
until the labels break mid-phrase, "the / call".

Then an SEO pass, using `seo-geo`. The audit found nothing structured at all:
no canonical on a site whose apex and www are both live, a 192-character
description that truncated before the price, and zero JSON-LD. The expensive
gap was `og:image` — GTM.md puts building in public on X first among four
motions, and every link posted there rendered as a bare text card. Added: an
OG card rendered from HTML so it stays in the page's own type, FAQPage and
SoftwareApplication markup fed by the FAQ written earlier the same session,
canonicals, a sitemap, and an `llms.txt` that leads with the architectural
rule — because the thing an assistant gets wrong about this product is
exactly that it describes a call which merges pull requests.

**Still open:** the page's own claim about where the product is remains true
and remains the thing to fix — `rounds` does not exist, so the call transcript
on the page is what the call becomes, not what it does tonight.

Deployed at the end of the session, live on screenless.sh.

---

**20:35** — yo can u look up a skill for building well-0converting laindingpages online, then use that skill to acutally make this landingpage much more thought out? what problem do we solve, for who? what would be a wow moment having them try it out? use a skill just make it muchhhhh better

**22:53** — are we good with seo optimisations?

**23:12** *(answering which robots.txt to serve, where the live one was
Cloudflare's managed file with an EU Article 4 reservation and no directives)*
— "Ours, everything allowed" — `search=yes, ai-input=yes, ai-train=yes`.
Reasoning recorded in the commit: this is a product sold to people who run
coding agents, so being quoted accurately by an assistant is acquisition
rather than leakage.

**23:13** — now deploy and push. gtg
