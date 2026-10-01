# User guide

This guide explains what each screen is for and how to do the common jobs, role by role. Operators should also read `docs/OPERATOR_GUIDE.md`.

## What the numbers mean (read this first)

- The product records **work evidence**: plans, task changes, confirmed time, evidence, blockers and recaps. It does not watch screens, keystrokes or audio.
- **Logging coverage** tells you how complete the records are. It is not a productivity measure.
- **Unknown time** is time with no record. It is never treated as idle.
- There is **no single productivity score and no ranking of people**. Lists of people are alphabetical.
- Every assessment, forecast and observation shows its **facts and assumptions**. When there is not enough data it says *Insufficient data*; days with no capacity (holidays, leave) show *Not applicable*.
- Suggestions, forecasts and patterns are **rule-based**. Optional AI drafting only runs when your organization has turned it on, and you always confirm a draft before it is saved.

## Who sees what

| Role | Main screens |
|---|---|
| Employee | My Day, Tasks, Projects, Daily recap, My Analytics (Report and Trends), Templates, My weekly reviews, Objectives, Calendar & leave, Recurring work, Integrations |
| Manager | Everything an employee has, plus Team routine, Team capacity (and What-if), Weekly team review, Blocker escalation, Insights, Client updates, Automations (team rules) |
| Main admin | Daily Routine for all employees (founders per company policy), Weekly team review and Insights for the whole company, Blocker escalation, Leadership |
| Leadership | Leadership, Objectives (create and edit), Insights (group totals only), Team capacity and What-if, Profitability (hours; money needs the cost viewer role), Client updates |
| Cost viewer | Profitability with money figures, project budgets, cost rates |
| System admin | Administration (organization, people, teams, branding, escalation policy, audit, jobs), company Automations, holiday import |
| Client | Client portal only: their projects, shared tasks and published updates |

People often hold several roles; you see the union of their screens.

## Employee

### Plan the day (My Day)

1. Open **My Day**. Pick up to three outcomes you intend to finish today.
2. For help choosing, press **Suggest my day**. It ranks your own open work and shows why: overdue, due soon, in progress, carried over, priority, and whether the estimate fits your remaining hours. Blocked, in-review and waiting work is set aside with the reason. Press **Use these** to take the proposal; outcomes you already chose are kept.
3. The capacity check tells you whether the estimates fit your scheduled time and how many outcomes have no estimate.
4. If you change the plan later, give a reason; the change stays visible in your recap and report.

**Reminders.** By default you get an in-app reminder to plan your day (shortly after your scheduled start, only if nothing is planned) and to confirm your recap (near the end of your schedule). Switch either off under **My Day → Reminders**. You never get reminders on holidays, leave or non-working days.

### Capture work

- Press **Q** (or use the command palette, **⌘K / Ctrl+K**) and type one line, for example `Reconcile bank #FIN !high @meera /finance fri 2h`. `#` is the project key, `!` the priority, `@` the owner, `/` the category; dates and durations are recognised. Check the proposed fields, then create.
- **Offline:** if you lose the connection, quick capture switches to **Save offline**. The item waits on your device and syncs when you are back online (or press **Sync now**). A strip under the header shows how many captures are waiting and lets you fix or discard any that failed.
- **Voice:** if your organization allows it, press the microphone in quick capture and speak. Your browser turns speech into text; you check the parsed line before creating. This product stores no audio.

### Work through the day

- Change a task's status with one click. A dialog only appears when a reason is needed (blocked, cancelled, reopened).
- **Blocked?** Record the reason, the cause, who you are waiting on and the next follow-up date. On the task, the blocker card shows its age in working days and the next escalation step, if your organization uses escalation.
- **Nudge:** if a blocker waits on a colleague, press **Nudge** on the blocker card to send them a reminder (once a day per blocker).
- Start the optional timer, or add time manually. Only you can correct your own time.

### Recap the day

Open **Daily recap**, check what happened, edit where needed and **Confirm**. Corrections after confirming need a reason and create a new version. If you did no work, or it was a non-working day, say so; that is different from a missing recap.

### Weekly summary

On **My Day**, press **Weekly summary** to see your week: outcomes accepted, carryovers, blockers and what is due next week. You can edit the text and copy it (for example into a status message). Edits are not saved.

### Read my analytics and trends

- **My Analytics → Report:** day, week, month or custom period. It shows intended vs accepted outcomes, carryovers, time by category, coverage, unknown time, blockers, deadlines and recommendations, with an explained assessment. Download PDF or CSV.
- **My Analytics → Trends:** 8, 12 or 26 weeks of your own records: planned completion, accepted outcomes, coverage, unknown time, blocked time, meeting share, focus time (runs of 60+ minutes on one task), fragmentation, carryover, estimate accuracy and recap completion. Switch between charts and a table. The pattern review offers gentle, rule-based observations about your own records, never comparisons with others. Weeks of leave are *Not applicable*; today is left out until it is over. Download CSV.

### Use a template

Open **Templates**, pick a playbook (for example *New employee onboarding*) and press **Apply**. Choose the start date and project, assign each step, check the preview (due dates skip weekends, holidays and leave; warnings appear if a step falls before one it depends on) and create. Applying the same request twice does not create duplicates. You can also create private templates of your own, or save a project's tasks as a template.

### Plan "what if" for yourself

Open the command palette and choose **What-if planner** (managers also find it on **Team capacity**). Add changes such as leave, a new deadline or extra work, and see which tasks would finish late. Nothing is saved to your real tasks. You can save scenarios; only you can see them.

### Respond to a weekly review

When your manager reviews your week you get a notification. Open **My weekly reviews**, read the note and reply. Reviews never change your recaps or time.

### Calendar

- **Bring meetings in:** on **Integrations → My work calendar**, upload an .ics export or paste your calendar's **secret iCal address** under *Subscribe by address*. Meetings that have ended appear as suggestions on My Day; nothing is recorded until you confirm.
- **See your work in your calendar app:** on **Integrations → Calendar feed**, create a feed address and add it to Google, Outlook or Apple Calendar as a subscription. It contains only your task due dates, today's outcomes and your leave. The address is shown once; treat it like a password. **Rotate** gives you a new address and stops the old one; **Revoke** turns it off.
- **Record leave** under **Calendar & leave**.

### Install the app

On a phone, use the browser's **Add to Home Screen**; on a desktop, use the browser's install button in the address bar. The installed app opens straight to My Day and has shortcuts to Tasks and Daily recap. On small screens, navigation moves to a bar at the bottom. When a new version is out, the app offers **Reload**.

When you sign out, the app warns you about captures that have not synced yet, then removes them and the app's stored files from the device.

## Manager

### Follow your team's day

**Team routine** shows each team member's plan, progress, blockers and recap. Open a person to see their timeline and report. You can ask for clarification, add a review note, acknowledge, request a follow-up or offer help. You never overwrite what someone submitted.

### Weekly team review

1. Open **Weekly team review** and pick the week.
2. Each card shows one person's week from their report: assessment with facts and assumptions, outcomes, carryovers, coverage, unknown time, blockers, deadlines and recaps. People are listed alphabetically; there is no ranking.
3. Use the filters (needs attention, missing recaps, blocked, not reviewed).
4. For each person choose **Acknowledge**, **Mark discussed** or **Needs follow-up** (optionally creating a follow-up task for them), with a note. They are notified and can reply.
5. Export the team week as CSV or PDF.

You get a reminder each Monday.

### Insights

**Insights** shows team analytics over 4, 8 or 12 weeks or a custom range: KPI tiles with change against the previous period, trend charts (with a table view), blocker causes, cycle time and a workload table (alphabetical, labelled as load). Observations describe groups of three or more, never single people. A definitions section explains every metric. Export CSV.

### Blockers and escalation

**Blocker escalation** lists your team's open blockers by age in working days, who they wait on and the next escalation step. It lists blockers, not people.

### Capacity and what-if

**Team capacity** shows load, estimate coverage, leave and a "Projected late" column. Press **What-if** to test changes (leave, reassigning a task, moving a deadline, changing an allocation, adding work) and see the effect per person and per task before deciding. Results list their assumptions, for example the time assumed for unestimated tasks. "Unclaimed capacity" is a planning figure, not idleness.

### Team automations

Open **Automations** and create a team rule: choose a trigger (for example *task status changed to blocked*), add conditions, and up to six actions (notify, create follow-up, set priority, set reviewer, add checklist item, add comment, assign). Start from a preset recipe if you like. Press **Test against a task** to see exactly what would happen; the test changes nothing. Team rules only affect tasks owned by people you manage. The run log shows what each rule did.

### Company templates

Managers can create and edit company templates that everyone in the organization can apply.

### Client updates

If you own a client project, see **Client updates** below under Leadership.

## Main admin

The main admin (the *routine_admin* role) sees every employee's recorded routine; founders are included only if the company policy allows it.

- **Daily Routine:** filter by date, employee, department, project, or recap and assessment status, then drill into a person's timeline and report.
- **Weekly team review** and **Insights** cover the whole company. Insights includes per-person workload rows, alphabetical and labelled as load.
- **Blocker escalation** shows company-wide blocker aging.
- The main admin is one of the escalation steps: you are notified when a blocker reaches the last step.

## Leadership

### Leadership view

**Leadership** shows delivery and capacity across projects, plus the objectives overview with forecasts.

### Objectives

1. On **Objectives**, create an objective with an owner, period and description.
2. Link milestones (their tasks give the *linked work* progress) and add key results with a current and target value.
3. The forecast is *On track*, *At risk*, *Off track* or *Insufficient data*. It compares progress with time elapsed and recent pace, and shows the reasons, facts and assumptions. Nothing is guessed: missing data is listed.
4. Owners post check-ins with a confidence level. Confidence is shown for context only and never changes the computed status.
5. Owners are notified when the weekly status turns *At risk* or *Off track*.

### Insights

Leadership without the main admin role sees **group totals only**. Groups smaller than three people are withheld so individuals cannot be singled out.

### What-if

Leadership can simulate changes for anyone, from **Team capacity → What-if** or the command palette.

### Client updates

1. Open **Client updates** and choose a client project.
2. Create a draft for the period. It is built only from work marked visible to the client (shared tasks completed, milestone progress, upcoming shared work). Add a short summary and remove items you do not want to show.
3. Check the client preview, then **Publish**. Client users get a notification in the portal; nothing is emailed.
4. To withdraw an update, **Unpublish** it with a reason.
5. Optionally switch on **Prepare drafts every Friday**: drafts appear on Friday afternoons for you to review. They are never published automatically.

### Profitability (hours)

Without the cost viewer role you see **hours only** on **Profitability** and on project budget cards.

## Cost viewer

- **Profitability** lists projects with budget, cost to date, revenue and margin (where applicable), burn rate over four weeks, forecast at completion and status. Each figure shows its facts and assumptions. Hours from people without a cost rate are listed separately so you can add the missing rates; they are never priced at zero.
- **Set a budget:** on a project page, open the **Budget** card and choose fixed fee, time and materials (needs a bill rate) or internal; enter the amount, hours, currency, dates and alert thresholds (default 75, 90 and 100%). You need to be the project owner, leadership or a system admin as well.
- **Alerts:** you are notified once when a threshold is crossed. Changing the budget re-arms the alerts.
- **Cost rates:** maintained under Administration → People.
- Export the portfolio or one project as CSV or PDF.

## System admin

Day-to-day setup is in `docs/OPERATOR_GUIDE.md`. The screens are:
- **Administration → Branding:** organization name, accent colour (must be readable with white text) and logo.
- **Administration → Escalation:** the blocker escalation ladder and its timings.
- **Automations:** company-wide rules.
- **Calendar & leave → Holidays → Import:** load public holidays from an .ics file or address; preview, then confirm. Existing holidays are never overwritten.
- **Administration → Organization:** visibility policy, voice capture and other settings.

## Client

1. Sign in; you land on **Projects** in the client portal.
2. Each project card shows milestones, tasks shared with you and the published updates.
3. Open an update to read it, or download it as a branded PDF.

You only ever see your own organization's projects and updates that have been published to you.
