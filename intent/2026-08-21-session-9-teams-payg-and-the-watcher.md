# Session 9 — teams, pay-as-you-go, and the watcher

author: Jan Wilmake <jan@wilmake.com>

One prompt, dictated, and a big one: screenless stops being a single-person
subscription product. The CLI grows a never-ending terminal watcher that
incoming phone calls land in; users get organizations with email-only invites
managed on one page at screenless.sh/team; billing moves to the organization
as pay-as-you-go with ~$10 free credit and pricing at roughly double cost; and
the product gets its first logo — an S with a dot in the middle of each half
circle — which then fronts every email, all of which become professional HTML
rather than markdown-ish text. Database chosen by the agent (Cloudflare D1).
The prompt contains its own reversal, kept verbatim below: inviting by email
*and* phone was scrapped mid-dictation for email-only, with the invitee
filling in and verifying their own phone on accept — changeable later, because
a wrongly-typed number can never receive its own verification text.

## Prompts

- 17:52 — `Okay, I want to refactor Screenless. I want it to be, on the basis of what we have now, a watcher that you can run in a loop in the terminal that never ends and that allows you to do incoming phone calls to whatever repo you have open.

  What's more, I think, rather than just having it for only yourself, what we should set up is a team infrastructure. Instead of just having a single person, we should have the ability to add team members. I don't think this should be part of the onboarding of the CLI, but maybe there should be a separate little HTML in the worker or on the landing, like as part of screenless.sh, maybe screenless.sh/team, where you can manage your team.

  Here, you can invite people by adding their phone number and email, and then they need to accept that. Of course, they need to get a text where they get a link. If they click it, then they verify their phone, and they also need to get an invite email. If they click the link there, then they would also basically be in the team if they were already on Screenless This should say that they were invited by me, of course, so we need to also show that you were invited by Wijnand Karsens, my email. If they were already in Screenless, this should, of course, say, "Do you want to join the team?" If they were already in another team, they would leave their other team, so this way we can have one team ID or organization ID in the user table. We should also have an organizations table so that people can make organizations and name it.

  The billing, which is the most important part, goes per organization. The pricing model should become pay-as-you-go, with a free plan up front, so give or take $10 free credit and then pay-as-you-go after that. This gives people the ability to make an agent accessible by phone, not only by yourself but by your whole team, and all the phone calls lead to the same terminal that is watching the phone calls.

  I think we should first do this refactor. About the database, we of course don't have a database right now. But I think we can use a Cloudflare SQLite database for this, a very simple one, or maybe a durable object, if that's even easier. It doesn't really matter to me. You can choose. I think for now the only thing that we need is a user stable and an organization stable, and we already have the ability to send emails.

  One other thing that is important is that we need a logo. Please create a small, simple SVG logo with an S with dots in the center of each half circle of the S. The top half circle gets a dot in the middle, and the bottom half circle gets a dot in the middle. That's the screenless logo. Just be creative and make it look nice. Use your own judgment on the images you generate by looking at them and iterate a bit, so then we have a logo.

  After that, I want the logo to always show up with the name in a professional HTML-formatted email. Every email should have the name and the logo screenless. Also, the email should never, of course, contain Markdown like ` + "`**`" + ` for bold and stuff like that. It should always be HTML so it should be parsed nicely. Please pick that up too.

  Last but not least, I think if you invite your team members, it should be a simple HTML page, one page. I don't want multiple pages. The page should just list all your people that are already in there.
  There should be a plus button that allows you to add another person by email and phone. Phone should be optional, I guess. Maybe email should be the only one. It's way easier, especially for bigger teams that don't know everybody's phone number, and the phone number can be filled in.
  Scrap the above part where I said that we should let the user also fill in the phone number of the person they invite. We should only have the invite. Have the email, and when you click the accept link in your email, you have to fill in your phone number and verify that as well.
  We need to think about a way to make sure that if you fill in the wrong phone number, you can verify it, because you can't receive a text. If you clicked the invite already, it should still be possible to change it later. That's very important.
  Maybe also think about sending a reminder if you didn't verify your phone number. Maybe a day later, you should get a reminder email like, "Hey, please verify your phone number. You can get started." Only email.
  Make it very simple:
  - The invite page should show all the people who are part of the team.
  - The person who created the team should have the ability to remove and add people and change their role, like making them admin. Only admins can add and remove users.
  - There should be the ability to see invited people and when they were invited. If they have not accepted yet, they are still invited, so they should be able to be seen.
  - The invite could be valid for seven days. If it expires, it should still show that person and show that the invite has expired.
  These are basic features for an invite-only system, but the important part is only email. I wanted to only show it on a single page and make it look smooth with the screenless logo and everything.Besides the team page, I think there should be one other tab showing billing, and there you should have the regular billing features that you can control and only admins can control and see. For users, it's hidden. Users don't even go here, I guess, because they never manage it, so only for admins these two pages are visible. We don't need hiding logic or anything.
  On the billing page, just use the regular standard billing way to show:
  - how much credit you have used and how much you have left
  - maybe some statistics per day
  - maybe some statistics on who is calling the most, who's paying the most, and who's costing the most
  I guess the pricing should be about double the cost. Let's do it like that for now, at least. Standard billing feature`

- 18:00 — `One more thing. I think it's really important that we route the requests, like a proactive phone call from a person on the team, to the right terminal. Everyone that has a screenless CLI can log into their account and launch a watcher. It can also be multiple people in the team having a watcher on, right? I think we should have a way to decide which terminal to route to.
  I think the most simple starting point is:
  - If it's your own terminal, of course then it routes to your terminal.
  - If you have two terminals open, just route to only one of them. Just the first one, doesn't matter.
  - If a team member that isn't watching it himself is making a call, it needs to go to another team member. Doesn't matter, whoever has it open.
  That's it.`

- 18:12 — `Okay, one more feature request. When a user calls ScreenLess, it's always the Assistant. When the user calls ScreenLess, I think ScreenLess should pick up with a simple robot voice saying, "Press 1 to talk to the Assistant. Otherwise, just tell me or make your request." I guess that's better. You can just speak, and then the recording will be sent rather than you having a conversation with the Assistant. The Assistant would be the one that would normally call you. That would be the same context as it is now. If you don't press 1, you would just be able to make a recording, and it would be a request from the user to the agent, basically. I think that will be a lot better.`
  *(sent while the session was mid-build; two stray "Otherwise, just make your request." fragments arrived as interrupted messages around it)*

- 18:20 — `"Press 1 to speak to the assistant or start talking to make your request."`
  *(the exact greeting line for the inbound robot voice)*

- 18:26 — `One other thing that's very important is that if there is nobody currently with a terminal in the team with a watcher in the terminal, it's important that the next time anyone spawns the watcher, it looks for previous requests, handles them, is able to then fetch the transcripts for them, and handle them one by one or in parallel. The agent can make that decision. We don't need to say anything about parallel or not, because otherwise they get lost. They shouldn't get lost. That's very important.`

- 18:40 — `Another thing you can make part of the refactor: I don't really like that we have two workers, one api.screeners.sh and one screeners.sh. I think now that we also have actual frontend that is connected to the database, maybe we should just make it one worker and put the landing page in front. We can then have all the APIs on the same domain and subdomain, same subdomain, same domain with the main Apex screenless.sh, and then we can just remove the other worker, I guess, because everything lives there.`

- 19:05 — `Update the privacy section. Just make it seven days instead of 24 hours and just explain why. Also, please test the product more. You can drive in my browser for screenless. Let me know if you need any help for testing.`

- 19:35 — `when i tried changing the team name, i got 'admin only' is that a bug?`
  *(not a bug — the browser was signed in as the invited test member at that moment; it exposed the missing sign-out link, which was added)*

- 21:10 — `i just called the line and made a request, check the watcher`

- 21:15 — `i called, u did nothing`
  *(the two failed ring-ins found the real bug: TeXML never calls a Record's action URL when the caller hangs up — the recording is only announced via recordingStatusCallback, which was not set)*

- 21:18 — `called again, check it now`
  *(both post-fix calls transcribed, routed to the watcher, and billed — the inbound request path proven end to end)*

- 21:21 — `can yiu test if a proactive call lands in the watcher?`
- 21:22 — *(interrupted, corrected)* `can yiu test if a call from me to screenless lands in the watcher?`
- 21:24 — `i want u to wait for the watcher. that needs to be tested.`
  *(the 21:23 call landed in the agent-side watcher with the recording-URL fallback — a transient transcription failure, retries added)*
- 21:27 — `i already called but it didnt trigger the first watcher shell so smths's wrong`
  *(the user's own shell ran the 19 Aug CLI, which predates `watch`; their install was updated in place)*
- 21:33 — `I think you misunderstood me. I said at some point that the watcher should never stop, but of course that wouldn't bring it back to you. You should be activated when a new call enters. If it never stops, you will never be reactivated, right? This is a problem, and we should just go back to the old architecture where the watcher exits the moment it receives a transcript. That's the way it was, right?`
  *(reverses the never-ending default: `screenless watch` now always blocks until one call is delivered, prints it with WORK, and exits — the loop re-arming it is what never stops. The display+auto-ack mode and the --gate flag are gone.)*

- 21:36 — `ok testing it now with a real call, arm the waiter`
  *(the 21:34 ring-in woke the agent through the exiting watcher — the full loop live)*
- 21:40 — `perfect. can u once more go over all my feature requests and show in a table how far we are implementing`
- 21:48 — `move stripe out of testmode to real. also how's the codebase complexity? is there anything we could simplify? how many loc and where does this go?`
  *(Stripe blocked: the Chrome extension has no permission for dashboard.stripe.com, and account activation needs business details only the user may enter)*

- 22:02 — `also, i added the secrets ofr stripe`

- 22:05 — `wtf? i accepted the invite on wijnand@hyre.io but i didn't enter the right organisation, im in my own org now. also if i verify my phone and its already on another account i should be able to take it over and the phone from the other account should be disconnected.`
  *(first half was test residue — the agent's remove-member test had parked that account in a solo org and the invite link was already consumed; moved back by hand. Second half is a rule change: verifying a number takes it over — the OTP proves possession — and the old account loses the phone and its CLI sessions.)*

- 21:58 — `do all options. remove kv fully, it can all go to users table right?`
  *(all three simplifications: collapse the two work channels into the watcher, fold settings into users, delete the orphaned paid.html — plus the full KV removal: everything to D1 except the parked edition PDFs, which go to R2 because a 12MB attachment does not belong in a SQL row)*

- 22:08 — `hmm interesting does the move from kv to sql make it more complex? more lines, harder to read? how many tables does it add? is sql really needed or sis kv better?`
  *(answered mid-flight: slightly more lines — six new tables, ~250 lines of accessors — but one storage system instead of two, strong consistency exactly where "never lose a request" needs it, and the org queue stops being a maintained structure and becomes a query. Continued on that basis. Measured afterwards: net +65 lines across the product.)*

- 22:20 — `whats the diff btwn snake case rows and recordd shape?`
- 22:24 — `how many lines we could save without hte convention`
  *(~30–35 lines; the coercions and the INSERT column lists survive any naming, and the toll would move to the CLI's JSON API boundary rather than vanish)*
- 22:26 — `no leave it, commit and push.`
  *(decision: the snake_case column convention stays, mapping toll accepted)*

- 22:34 — `i dont like our html doesnt allow 'enter' for forms. fix that`
- 22:36 — `what is the cost per minute for calls for me?`
  *(30 cents per minute, billed per second on completed calls only)*
- 22:40 — `whats the COST at telnyx?`
- 22:44 — `think how much this would be used for a software dev te and how much the 30c/min could be`
- 22:50 — `i think this is fine for my aipilled target  audience.

  some big changes: i want the newspaper just once a week. it should land on saturday and should contain some changes from different team members and also looking ahead to open prs and things in the backlog. just giving an idea of the state of the product`
  *(the paper goes weekly: built on Saturday's run, landing Saturday morning; team-wide — who shipped what, by member — and forward-looking — open PRs and the backlog. The call brief stays nightly.)*

- 22:56 — `also i want the call if users cal screenless to not have the robotic voice, ever, just start recording immediately.

  if someone calls screeenless that isnt a user yet, they should get a robotvoice saying to install screenless first`
  *(reverses the press-1 menu from 18:12/18:20: a known caller hears only the record beep — the brief-by-ring-back path goes away with the menu — and only a stranger hears a voice, told to install screenless)*

- 23:12 — `the paper should be sent to the whole team`
  *(the weekly edition mails every member with a verified email — one send, all recipients; the post-call report stays personal)*

- 23:30 — `how can we make this secure? team members can now send instructions to the laptop running the listener, so its annoying if they get personal data to make fun or other things that might be annoying, abusing the system. what could they abuse? what might be a solution?`
  *(threat model: a teammate's spoken request executes on another member's laptop with that member's MCPs, browser and credentials — a confused deputy that broke the product's "the phone takes no action" principle at multi-user. Assessed abuse: exfiltration of personal data/secrets, destructive ops, impersonation, cost griefing. Recommended layers: (1) treat a teammate's request as data to surface not a command to run, (2) a hard never-list regardless of who asks, (3) loud attribution, (4) per-member rate cap.)*

- 23:34 — `2+3 pls`
  *(implement the hard never-list and loud attribution: the watcher marks a teammate request as untrusted with who sent it, and the skill forbids personal data, secrets, out-of-repo reads and unconfirmed irreversible ops for any routed request)*

- 23:44 — `is there a max duration of the recording? there shouldnt be`
  *(the Record ceiling was 5 minutes; raised to the platform max of one hour — effectively no limit, since a voice note ends on hang-up, #, or the silence timeout anyway)*

- 23:52 — `we need to rethink the value prop. is the landingpage still good?`
  *(assessment: the page is a solo pitch and the product went team; the team line, calling, and the team paper are invisible, and the cancel-via-Stripe-portal FAQ line is false)*

- 2026-08-22 00:05 — `fix the false lines and make it all about the team. thats the new product. btw the call via cli should also be able to call any,some or all team members. add that feature . this gives countless possibilities so therell be many more differnt uses for it yet to be discovered. the newspaper and the morning pr brief are just 2 of screenless's branded skills tht are great examples of what can be done with it, but anyone can make skills with this cli as tooling`
  *(the repositioning: screenless is a programmable voice layer for a team and its agents, not a PR-review app. The paper and the morning brief are two branded example skills; the CLI is the tooling anyone builds skills on. New feature: `screenless call` can dial any / some / all teammates, not only yourself — so the founding "only ever dials your own verified number" invariant widens to "only ever dials a verified number on your own team". Landing page rebuilt around the team and the tooling; the false Stripe-cancel line and the caller-is-always-you framing removed.)*
