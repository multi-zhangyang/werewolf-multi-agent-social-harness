# Society — Cinematic Observation Theater · Design System Report

> A premium, Vercel-inspired "observation theater" for live multi-agent social simulations.
> Grounded against the actual codebase (`src/components/society/*`, `src/styles.css`, `src/society/contracts.ts`). UI text is zh-CN; keep it.

---

## 0. Executive summary — the core thesis

The app already has the right bones: `#0a0a0a` base, `white/[6%]` borders, `Geist`, a 3-column stage, a mind-inspector Sheet, and an SSE stream with `agent.delta` / `agent.thought` / `agent.tool` / `agent.status` events. What makes it feel like a *lab bench* is three things, and they are the whole redesign:

1. **Uniform "card with a 6% border" everywhere** — no hierarchy of what's a *stage* vs. a *control panel*. Cinematic UIs build one dominant focal surface and de-chrome everything else.
2. **Status is a spec, not a performance** — "思考中" text + a dot where there should be a *visible performance* (streaming text, a "casting" animation, presence rings). The data (`activity`, `agent.thought`) is already piped in and unused.
3. **Scores/scores-only reveal** — the payoff of "watching a show" is *anticipation and reveal*. Role flips in Werewolf, the bid being unsealed in the auction, the defection in Prisoner's Dilemma are dramatic beats that should be animated moments, not text rows in a "history" tab.

**The one-sentence direction:** "This is a broadcast, not a dashboard." — a neutral, quiet stage where the *agents* are the only thing that glows.

---

## 1. Vercel's visual language — exact tokens & patterns

### 1.1 The palette (already ~90% present)

Vercel's dark product surface is **near-black neutral with white-on-black hairlines and white type**, letting a *content* accent (for them their logo triangle / partner colors; for us *agent-exclusive* accents) carry the color.

| Token | Vercel recipe | Your current | Recommendation |
|---|---|---|---|
| Page base | `#000` → `#0a0a0a` | `oklch(0.085 0 0)` ≈ `#0a0a0a` ✅ | Keep |
| Raised surface | `#0a0a0a`→`#111` (never a gray "card") | `--card: oklch(0.115 0 0)` | Use **less** often; reserve `bg-white/[0.015-0.03]` for panels, keep the *stage* at pure base |
| Hairline border | `rgba(255,255,255,0.08)` | `--border: oklch(1 0 0 / 11%)` = `white/11%` | Tighten to **`white/8%`** globally; `white/6%` for inner dividers |
| Text primary | `white` → `#fafafa` | `--foreground` ✅ | |
| Text secondary | `#888` / `#a1a1a1` | `--muted-foreground: oklch(0.64)` | |
| Accent | *content-driven* | emerald (live) | ✅ — keep emerald as the *system/live* accent, and give each **agent** its own hue |

**Concrete change to `src/styles.css`:**

```css
:root {
  --background: oklch(0.085 0 0);        /* keep */
  --foreground: oklch(0.985 0 0);        /* keep */
  --card: oklch(0.13 0 0);               /* raise from 0.115 for lighter contrast */
  --muted-foreground: oklch(0.62 0 0);   /* slightly dimmer */
  --border: oklch(1 0 0 / 8%);           /* 11% → 8%, the Vercel hairline */
  --input: oklch(1 0 0 / 12%);
}
```

### 1.2 Glass / backdrop-blur header (the signature move)

Vercel's nav sits over scrolling content as a translucent, blurred bar with an 8% bottom hairline — exactly what `room-view.tsx:37` does. The upgrade is *uniformity + shorter contrast*:

```tsx
<header className="sticky top-0 z-20 border-b border-white/[0.08] bg-[#050505]/70 backdrop-blur-2xl backdrop-saturate-150">
```

Notes:
- `bg-[#050505]/70` (darker + more transparent) reads more "cinematic" than `#0a0a0a/85`.
- Add `backdrop-saturate-150` so colors popping behind the bar don't look muddy.
- Use `backdrop-blur-2xl` (24px) on the header, `backdrop-blur-xl` (12px) on dropdowns/selects.

### 1.3 Gradient text (headline moments)

Vercel hero headlines use a **top-lit white → gray vertical gradient** with `tracking-tight`. Your landing already ships it (`landing.tsx:53`) — reuse it, don't over-color:

```tsx
<h1 className="bg-gradient-to-b from-white via-white to-zinc-500 bg-clip-text text-transparent">
  Society
</h1>
```

Add a **reserved** accent variant for *rewards/reveals* (score deltas, role flips, winner announcement), never for body copy:

```css
/* silver-hot for "the winner" */
.text-reveal {
  background-image: linear-gradient(180deg, #fff 0%, #e4e4e7 55%, #71717a 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
```

### 1.4 Pill buttons

Vercel buttons are **fully rounded capsules** with a hairline border, transparent fill, and a subtle fill-on-hover. They *never* use hard rectangles for navigation. Already used well in `room-view.tsx` (Share/Pause). Standardize:

```tsx
<Button
  variant="outline"
  size="sm"
  className="rounded-full border-white/10 bg-white/[0.02] px-4 text-zinc-300
             transition-colors duration-200 hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
>
  <Pause className="size-3.5" /> 暂停
</Button>
```

Primary CTA stays **inverted white-on-black** with an in-subtle active press:

```tsx
<Button className="rounded-full bg-zinc-50 text-zinc-950 hover:bg-white
                   active:scale-[0.98] transition-transform">
  开始一场博弈 <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
</Button>
```

### 1.5 Micro-interactions (subtlety is the brand)

- **Links/rows**: `transition-colors` only on hover; translate `-translate-y-0.5` reserved for "this is liftable" (scenario cards), never for data rows.
- **Icon nudges** on arrow-on-right rows: `group-hover:translate-x-0.5` (already in `landing.tsx:117`).
- **Focus**: `focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0` — hairline, not the default colored ring.
- **Press**: `active:scale-[0.98]` on pill CTAs.
- **Never** animate color on text (only on backgrounds/borders) — color-flash readouts feel like dev tools.

### 1.6 Announcement / marquee bar

Two Vercel patterns map here:

- **Dismissible announcement pill** under the header (e.g. "观众模式 · 观看身份已隐藏，不影响游戏"):

```tsx
<div className="mx-auto mt-4 flex w-fit items-center gap-2 rounded-full
                border border-white/[0.08] bg-white/[0.02] px-4 py-1.5 text-xs text-zinc-400">
  <span className="live-pulse size-1.5 rounded-full bg-emerald-400" />
  观众模式 · 全程只读
</div>
```

- **Ticker/marquee for world-phase transitions** ("第 2 轮 · 夜晚" sliding through the stage top). Use a pure-CSS marquee (no JS), paused on `prefers-reduced-motion` (already wired in `styles.css:133`):

```css
.marquee-track {
  display: flex;
  width: max-content;
  animation: marquee 24s linear infinite;
}
.marquee:hover { animation-play-state: paused; }
@keyframes marquee { to { transform: translateX(-50%); } }
```

```tsx
<div className="marquee overflow-hidden border-y border-white/[0.06] bg-white/[0.015]">
  <div className="marquee-track gap-8 py-2 font-mono text-xs text-zinc-500">
    {/* duplicate content 2× for a seamless -50% loop */}
    {[0, 1].map((k) => (
      <span key={k} className="flex gap-8">
        <span>R2 · 夜晚</span><span>·</span><span>女巫行动</span><span>·</span>
        <span>预言家查验</span><span>·</span><span>狼人合谋</span>
      </span>
    ))}
  </div>
</div>
```

---

## 2. Live multi-agent activity — patterns borrowed from the field

### 2.1 What the field actually does (and what to steal)

**ChatGPT / OpenAI agent views** — stream the internal monologue as *buttery, dimmed italic-ish text* in a collapsed "Thinking…" block, then replace it with the finished message in a single motion. The lesson: **don't annotate activity; depict it**.

**Claude Artifacts / Anthropic** — a distinct *artifacts pane* for the "deliverable" with its own header and border; conversation stays clean. Lesson: **world-state/artifact pane is visually distinct, not another card**.

**LangGraph Studio** — node graph with *active-edge highlight* and a node that glows while its agent streams. Lesson: **the active agent is a glowing node, everyone else is dim**.

**OP.GG / Twitch overlays / esports HUD** — this is the most important reference for *spectator* UX:
- Player cards = *presence tiles* with avatar, name, and a status chip (they use "LIVE"/level; you use `speaking`/`thinking`/`acting`).
- Scoreboards animate the *delta* (a `+2` pops and floats/fades), not the whole row.
- Reveals (pick/ban, ultimatum) are **full-bleed moments** with a delay, not inline text.

### 2.2 Agent presence indicator (the core primitive)

Replace the current flat `StatusDot` (a 6px dot) with a **presence ring → avatar glow system**. State is already available: `AgentStatus` = `lobby | thinking | acting | speaking | idle | finished | error`, plus live `activity[actorId]`.

**Presence ring** (on the avatar, connotative of a live performer):

```tsx
function PresenceRing({ status }: { status: AgentStatus }) {
  const live = ["thinking", "acting", "speaking"].includes(status);
  const tone =
    status === "speaking" ? "ring-emerald-400" :
    status === "thinking" ? "ring-sky-400/70" :
    status === "acting" ? "ring-amber-400/70" :
    status === "finished" ? "ring-zinc-600" : "ring-transparent";
  return (
    <span className={cn("inline-flex rounded-xl p-px", live && "ring-2 ring-offset-2 ring-offset-background", tone)}>
      {/* avatar inside */}
    </span>
  );
}
```

Key hierarchy decision: **the ring color is the agent's live perception** — `speaking` (emerald, they are on air) > `thinking` (cool blue, private) > `acting` (amber, a tool/action). Idle = no ring = quiet. This gives a glanceable "who is on air right now" read with zero text.

### 2.3 Streaming thought / typing indicator

`agent.thought` events carry `specialist` (`reflection | mind-read | plan`) + `delta`; `agent.delta` is the public stream. **Show both, but tier them**:

- **Public speech** (a message is being composed): stream into a *live* message bubble with a blinking caret so it feels like the agent is talking on the record.
- **Private thought** (`agent.thought`, a deliberation): show in a dimmed mono block with a "正在思考" header and an auto-reveal affordance — this is your biggest untapped "watch the machine think" asset.

```tsx
function ThoughtStream({ activity }) {
  const state = activity[agentId];
  if (!state?.text) return null;
  return (
    <div className="rounded-2xl rounded-tl-sm border border-sky-400/15 bg-sky-400/[0.04] px-4 py-3">
      <p className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-sky-300/70">
        <Brain className="size-3" />
        {label} {/* 策略反思 / 洞察他人 / 制定策略 */}
      </p>
      <p className="font-mono text-xs leading-5 text-zinc-300">
        {state.text}
        <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-zinc-400" />
      </p>
    </div>
  );
}
```

**Streaming text caret** — the universal "live model" signal, pure CSS:

```css
.stream-caret::after {
  content: "▋";
  margin-left: 1px;
  color: rgb(255 255 255 / 0.45);
  animation: caret-blink 1s steps(1) infinite;
}
@keyframes caret-blink { 50% { opacity: 0; } }
```

### 2.4 Message-by-agent timeline with avatars

Current `MessageRow` is good but group-level. Upgrade toward **actor-aligned lanes** (Twitch-channel style) without giving up the single chronological feed:

- **Keep chronological order** (this is a show, order matters) but add a **"speaking" anchor** at the top when an agent is live:

```tsx
<div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-400/15
                bg-emerald-400/[0.04] px-3 py-2">
  <PresenceRing status="speaking" />
  <span className="text-xs font-medium text-emerald-200">{name} 正在发言</span>
  <Waves /> {/* 3 bars animating = "on air" */}
</div>
```

- **Group consecutive messages** from the same agent (chat-app pattern): one avatar, stacked bubbles — reduces noise during an agent's "monologue".
- **Avatar distinctness**: the current palette (`shared.tsx:17`) is a gradient per index. Keep index→hue stable, and also tint each agent's *name* with a faint hue for scanability: `text-zinc-100` but a `border-l-2` in the agent color on their message bubbles.

### 2.5 Private vs public vs team messaging

The data already distinguishes `SocialChannel = public | private | team` (`contracts.ts:5`) and `ChannelBadge` renders it. Upgrade the *styling* so channel reads at a glance without badges:

| Channel | Current | Recommended |
|---|---|---|
| `public` | white/[6%] border, white/[3%] bg | Neutral surface, **full opacity** — the "record" |
| `private` | violet/[6%], badge | Violet left rule + **dashed/inset border** + `recipientIds` shown as tiny avatars, slightly reduced opacity (whisper) |
| `team` | rose/[6%] | Rose tint + a `阵营` chip; **most visually distinct** because it's the most plot-relevant secret |

```tsx
const channelStyles = {
  public: "border-white/[0.06] bg-white/[0.02]",
  private: "border-violet-400/20 bg-violet-400/[0.05] opacity-90",   // whisper
  team: "border-rose-400/25 bg-rose-400/[0.06]",                       // secret
} as const;
```

Add a **recipient chip row** for private messages (instead of the current `→ N 人` text), using mini `AgentAvatar size="sm"`:

```tsx
{message.recipientIds?.length ? (
  <div className="mt-2 flex items-center gap-1.5">
    <span className="font-mono text-[10px] text-violet-300/70">私发给</span>
    {message.recipientIds.map(id => (
      <AgentAvatar key={id} name={nameOf(id)} index={indexOf(id)} size="sm" />
    ))}
  </div>
) : null}
```

### 2.6 Phase / round progress (the "act" structure)

Treat each `world.phase` (轮/turn) as an **act marker**, not a pill. A **cinematic act divider** that splits the timeline (bigger than the current `LogEntry` hairline):

```tsx
<div className="my-8 flex items-center gap-4">
  <div className="h-px flex-1 bg-gradient-to-r from-transparent to-white/15" />
  <div className="text-center">
    <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-600">第 {turn} 轮</span>
    <span className="mt-1 block text-sm font-medium tracking-tight text-zinc-300">{phase}</span>
  </div>
  <div className="h-px flex-1 bg-gradient-to-l from-transparent to-white/15" />
</div>
```

Round progress in the header — swap the `R{turn}/{totalTurns}` pill for a **segmented act bar** (film-strip metaphor):

```tsx
<div className="flex items-center gap-1">
  {Array.from({ length: totalTurns }).map((_, i) => (
    <span
      key={i}
      className={cn(
        "h-1 rounded-full transition-all duration-500",
        i < turn ? "w-5 bg-zinc-300" : i === turn ? "w-5 bg-emerald-400" : "w-2 bg-white/10"
      )}
    />
  ))}
</div>
```

### 2.7 Live scoreboard (HUD, not table)

Current `ScoreCard` is a normalized-bar list — clean but static. Make it **delta-animated** (the OP.GG move):

- Keep a ref of previous scores; when a score changes, render a floating `+n` that rises and fades.
- Sort is instant `transition-all`, but **rank changes** get a swap highlight.

```tsx
function ScoreDelta({ delta }: { delta: number }) {
  if (!delta) return null;
  return (
    <span key={delta} className={cn(
      "ml-2 inline-block animate-[score-pop_900ms_ease-out] font-mono text-xs",
      delta > 0 ? "text-emerald-300" : "text-rose-300"
    )}>
      {delta > 0 ? `+${delta}` : delta}
    </span>
  );
}
```

```css
@keyframes score-pop {
  0%   { opacity: 0; transform: translateY(6px); }
  15%  { opacity: 1; transform: translateY(0); }
  70%  { opacity: 1; }
  100% { opacity: 0; transform: translateY(-8px); }
}
```

Leader highlight: top rank gets an amber Crown (already present in `participants.tsx:67`) — add a **gradual gold wash** on the leader row: `bg-gradient-to-r from-amber-400/[0.06] to-transparent`.

### 2.8 Reveal animations (the money shot)

Role reveals / eliminations / auction unseals / defection flips are the emotional beats. Build one reusable `RevealMoment` and use it for: Werewolf role flip, night-kill reveal, bid unsealing, PD move reveal, ultimatum response.

**Pattern: dim everything → a centered oversized glyph/card → fade in → resolve.** Framer-motion-free, pure CSS:

```tsx
function RevealMoment({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-300",
        open ? "opacity-100" : "opacity-0"
      )}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" /> {/* dim the stage */}
      <div className={cn(
        "relative scale-50 opacity-0 transition-all duration-500 ease-out",
        open && "scale-100 opacity-100"
      )}>
        {children}
      </div>
    </div>
  );
}
```

Role flip specifically:

```tsx
<RevealMoment open={flipActive}>
  <div className="text-center">
    <AgentAvatar name={name} index={i} size="lg" className="mx-auto" />
    <p className="mt-4 text-sm text-zinc-400">身份揭晓</p>
    <p className="mt-1 text-4xl font-semibold tracking-tight text-white">{role === "wolf" ? "狼人" : roleName}</p>
  </div>
</RevealMoment>
```

For **score reveal**, mirror the count-down "price is right" beat with a `key`-remount animation (`animate-[reveal-up_500ms_ease-out]`).

---

## 3. shadcn/ui — which components fit, and how to compose a stage

Stack is already correct: `shadcn/new-york`, `radix-ui`, `lucide-react`. Component fit:

| Component | Use | Notes |
|---|---|---|
| `Sheet` | **Agent Mind Inspector** (keep) + optional "spectate settings" side sheet | widen to `sm:max-w-lg` for the richer mind view; add `side="right"` with a top actor header |
| `Dialog` | Create-room (keep) + confirm-leave | add `DialogOverlay` `bg-black/80 backdrop-blur-sm` for theater feel |
| `Tooltip` | Model names, score tooltips, channel explanation | keep; add `sideOffset` so tooltips don't cover avatars |
| `Tabs` | World-panel (scores/activity/history) | keep `variant="line"`; see 3.2 |
| `Badge` | Status, channel, count chips | already well-used |
| `ScrollArea` | Timeline + mind sheet | **critical**: add `[&>[data-radix-scroll-area-viewport]]:scroll-py-6` and mask fades top/bottom for the "broadcast feed" look |
| `Avatar` | Agent faces | keep gradient fallback; add presence ring wrapper |
| `Skeleton` | Loading / "casting" placeholders | replace blank loading with a **"招幕中 / casting"** shimmer |
| `Separator` | Act dividers | currently hand-rolled `h-px`; centralize in `Separator` for consistency |
| `Progress` | Round progress | swap for segmented act bar (2.6) |
| `DropdownMenu` | Header overflow (share/pause/language) | fine as-is |

### 3.1 The "stage" layout recipe (concrete)

```tsx
<div className="flex min-h-screen flex-col bg-[#050505] text-zinc-100">
  {/* Top hairline "curtain" bar — the only chrome that reads as chrome */}
  <header className="sticky top-0 z-20 border-b border-white/[0.08]
                     bg-[#050505]/70 backdrop-blur-2xl backdrop-saturate-150">
    {/* logo · live-pill · act bar · actions */}
  </header>

  <div className="mx-auto grid w-full max-w-[1400px] flex-1
                  grid-cols-1 gap-4 px-4 py-4
                  lg:grid-cols-[280px_minmax(0,1fr)_360px]">
    {/* Stage (center) — NOT a card: it's the void everything performs against */}
    <main className="min-w-0 rounded-2xl border border-white/[0.06]
                     bg-[#080808] shadow-[0_0_60px_-15px_rgba(255,255,255,0.06)]">
      <Conversation />
    </main>

    {/* Wings — de-chromed; border removed, just breathing room + a column rule */}
    <aside className="order-first border-r border-white/[0.06] lg:pr-4">
      <ParticipantsRail />
    </aside>
    <aside className="border-l border-white/[0.06] lg:pl-4">
      <WorldPanel />
    </aside>
  </div>
</div>
```

The key move vs. today: **remove the `bg-white/[0.015]` + border from the side panels** so they read as *part of the same surface* as the stage, while only the stage holds the single border + inner glow. This is the biggest single shift from "three lab cards" → "one stage".

### 3.2 World-panel tabs → "broadcast tabs"

Keep `Tabs` but style the list as broadcast switcher chips:

```tsx
<TabsList className="justify-start gap-1 bg-transparent p-0">
  {["scores", "activity", "history"].map(t => (
    <TabsTrigger key={t} value={t}
      className="rounded-full border border-transparent px-3 py-1 text-xs
                 data-[state=active]:border-white/10 data-[state=active]:bg-white/[0.04]
                 data-[state=active]:text-zinc-100">
      {t}
    </TabsTrigger>
  ))}
</TabsList>
```

### 3.3 Open-source shadcn examples to mirror

- **shadcn's own `/themes` + `v0` gallery** — canonical hairline + backdrop-blur + `white/8%` borders; the "New York" style you already use.
- **Aceternity UI** (`aceternity.com`) — the "aurora background" and `sparkles`/`hero-parallax` primitives, useful to port (as CSS) for the *stage floor* glow and a landing aurora.
- **Magic UI** (`magicui.design`) — `AnimatedList` (scoreboard order swaps), `ShimmerButton`, `NumberTicker` (animated score count-up) — all tiny, dependency-light, Tailwind-idiomatic; direct wins for §2.7.
- **Penpot / Craft UI templates** — for the "broadcast console" panel proportions (3-column, thin rails).
- Ship as **CSS-only** re-implementations to avoid adding `framer-motion` to an SSE-heavy loop.

---

## 4. Motion — tasteful, performant, SSE-safe

You already have `tw-animate-css` (CSS keyframe utilities that apply on scroll/entry) — **stay framer-motion-free**. Framer's spring physics is overkill here and its re-renders churn under rapid SSE updates; CSS `@keyframes` run on the compositor thread.

### 4.1 Performance rules for a high-frequency SSE feed

1. **Never animate layout (width/height/margin)** on message insertion — only `transform` + `opacity`. Use `translate` for entrances, not `mt-*`.
2. **Contain the re-render**: memoize `MessageRow`/`ParticipantCard` with `React.memo`; the only node that should re-render each delta is the single active agent's bubble.
3. **Throttle `agent.delta`** rendering with `requestAnimationFrame` batching (or a 30–50ms rAF flush) — you already cap deltas at 480 chars; add rAF so a 60-token burst paints once per frame:

```ts
// add to use-room: flush activity state on rAF
const raf = useRef(0);
const scheduleFlush = () => {
  cancelAnimationFrame(raf.current);
  raf.current = requestAnimationFrame(() => setActivity(flush));
};
```

4. **`content-visibility: auto`** on off-screen timeline rows and `contain-intrinsic-size` for the feed so long histories don't cost paint.
5. **Bail on `prefers-reduced-motion`** — already in `styles.css:133`; extend it to kill infinite-loop animations entirely (toggle `.live-pulse` / marquee / caret off).

### 4.2 Pulsing live dot (refine the current)

Current `live-pulse` scales and fades — good, but add a **halo** for the "on air" states:

```css
.on-air {
  position: relative;
}
.on-air::after {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: 9999px;
  border: 1px solid rgb(52 211 153 / 0.5);
  animation: halo 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
@keyframes halo {
  0%   { transform: scale(0.6); opacity: 0.9; }
  70%  { transform: scale(1.6); opacity: 0; }
  100% { transform: scale(1.6); opacity: 0; }
}
```

### 4.3 Card / message entrances

Messages should *arrive on air*, not pop. One shared utility:

```tsx
.enter-stage {
  animation: enter-stage 360ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes enter-stage {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
```

Apply **only to newly appended** messages (track the last index), never on initial mount of history — otherwise initial paint staggers everything.

`tw-animate-css` supplies the same via `animate-in fade-in-0 slide-in-from-bottom-2` for entry-on-scroll/conditional rendering.

### 4.4 Score change (count-up)

For the "scoreboard" alone, a short count-up adds broadcast energy. CSS-only `@property` version (GPU-friendly, no JS timer):

```css
@property --n { syntax: "<integer>"; initial-value: 0; inherits: false; }
.tally {
  --n: 0;
  counter-reset: n var(--n);
  animation: tally 600ms ease-out forwards;
}
.tally::after { content: counter(n); }
@keyframes tally { to { --n: 100; } }
```

(For actual integration, you'd set `--n` from the score on each change via inline style and re-key to restart.)

### 4.5 The "casting / 招幕中" shimmer (loading → theater)

Replace the blank skeleton with a shimmering "casting" slate for the pre-live moment:

```tsx
<div className="relative flex min-h-56 items-center justify-center overflow-hidden rounded-2xl border border-white/[0.06]">
  <div className="absolute inset-0 animate-[shimmer_2s_linear_infinite]
                bg-[linear-gradient(110deg,transparent_40%,rgba(255,255,255,0.06)_50%,transparent_60%)]
                bg-[length:200%_100%]" />
  <p className="relative font-mono text-xs uppercase tracking-[0.3em] text-zinc-600">招幕智能体中</p>
</div>
```

```css
@keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
```

---

## 5. Typography — a cinematic Geist scale with mono accents

Two typefaces, one rule: **Geist carries the drama (big, tight, high-contrast); Geist Mono is the operator/telemetry voice (small, uppercase, tracked-out).**

### 5.1 The scale

| Role | Class | Size / weight |
|---|---|---|
| Hero / reveal title | `text-6xl sm:text-8xl font-semibold tracking-tighter` | 60–96 / 600 |
| Section title | `text-2xl font-semibold tracking-tight` | 24 / 600 |
| Phase / act headline | `text-3xl font-medium tracking-tight text-zinc-50` | 30 / 500 |
| Body / message | `text-[15px] leading-7 text-zinc-200` | 15 / — |
| Secondary | `text-sm leading-6 text-zinc-400` | 14 / — |
| Label (eyebrow) | `text-xs font-medium uppercase tracking-[0.18em] text-zinc-500` | 12 / 500 |
| Mono telemetry | `font-mono text-xs tracking-tight text-zinc-500` | 12 / — |
| Mono micro-label | `font-mono text-[10px] uppercase tracking-widest text-zinc-600` | 10 / — |

**Mono accents** are reserved for *systems trivia*, never for a human/agent's words: timestamps, token counts, turn `R{n}`, phase codes, scores, energy `%`, model names, `→ N 人` recipient counts. This is what separates "theater" (agents speak in Geist) from "telemetry" (the machine's metadata is mono).

### 5.2 Keep it "cinematic" — tightening rules

1. **`tracking-tight` on all display sizes** (`tracking-tighter` at ≥ display-xl). Tight tracking reads expensive/cinematic; loose tracking reads information.
2. **`text-balance`** on landing paragraphs and reveal copy (`landing.tsx:56` already does).
3. **Uppercase + wide-track** for all structural labels (参与者 / 实时局势 / section eyebrows) — already the established `tracking-[0.18em]`; standardize to `[0.18em]` everywhere (some files use `[0.2em]`).
4. **Cap line-length**: messages `max-w-prose` so nested replies don't run edge-to-edge on the 1400px stage.
5. **Number alignment**: use `tabular-nums` (`font-variant-numeric: tabular-nums`) on scores/energy so live-updating values don't jitter.

```css
.nums { font-variant-numeric: tabular-nums; }
```

### 5.3 Agent naming / voice

Since agents have a `voice` field (`contracts.ts:43`), display distinctions stay *typographic*: each agent's display name in **`text-zinc-50 font-medium`**, but their **streamed thoughts in the same font at lower weight + dimmer color** (authorial voice vs. quoted thought). Never set agent names in mono.

---

## 6. Quick win checklist (ordered by impact ÷ effort)

1. **De-chrome the wings** (§3.1): remove card borders/bg from the two side panels → instant "stage" read. *(1 file, high impact)*
2. **Presence rings** (§2.2): wrap `AgentAvatar` with `PresenceRing`, state already available. *(shared.tsx + participants.tsx)*
3. **Stream the thought** (§2.3): render `agent.thought` into a dimmed mono block in the timeline — you already receive the deltas. *(conversation.tsx + use-room.ts already has partial plumbing)*
4. **Act dividers + segmented act bar** (§2.6): replace phase pill + `LogEntry` hairline. *(room-view + conversation)*
5. **Channel styling** (§2.5): private = inset whisper + recipient avatars, team = rose secret. *(shared.tsx ChannelBadge + conversation.tsx)*
6. **Score delta pop + count-up** (§2.7 / §4.4): *(world-panel.tsx)*
7. **`RevealMoment`** (§2.8): one component, four+ scenario beats. *(new file, wire into history/events)*
8. **rAF batching + memo** (§4.1): *(use-room.ts)*
9. **Tokens tighten** (§1.1): `--border` → `white/8%`. *(styles.css)*
10. **Landing aurora + marquee** (§1.6): *(landing.tsx)*

---

*Note on research method:* live `web_search` was unavailable in this sandbox (API-key auth error), so §1–2 are rebuilt from the shipped codebase plus established knowledge of the referenced systems rather than fresh screenshots. If you want, re-run the search once the key is valid to screenshot-verify Vercel's exact current nav/border values and the OP.GG scoreboard micro-interactions; the concrete recipes above are safe to implement regardless.
