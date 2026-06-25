# Video thinning — design outline

> Status: DESIGN ONLY. Nothing here is implemented yet. This is the shared
> picture we agree on before writing code.

## Why

Today retention just **deletes** the oldest video once we pass 16 GB (~7 hours
of full-res). Thinning instead **keeps a sparser copy** of old footage so the
history reaches much further back — you trade temporal resolution for reach.

## The core idea: cascading keyframe thinning

Every level is the previous level with **only 1 of every 30 frames kept**, and
since our GOP is 30 frames, "1 of 30" lands exactly on keyframes (which decode
standalone). So each level is just a sequence of keyframes, played back at the
normal 30 fps — which makes it fly through time 30× faster than the level below.

| Level | Kept                     | Speedup vs real | **Time per 1s of playback** | One frame every |
|-------|--------------------------|-----------------|-----------------------------|-----------------|
| L0    | everything (30 fps)      | 1×              | 1 second (real-time)        | 1/30 s          |
| L1    | keyframes (1/s)          | 30×             | **30 seconds** (½ min/s)    | 1 s             |
| L2    | every 30th L1 frame      | 900×            | **15 minutes**              | 30 s            |
| L3    | every 30th L2 frame      | 27 000×         | **7.5 hours**               | 15 min          |
| L4    | every 30th L3 frame      | 810 000×        | **~9.4 days**               | 7.5 hr          |

We label levels in the UI by **time-per-second** ("15 min/s"), never by the raw
factor ("900×") — the former is intuitive, the latter is not.

Generation **cascades**: L1 is built from L0, L2 from L1, etc. Each level reads
only the (small, already-thinned) level below it, and keeps pace with live
capture — so a level is fully built from its source long before retention
deletes that source. Cascade is *required* (not just an optimization): a high
level spans more real time than the levels below it retain, so it can only be
built by sampling the level directly beneath it.

### Each thinned level is stored as normal 30-frame GOPs (re-encoded)

A thinned level is **not** a pile of loose keyframes. We take **30 sampled
frames** from the level below and **re-encode them into one ordinary 30-frame
GOP** (1 IDR + 29 P-frames). That keeps every level in the exact same on-disk
shape as L0 (`.data` + `.idx`, one record per GOP), keeps it compact (P-frames
instead of 30 standalone IDRs), and lets it play back through the existing
pipeline unchanged. One L-level GOP plays in ~1 second and covers `30 ·
interval(L)` of real time (L1 GOP = 30 s, L2 = 15 min, L3 = 7.5 h, …).

## Budgets — total / 5, equal per level

The whole disk budget is split **evenly into 5** (one share per level L0–L4).
With today's 16 GB that's **~3.2 GB per level**. Each level enforces its own
rolling retention (drop its oldest GOP files when its share is full).

Because higher levels are exponentially denser in *time per byte*, equal byte
budgets give exponentially growing reach:

- L0 share → ~hours of real time
- L1 share → ~days
- L2 share → ~weeks–months
- L3 share → ~years
- L4 share → decades (effectively infinite)

> Tradeoff to note: splitting evenly shrinks **full-res** L0 from ~7 h (16 GB) to
> ~1.4 h (3.2 GB). That's the cost of reaching back further. Easy to retune the
> split later if L0 feels too short.

The UI shows, **per level**: **capacity** (real time it can hold) and **used so
far** (real time it currently holds) — including L0, the unthinned root. (Exact
capacities depend on measured average keyframe / re-encoded-GOP size; the level
table is structure, not final numbers.)

## Generation — inline, cascading, in the keyframe worker

Generation lives in the **same worker that already decodes keyframes** (today's
activity worker, extended). At the point where it processes new GOPs, it also
decides, per level, whether the next thinned frame is due:

- **State:** per level, the timestamp of the last frame emitted into the current
  group. Recovered at startup by reading the **tail of each level's most recent
  index** — no need to hold full indexes in memory.
- **Sampling is by time:** level L accepts the next source frame whose timestamp
  is ≥ `lastEmit(L) + interval(L)`. Time-based (not count-based) so gaps in
  footage don't drift the cadence.
- **Building a GOP:** once 30 frames are gathered for level L, decode them,
  re-encode into one 30-frame GOP, and write it (data + index record) to level
  L. To gather those 30 frames the worker reads them from the level-below
  **past indexes** — which for L4 reach back ~10 days. That history read is both
  how it *fetches the frames* and how it *knows the next frame is due*.
- **Ramp-up is automatic:** a level simply can't emit a GOP until its source has
  30 frames at the required spacing — so high levels stay dormant until there's
  enough history, with no special-casing. (We still cap the number of levels at
  ≈L4; beyond that reach already exceeds the camera's lifetime.)

## Storage granularity scales with the level

L0 buckets files by **hour** (`Y/MM/DD/HH.*.data`). If thinned levels did the
same, an L3 file would hold ~0.1 GOPs — nonsense. So the file/folder bucket
**coarsens one calendar step per level**, which lines up almost perfectly with
the 30× cascade and keeps ~thousands of GOPs per file:

| Level | GOP span | File bucket | Path (under data root) | ~GOPs / file |
|-------|----------|-------------|------------------------|--------------|
| L0    | 1 s      | hour        | `Y/MM/DD/HH.*.data`    | 3600         |
| L1    | 30 s     | day         | `_thin/L1/Y/MM/DD.*`   | 2880         |
| L2    | 15 min   | month       | `_thin/L2/Y/MM.*`      | 2880         |
| L3    | 7.5 h    | year        | `_thin/L3/Y.*`         | ~1200        |
| L4    | 9.4 d    | year        | `_thin/L4/Y.*`         | ~40          |

- The record's timestamp stays **full-precision ms** — only the *file bucket*
  coarsens. So seek precision within a level is still one GOP = `30^L` real
  seconds, which is the natural seek granularity for that level.
- The **UI reflects this**: the navigation/seek step and the span you view at a
  given level match its granularity (you scrub a day at L0, but a month or a
  year at higher levels), instead of forcing every level into a day view.
- Retention deletes whole file buckets per level (a month of L2, a year of L3) —
  coarse, but fine within each level's budget.

## Activity is preserved at every level

Every record keeps activity — at thinned levels as **two summary stats: average
and max**, rolled up from the source frames that GOP represents (mean of the
sources' averages, max of their maxes). So the activity chart still works when
you're scrubbing a thinned level, just summarized.

## UI — what the user sees / does

- A **level switcher**, labeled by time-per-second (real-time, ½ min/s, 15 min/s,
  7.5 hr/s, …). Switching level re-views the same point in time at that density.
- For any point in time, the app loads **whichever level index files overlap it**,
  so it knows which levels actually have data there and offers only those.
- A **capacity/usage readout** per level: real-time held vs. real-time capacity.

## Open questions to settle during build

1. **Re-encode path.** The HW encoder is busy with live capture (codec
   contention), so thinned GOPs likely re-encode in **software** (x264) on spare
   cores — 30 frames per GOP, infrequently, so the load should be small. Confirm
   once measured.
2. How the trackbar/navigation rescales when you're at a high level that spans
   far more than one day (today's nav is day-scoped).
