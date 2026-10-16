# Electron IPC listener verification, 2026-10-16

[#4390](https://github.com/morluto/rea/issues/4390), existing
[#4389](https://github.com/morluto/rea/pull/4389), umbrella
[#4027](https://github.com/morluto/rea/issues/4027).

All 24 final IPC regressions pass, and real draw.io operation phases succeed.
Every real capture still **fails overall provider cleanup**. These are distinct
results; neither completed-task acceleration nor token savings is established.

## Producing boundary and regressions

The existing PR `efd452948` was integrated with main `180ba03bf` in `5c3b02468`.
It fixes removal through the caller's original function and duplicate recording
of `once` invocations. Independent review found two further producing-boundary
problems: wrapper recognition evaluated caller `.listener` getters, and a copied
`removeAllListeners` snapshot loop differed from native live-array traversal when
removal observers prepended a listener.

Both new differential cases failed on that implementation (14 passed, two
failed). Fix `3c330f259` delegates traversal to Node, translating only owned `on`
wrappers at `removeListener`, and preserves the `off` alias. Descriptor reads
avoid evaluating getters. A further Proxy case exposed that descriptor reflection
can itself run a trap (16 passed, one failed); `2fb7f5523` uses Node's Proxy
identity first and removes the superseded catch. Those initial **17 cases** pass;
the later decorator finding and final 23-case validation are recorded below.
The native EventEmitter controls are semantic regressions, not real-app proof.

The change uses weak wrapper keys, removes the copied traversal and its snapshot
allocation, and adds no tool, cache, schema or normal reply field. Related
compiled provider/service modules and catalog metadata are byte-identical to
main. This does not prove arbitrary function introspection equivalence: custom
`.listener` properties and raw wrapper re-registration retain the limitations
documented in [Electron observation](../electron-observation.md).

## Unchanged real application and observed scenario

Official [draw.io Desktop 32.4.1](https://github.com/jgraph/drawio-desktop/releases/tag/v32.4.1)
AppImage SHA-256 is
`c687a9f1ddcaa146b78547452d264c03c2afcf125639cba5deeb65f3e9554c9e`;
both the release asset digest and published checksum file match. Its unchanged
62,941,673-byte ASAR is
`e64b9650c0b8241ca9a7d33b56386a385bceee63270cec701d3a467347b697e6`.
Complete accompanying resources were extracted; no application source was edited.

Public fuse inspection reports the official executable's Inspector fuse disabled.
No vendor Inspector attempt was made. The following trials explicitly select
generic Electron **44.7.0**, Xvfb and fresh profiles; they establish no packaged
runtime compatibility.

The real renderer initially displays an **Invalid file data** dialog. A public
CLI startup smoke and independent DOM/argv probes preserve this failure, tracked
separately in [#4494](https://github.com/morluto/rea/issues/4494). Its exact cause
is not proven. Two attempts to click a palette item without handling the dialog
timed out and were cancelled; they remain failed diagnostics. An initial helper
also incorrectly queried `application.process()` after transport closure; the
corrected helper retains the original ChildProcess handle instead.

The final scenario uses declared REA clicks to dismiss that actual error and
insert a visible palette item, then waits for rendering. Independent DOM reads
confirm SVG elements **0 → 2**, disappearance of the error and the real unsaved
changes indicator. The verifier exercises the real app callbacks and channels;
the production hook wraps their registration as described above.
The source also registers `app-load-finished` through both `once` and `on`;
recording its once callback twice adds a spurious event.

## Initial fixed-source ABBA observations

Verifier/source revision is `d02cc934c`; its hashes were recorded before all four
trials. Baseline is main `180ba03bf`. The same script, runtime, artifact and
declared actions run in the order baseline, candidate, candidate, baseline.

| Variant/run | IPC events | `app-load-finished` | SVG change | Pipeline wall s | Family CPU s | Peak cgroup bytes |
| ----------- | ---------- | ------------------- | ---------- | --------------- | ------------ | ----------------- |
| Baseline 1  | 8          | 3                   | 0 → 2      | 11.084          | 6.270053     | 560,615,424       |
| Candidate 1 | 7          | 2                   | 0 → 2      | 11.135          | 6.395461     | 550,383,616       |
| Candidate 2 | 7          | 2                   | 0 → 2      | 11.898          | 6.907123     | 525,631,488       |
| Baseline 2  | 8          | 3                   | 0 → 2      | 11.469          | 6.526674     | 558,456,832       |

Every declared action completed, every insertion oracle passed, and no verifier
deadline fired. Every provider returned `cleanup_failed`; the captures remain
partial/failed, including possible dirty-editor teardown and the known Linux
ownership gap [#4282](https://github.com/morluto/rea/issues/4282). Baseline 2 also
reports Xvfb temporary-directory cleanup failure (payload exit 5). Its directory
identity was not captured; no broad path-based deletion was attempted.

Runs are serial on CPU 10 with one-CPU quota, 8 GiB hard memory, 6 GiB early
stop, no swap and 192 tasks. Counters cover the cgroup family at payload exit
while the observer remains alive; they are **not final whole-scope counters**.
Memory includes file cache, not RSS. Some scopes still contain Xvfb at that
point; all recorded scopes were later independently confirmed inactive/dead.
External recovery does not establish provider cleanup.

OS/build caches are uncontrolled; these are first/repeat fresh-process runs,
not verified cold/warm system pairs. Two samples per variant and a cleanup-bound
failed workflow cannot establish a speedup. Token billing, peak agent context,
complete schema/call costs and actual MCP-wire parity are unmeasured. Fewer
events alone do not establish lower token cost.

Full static checks passed (two tasks, no cache hits): 89.441 s wall,
88.630288 family CPU s and 4,337,172,480 peak cgroup bytes, with no OOM.
Documentation checks also passed (6 tasks plus five README consistency cases).
The [selected JSON record](electron-ipc-listeners-2026-10-16.json) retains exact
source/input identities, failed attempts, coverage, IPC and resource receipts.
Historical diagnostic helper hashes were not captured and remain explicitly
unknown; the frozen hash is not assigned to them retrospectively.

## Reproduction

Build both pinned checkouts. Under the existing resource observer and a private
Xvfb instance, use the committed helper for each runtime root in ABBA order:

```sh
node experiments/analysis-efficiency/drawio-electron-lifecycle.mjs \
  --runtime-root /absolute/pinned-checkout \
  --executable /absolute/electron-44.7.0/electron \
  --application /absolute/drawio/resources/app.asar \
  --profile-root /absolute/temporary-profiles --dismiss-error \
  --selector '.geSidebar a.geItem:visible >> nth=0'
```

The helper returns failure on incomplete provider cleanup. This shared-service
probe does not establish successful public CLI/MCP workflows. App images,
extractions/profiles and full Result files are regenerable and excluded from Git.

## Review follow-up: normalization before app decorators

Fresh review of `f3bb9b9ed` found that translation inside a patched
`removeListener` happened after an application's outer decorator had already
seen the recording wrapper. Two native controls reproduced this with stable and
replaced decorators (17 passed, two failed).

`c8c494b5c` delegates the original Node traversal through a private forwarding
receiver. It shares the real emitter's live state and translates owned `on`
entries **before** invoking the current application removal method. App methods
and getters receive the real emitter; read-only method properties remain valid.
Native once entries pass unchanged. The public `removeListener`/`off` patches
are removed. Five decorator variants pass: stable, replaced, read-only, getter
and Proxy.

An additional mutation case proved that reading a changed public `.listener`
getter before delegation also changed deletion timing (22 passed, one failed).
Final source `5a094a0df` retains canonical removal targets in the weak owner
registry. Only unchanged data links are translated; changed getters run when
Node performs removal, preserving the exception and state transition. All
**23 cases** pass, including the original retention/fatal-error coverage.

The same frozen draw.io verifier was reused. The follow-up ABBA attempt ran
its first baseline, then the resource launcher refused the other three requests
because 8 GiB plus its 4 GiB host reserve was unavailable. Those are **not
executed**, with no performance measurements. The final source was separately
admitted and completed dialog recovery and insertion with seven IPC events;
overall cleanup still failed, and Xvfb teardown also returned an error. No new
completed-task speedup or cold/warm pair is claimed.

Final static checks passed: two uncached tasks, 135.173 s wall, 133.786166 family
CPU s and 4,274,634,752 peak cgroup bytes, no OOM. The JSON record appends exact
source pins, denial logs, final real-app/public cleanup diagnostics and checks
under `review_followup`; the initial records were not overwritten.

## Callback invocation and remaining raw-metadata limitation

Source `514b73b78` invokes `handle` callbacks through captured `Reflect.apply`,
preserving the receiver and actual arguments without reading an app-defined
`.call` property. The added direct-call control and hook case pass; all **24
IPC regressions** pass (3.661 s wall, 3.404 family CPU s, 318,291,968 peak cgroup
bytes, no OOM). This is a Node boundary check, not a real Electron handle claim.

An initial three-case experiment incorrectly assumed native EventEmitter avoided
callable method-property reads. Its `on` and `once` controls themselves failed;
they do not demonstrate hook regressions. The attempted intrinsic event-call
change was reverted and those invalid cases removed. Both failed runs remain
in `callable_followup`; no successful result is assigned to them.

The same unchanged draw.io verifier at this source completes actual dialog
recovery and shape insertion, with seven IPC events, SVG elements 0 → 2 and an
unsaved-changes indicator. Overall provider cleanup still fails. Pipeline wall
time is 12.610 s, family CPU 7.062834 s and peak cgroup memory 634,187,776 bytes;
there is no paired performance or token claim. All recorded scopes were later
independently inactive/dead, which does not establish provider cleanup.

Fresh review also found a distinct remaining metadata case: changing a raw
recording wrapper's writable `.listener` property can make an app decorator
reject removal. A production-hook/native-Node probe reproduces this (plain:
removed; hook: decorator throws and one listener remains). Exact reproduction
and the ownership conflict are tracked in [#4513](https://github.com/morluto/rea/issues/4513).
No affected real app has been identified. Removing the descriptor guard alone
does not make native removal match the mutated wrapper; temporarily rewriting
public app metadata would add further visible mutations. This limitation is
explicit in the observation guide and is not represented as fixed by this PR.

Current-source static checks also pass: two uncached tasks, 92.912 s wall,
92.031383 family CPU s and 4,340,375,552 peak cgroup bytes, no OOM.
