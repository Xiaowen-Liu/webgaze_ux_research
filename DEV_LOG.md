# WebGaze — Engineering Journal

A webcam-based eye tracking extension for browser UX research.
No special hardware. Runs entirely in-browser. Open source.

**Goal:** Publish on GitHub as a portfolio piece demonstrating deep Chrome Extension (MV3) engineering, ML integration under security constraints, and real-time signal processing.

---

## Project Overview

| Item | Detail |
|------|--------|
| Stack | Chrome Extension MV3 · WebGazer.js (TF.js + FaceMesh) · Vanilla JS |
| Architecture | Popup → Service Worker → Offscreen Document (WebGazer) ↔ Content Script (renderer) |
| Key constraint | MV3 hard-blocks `eval()` / `Function()` at runtime — no manifest CSP override possible |
| Privacy model | All processing on-device. Zero video data leaves the browser. |

---

## Phase Log

### Phase 0 — Project Setup
*Decisions:*
- MV3 over MV2: future-proof, required for Chrome Web Store after Jan 2025
- Offscreen Document over content script injection for WebGazer: host pages (e.g. Wikipedia) have their own CSP that would block `tfhub.dev` model fetches. An extension offscreen page has its own extension-level CSP, bypassing host CSP entirely.
- WebGazer.js 2.x with TFFaceMesh tracker: best open-source webcam gaze estimation available; no server required.

---

### Phase 1 — Hitting the MV3 `unsafe-eval` Wall

**Problem:** WebGazer bundles `numeric.js`, which uses the `Function()` constructor at module load time to generate ~308 optimised math helpers (via `mapreduce`, `pointwise`, `Tbinop`, etc.). Chrome MV3 **hard-blocks** `Function()` / `eval()` in extension pages at the browser level — adding `'unsafe-eval'` to manifest CSP has no effect.

**Error:**
```
EvalError: Refused to evaluate a string as JavaScript
at offscreen/offscreen.html line 20203
```

**What didn't work:**
- `content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" }` — silently ignored by Chrome MV3
- Dynamically importing WebGazer — same CSP scope
- Loading WebGazer from a remote URL — blocked by `connect-src 'self'` default

**What worked — the patch strategy:**

Wrote `patch-webgazer.js` (Node.js):
1. Extract the numeric.js section from the 144,298-line webgazer bundle
2. Run it in Node (which permits `Function()`) with a shadow `InterceptFunction` that captures every generated function
3. Build a lookup map keyed by `JSON.stringify(args)` — 308 entries
4. Inject a "pre-patch block" before numeric.js in the bundle that installs `window.__numericPatchedFunction` (the cached lookup)
5. Rewrite every `return Function(` → `return (window.__numericPatchedFunction||Function)(` inside the numeric section

**Second eval issue (line 26305):**
After patching `Function()`, a separate IIFE still called `isFinite(eval('1'+op+'0'))`. Fixed by replacing with a precomputed operator table:
```js
// Before:
isFinite(eval('1' + numeric.ops2[k] + '0'))
// After:
({'+':1, '-':1, '*':1, '/':0, '%':0, ...})[numeric.ops2[k]]
```

**Outcome:** Zero `EvalError` messages. WebGazer loads and initialises in the offscreen document.

---

### Phase 2 — Offscreen Document Race Condition

**Problem:** Camera never opened on real pages despite no CSP errors.

**Root cause:** `chrome.offscreen.createDocument()` resolves as soon as the document is *created*, not when its scripts have *loaded and executed*. `webgazer.js` is ~6 MB — parsing and executing it takes 2–5 seconds. `OFFSCREEN_START` was sent immediately after `createDocument()` resolved, but `offscreen.js` hadn't registered its `onMessage` listener yet. The message was silently dropped.

**Fix — OFFSCREEN_READY handshake:**
```
background                          offscreen
   |                                    |
   |--- createDocument() ------------> |
   |                              [parses 6MB JS]
   |<-- OFFSCREEN_READY ---------------|
   |--- OFFSCREEN_START -------------->|
   |                              webgazer.begin() → camera opens
```

Implementation:
- `offscreen.js` sends `chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' })` after registering its listener
- `background.js` maintains a Promise resolved by `OFFSCREEN_READY`, with a 30s safety timeout
- `START_SESSION` handler `await`s this promise before calling `sendToOffscreen('OFFSCREEN_START')`

**Outcome:** Camera now opens reliably on first click.

---

### Phase 3 — Message Routing Cleanup

**Problem:** `popup.js` was sending `START_SESSION` directly to the content tab (a leftover from an earlier architecture). `content.js` doesn't handle this message type → `"Could not establish connection. Receiving end does not exist."` error on every session start.

**Correct flow:**
```
popup → background: START_SESSION      (only route for session lifecycle)
background → content: SHOW_CALIBRATION  (background drives content, not popup)
```

**Fix:**
- Removed redundant `chrome.tabs.sendMessage(tab.id, START_SESSION)` from popup.js
- Fixed `btnRecal` handler: previously sent `START_SESSION` to content tab (wrong); now sends `RECALIBRATE` to background, which clears WebGazer data via `webgazer.clearData()` in offscreen and re-sends `SHOW_CALIBRATION` to content

---

### Phase 4 — Prototype Calibration Click Bug

**Problem:** `webgaze-prototype.html` — camera opened but clicking calibration dots had no visual reaction (counter stayed at 0/5).

**Root cause 1:** `webgazer.recordScreenPosition(x, y, 'click')` throws if called before TFFaceMesh model has finished loading (async, can take 10–30s on first run). The uncaught exception aborted the rest of `onCalDotClick()`, so `dot.clicks++` and DOM updates never ran.

**Fix:** Wrapped `recordScreenPosition` in `try/catch` — errors are logged but don't block visual feedback.

**Root cause 2 (defensive fix):** WebGazer adds its own video/canvas elements to the DOM without `pointer-events: none`, potentially intercepting clicks before they reach calibration dots.

**Fix:** Added CSS:
```css
#webgazerVideoContainer,
#webgazerVideoContainer * { pointer-events: none !important; }
```

---

## Architecture Reference

```
┌─────────────────────────────────────────────────────────────┐
│  Chrome Extension (MV3)                                     │
│                                                             │
│  ┌──────────┐    messages    ┌──────────────────────────┐  │
│  │ popup.js │ ─────────────> │ background.js            │  │
│  │          │ <─────────────  (service worker)           │  │
│  └──────────┘   GET_STATE    └──────┬───────────────────┘  │
│                                     │                       │
│                          ┌──────────▼──────────┐           │
│                          │ offscreen.js         │           │
│                          │ (extension page)     │           │
│                          │                      │           │
│                          │  WebGazer.js         │           │
│                          │  └─ TFFaceMesh       │           │
│                          │  └─ Ridge Regression │           │
│                          │  └─ Webcam access    │           │
│                          └──────────┬───────────┘           │
│                                     │ GAZE_POINT            │
│                          ┌──────────▼──────────┐           │
│                          │ content.js           │           │
│                          │ (injected in tab)    │           │
│                          │                      │           │
│                          │  Calibration UI      │           │
│                          │  Gaze dot            │           │
│                          │  Heatmap canvas      │           │
│                          │  AOI dwell tracker   │           │
│                          └──────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

**Why offscreen document?**
Host pages like Wikipedia, GitHub, and most SPAs set strict `Content-Security-Policy` headers that block `connect-src tfhub.dev`. WebGazer must fetch its TFLite FaceMesh model from tfhub.dev at startup. Running WebGazer in an extension offscreen page sidesteps the host CSP entirely — the offscreen page operates under the extension's own CSP.

---

## Open Questions / Next Phases

- [ ] **Phase 2 — Backend** (optional): Node/Express + SQLite for multi-session persistence and cross-participant aggregation
- [ ] **Phase 3 — AOI Builder**: Point-and-click AOI definition overlay on the tracked page
- [ ] **Phase 4 — Participant flow**: Consent screen, session code, async researcher review
- [ ] **Phase 5 — Results dashboard**: Per-session heatmap replay, fixation path, AOI comparison
- [ ] **Tests**: At minimum, unit tests for the message routing layer and heatmap accumulator

---

## Key Decisions Log

| Decision | Alternatives considered | Reason chosen |
|----------|------------------------|---------------|
| Offscreen Document for WebGazer | Content script injection, iframe | Offscreen page has extension CSP, avoids host page CSP. Content scripts share host page origin and CSP. |
| Patch webgazer.js at build time | Fork WebGazer, use a different library | Patching is reproducible (node script), doesn't require forking a complex ML codebase |
| EMA smoothing (α=0.22) | Kalman filter, median filter | EMA is O(1), adds ~0ms latency per frame, tunable with one parameter |
| Ridge regression (WebGazer default) | Neural network regression | Ridge is fast to update per click, works with 5 samples/dot × 9 dots = 45 training points |
| 9-point calibration | 5-point, 16-point | 9-point covers screen corners + edges + centre; good accuracy/effort tradeoff |
| OFFSCREEN_READY handshake | Retry loop, fixed delay | Handshake is deterministic; a fixed delay is fragile on slow machines |

---

*Last updated: 2026-06-15*
