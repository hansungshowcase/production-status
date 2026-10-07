# Hansung Production Status Design System

## 1. Atmosphere & Identity

Hansung Production Status is a quiet factory command screen: fast to scan, practical, and focused on the next action. The signature is a white and light-blue operations surface with clear numeric emphasis for production status.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Surface/primary | --surface | #FFFFFF | #0F172A | Cards and header surfaces |
| Surface/background | --bg | #F4F7FB | #020617 | App background |
| Surface/secondary | --surface2 | #EEF3F8 | #1E293B | Secondary panels |
| Text/primary | --text | #0F172A | #F8FAFC | Headlines and key numbers |
| Text/secondary | --text-mid | #475569 | #CBD5E1 | Body and labels |
| Text/muted | --text-dim | #64748B | #94A3B8 | Captions and helper text |
| Border/default | --border | #D8E1EC | #334155 | Card borders and dividers |
| Accent/primary | --blue | #2563EB | #60A5FA | Primary actions and info |
| Accent/hover | --blue-dark | #1D4ED8 | #93C5FD | Hover state |
| Accent/subtle | --blue-light | #EFF6FF | #1E3A8A | Soft info backgrounds |
| Status/success | --green | #059669 | #34D399 | Successful production states |
| Status/error | --red | #DC2626 | #F87171 | Delays and blocking problems |

### Rules
- Use the shared CSS variables from `src/styles/variables.css`.
- Use blue for information, green for success, red for missed due dates.
- Do not introduce decorative colors for operational metrics.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Display | 32px | 900 | 1.15 | 0 | Main hero and large KPIs |
| H1 | 26px | 900 | 1.2 | 0 | Header title |
| H2 | 22px | 800 | 1.25 | 0 | Card titles |
| Body/lg | 18px | 800 | 1.3 | 0 | Primary actions |
| Body | 16px | 500 | 1.6 | 0 | Descriptions |
| Body/sm | 14px | 600 | 1.45 | 0 | Metric labels |
| Caption | 12px | 700 | 1.4 | 0 | Metadata and badges |

### Font Stack
- Primary: system UI, Apple SD Gothic Neo, Malgun Gothic, sans-serif.

### Rules
- Numeric KPIs use strong weight and compact line height.
- Korean labels must remain readable at mobile width.

## 4. Spacing & Layout

### Base Unit
All spacing derives from a base of 4px.

| Token | Value | Usage |
|-------|-------|-------|
| --space-1 | 4px | Dense pagination gaps |
| --space-2 | 8px | Compact gaps |
| --space-3 | 12px | Card internal gaps |
| --space-4 | 16px | Standard card padding |
| --space-5 | 20px | Comfortable card padding |
| --space-6 | 24px | Desktop gaps |

### Grid
- Max content width: 1280px.
- Mobile layout is single column.
- Desktop role cards use two equal columns.

### Rules
- Keep the first viewport action-focused.
- KPI cards must not push primary entry actions out of reach.

## 5. Components

### Home Entry Card
- **Structure**: full-width button with icon, title, description, and CTA.
- **States**: hover lift, active press, visible text contrast.
- **Accessibility**: button semantics and readable Korean labels.

### Home KPI Strip
- **Structure**: one full-width panel with four numeric cells.
- **Variants**: loading, data, error.
- **Spacing**: 12px mobile gap, 16px desktop gap.
- **Accessibility**: text labels and numbers, no color-only meaning.

### Home Secondary Action
- **Structure**: full-width compact action directly below the role cards.
- **Surface**: `--surface` background, `--border` outline, and primary-blue icon/focus ring.
- **States**: default, hover lift, active press, and visible keyboard focus.

### Work Instruction Receipt Handover
- **Boundary**: completing `도면설계` sends the order to `작업지시서 수령 대기`; it never starts laser, V-cutting, or a skipped process. On the laser station this is a separate region above the actionable queue, and only `작업지시서 받음` moves an eligible order into the ordinary laser waiting list after refresh.
- **States and copy**: show a contained loading state, `받을 작업지시서가 없습니다.` empty state, inline request error with `다시 시도`, saved-success toast, and inline permission/action errors. A failed pending request must not hide or block the ordinary laser queue. The region explains that receipt confirmation is not laser start.
- **Identity and action**: the receipt action follows the existing worker identity confirmation. Its button is at least `--control-min-height` (44px), has explicit disabled/loading states, and the server remains authoritative for the narrow receiver allowlist.
- **Sales read-only expression**: `/sales/my` shows `작업지시서 전달 대기` or the first receiver and receipt time in both the card summary and expanded detail. Legacy laser-active or completed orders without a genuine receipt record show no receipt banner or receipt detail. It does not expose a receipt action. Fresh list state wins over an older expanded-detail response.
- **Responsive and motion**: use existing spacing, color, radius, and surface tokens. Receipt rows remain contained at 320px/375px and stack the full-width action below copy on mobile. Long client/product text wraps without horizontal overflow. Existing reduced-motion behavior applies; no new required animation is introduced.

### Materials Status Dashboard
- **Structure and order**: after the sticky header, keep the successful sheet time and short scope line visible in at most two 12px lines, show any refresh warning immediately after, then the urgency panel, the three-column stage board, search and the native six-value filter, and a shared result-plus-disclosure row before grouped companies. The disclosure is a 44px scope/exclusion control and the shared row has no trailing gap; at max-width 360px stage buttons use zero horizontal padding to preserve the dominant-number unit. The urgency panel is `입고 기록 우선 확인` with prominent overdue/today counts, review count, completion state, and an explicit arrival-unconfirmed action when applicable. Scope/exclusion details stay in the disclosure rather than duplicating warnings in the first viewport.
- **Urgency summary**: overdue/today counts come only from `summarizeArrivalCheckNeeds` (`O` and `T`); zero counts say `기준일 지난·오늘 미체크 0건` and never imply a normal state. Review count is the sum of company `review_order_count` values and stays separate as `일정·원본 확인 Rv건`; review and the 44px arrival action share a naturally wrapping footer row. Show `모든 단계 완료 기록 확인` only when `N>0`, all three stages have `C=N`, and `Rv=0`; empty data says `표시할 대상 없음` and `검색 또는 업체 상태를 변경해 주세요`. `입고 미확인 업체 보기 →` invokes the existing arrival incomplete filter without claiming it filters only urgent records.
- **Stage board**: title is `단계별 완료 미확인 · 업체 보기`; fixed order is `발주서 수령`, `자재 발주`, `자재 입고` with visible 1/2/3 markers. Each button emphasizes `M=U+R`, shows `M` in one inline-flex baseline-aligned nowrap hierarchy with a 28px number and 14px `건` unit, and shows `완료 C/N` with only the ratio kept unbroken. It preserves the cumulative C/U/R bar and full counts in its accessible label, and shows `미체크 U` plus `확인필요 R` only when review exists. Positive M cards omit the repeated `미확인` label because the board title supplies that meaning. Positive maximum M ties show `최다`; the stage order remains fixed. Zero-target stages show zero counts, `대상 없음`, and an empty bar; `M=0` shows `전체 완료`. No funnel, arrow, lock, unique-order sum, or physical-problem implication is added. Below the board, explain `미확인 = 완료 기록을 확인할 수 없는 주문` and `입고 기준일 = 납기 7일 전 · 단계 간 중복 집계`.
- **Scope disclosure**: the existing source title/tab, exact range, exclusion/retained counts, `입고 기준일 = 납기 7일 전 · 미체크 = 완료 여부 미확인`, and `체크일: 시트 기록 날짜 · 연도 없으면 월/일` stay in a native disclosure with a 44px target. Company card structure, ordering, representative order/date pair, raw values, and existing search/filter/more behavior remain unchanged.
- **Fixed scope and shipping overlay**: `fetched_at` is the successful CSV-download instant and the only KST scope anchor. The inclusive start is three calendar months earlier with month-end clamping. Invalid, blank, and yearless order dates and future dates stay excluded. After the existing order-date and shipping exclusions, orders with a valid full-year due date at least five calendar days before the KST query date are excluded; invalid, missing, and yearless due dates remain for review. The exclusion count covers only this added due-date rule and never double-counts shipping or old-order exclusions. Every API request, including a CSV cache hit, performs a fresh read-only app-order lookup. Only a globally unique direct app ID or a globally unique exact legacy fingerprint may mark that one sheet product as app-shipped; unmatched and ambiguous rows remain visible. Public data contains only safe match state and aggregate counts, never matching phone, dimensions, or fingerprint values.
- **Deadline semantics**: the `입고 기준일` is exactly seven calendar days before a valid full-year work-order due date, calculated with UTC calendar ordinals. Missing, yearless, invalid, and due-before-order dates are review states. A valid deadline earlier than its order date is retained and explained as `발주 시점에 입고 기준일 경과`. Arrival `미체크` means completion could not be confirmed, not that work is unfinished. The inline reminder counts only unchecked arrival orders with a valid deadline: past `입고 미체크 · 기준일 N일 지남`, today `입고 미체크 · 오늘 기준일`, and future `입고 미체크 · 기준일까지 N일`. Confirmed arrivals do not contribute. Do not claim physical shortage or delay.
- **Priority and ordering**: one company has exactly one emphasized state and edge color: red unchecked/past, orange unchecked/today, blue invalid/raw-status/ambiguous-match review, neutral unchecked/future, or green `전체 입고 확인`. Companies sort in that rank order. Past, today, and future ranks use the earliest relevant deadline; review uses review-order count then arrival-unconfirmed count descending; all-arrival-confirmed uses earliest valid due date; Korean company name is the stable final tie. The representative order always comes from the selected rank, and its due/`입고 기준일` remain one pair. Calculation failures name the unavailable date and reason. Multi-order companies say `우선 확인 주문 기준` once; review summaries include the review count and `확인할 수 없어 유지`.
- **Stage and check-date semantics**: each company stage counts its fixed-scope orders once as complete, unchecked, or needs-review, preserving `C + U + R = N`. Single-order companies show `완료`, `미체크`, or `확인필요`; multi-order companies show completed `C/N` and only applicable unchecked/review counts, or `전체 완료`. A completion date is a recorded sheet date only when the stage is complete and its raw value is a valid sheet date. Full-year dates display `체크 YYYY. M. D.` and yearless dates `체크 M/D`; equivalent spellings deduplicate, but yearful and yearless identities stay separate. Company summaries list the first two unique dates in descending source-row order, then `외 N개 날짜`, and count completed rows without dates as `체크일 미기록 N건`. `O`/`완료` without a date says `체크일 미기록`; unchecked rows never receive a generated date; malformed statuses stay `확인필요`. Details retain raw sheet values. Explain once: `입고 기준일 = 납기 7일 전 · 미체크 = 완료 여부 미확인`; separately explain `체크일: 시트 기록 날짜 · 연도 없으면 월/일`. The order's manager is not a checker identity; `fetched_at` is not a check date.
  - **Responsive and accessibility**: company names and main dates use the Materials 18px tokens; body, stage labels, and check dates are at least 14px; metadata is 12px; interactive targets are at least 44px. The three overview bars and counts fit through y=550 at 375×812; the first ordinary company starts at y≤580 and its entire summary fits within the 812px viewport. At 1280×800 the first three ordinary company summaries fit fully. These density targets replace the earlier three/seven-company targets. Long names and date lists may grow naturally. Text is never clipped or ellipsized, and 320px layouts remain horizontally contained. Search/status changes reset the shared 40-company window; refresh failure keeps old data, its anchor, and due-exclusion count; disclosure retains raw due/stage/source-row and persisted unknown values.
  - **Materials state palette**: Materials keeps these page-local semantic ramps so status is scannable without changing copy or data meaning: complete `#065F46 / #ECFDF5 / #047857` (ink/background/accent), unchecked `#475569 / #F1F5F9 / #64748B`, review `#1E40AF / #EFF6FF / #2563EB`, overdue `#991B1B / #FEF2F2 / #B91C1C`, today `#9A3412 / #FFF7ED / #C2410C`, and selected `#1E40AF / #EFF6FF / #1D4ED8`. Stage summary cells use the state derived only from `C`, `U`, and `R`: complete when `N>0 && C===N`, review when `R>0`, mixed when `C>0 && U>0`, otherwise unchecked. Mixed uses unchecked surfaces and default dark text; a partial cell is never painted complete.
  - **Materials state surfaces**: overview rows default to unchecked tint, while selected rows apply the selected tint, border, and text immediately. Stage cells use a 2px inset-left state accent, 6px radius, and 4px padding; primary complete/review values use their state ink while dates and helper text retain contrast gray. Company cards remain white with the existing 4px priority line; ranks 1–5 map to overdue, today, review, unchecked/future, and complete tints in the existing priority area. Arrival reminder overdue/today units are separately tinted only when their count is nonzero; zero uses unchecked.
- **Materials motion**: retain page-local `--materials-motion-press: 100ms` and `--materials-motion-ease: cubic-bezier(.22,1,.36,1)`, and add `--materials-motion-reveal: 560ms` plus `--materials-motion-status: 240ms`. On first data and successful new data only, the inner C/U/R segment wrapper scales from `scaleX(0)` to `scaleX(1)` from the left once; the track, counts, and accessible values are final immediately. Selection decoration alone fades/scales from `.45/.98` to `1/1` over 240ms. Do not animate list/card layout, width, height, color, shadow, counts, or use timers/rAF. Reduced motion disables animation and transition across the Materials subtree and removes active transform while leaving final ratios visible.

### Notification History Controls
- **Structure**: one wrapping recipient grid beginning with `전체 수신자`, followed by every production, worker, and sales recipient; one native date selector with a clear action.
- **Dimensions**: interactive controls use the shared `--control-min-height` and `--control-min-inline-size` tokens.
- **Selected state**: `--blue` text and `--blue-light` surface, reinforced by `aria-pressed`.
- **Responsive behavior**: recipient buttons wrap by available width and use two equal columns on narrow mobile screens; the date clear action stacks below the input on mobile.
- **Ordering**: records always render in KST newest-date and newest-time order, independent of API input order; choosing a date narrows the already ordered list.
- **History boundary**: list and summary queries begin at KST 2026-09-01; older stored records remain intact but are not displayed.
- **Pagination**: the server returns 10 records per page; navigation shows previous/next actions and at most five numbered pages, resetting to page 1 whenever recipient or date changes.
- **Pagination focus**: keyboard focus uses the solid `--blue` accent and `--space-1` offset; narrow layouts retain the 44px control height and derive compact width from shared control/spacing tokens.
- **Summary**: three cells using the shared H2, body, and caption scale with text status labels.

### Notification History Item
- **Structure**: records are grouped under a KST date heading and count; each surface row contains recipient, masked phone, request status, timestamp, subject, and one disclosure button.
- **States**: collapsed, expanded, legacy-content fallback, failed, and dry-run.
- **Accessibility**: status is never color-only; the disclosure exposes `aria-expanded` and `aria-controls`.

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 100-150ms | ease-out | Press feedback |
| Standard | 200-300ms | var(--ease-smooth) | Hover and card transitions |

### Rules
- Animate only transform, opacity, and shadow.
- Respect existing hover and active behavior.

## 7. Depth & Surface

### Strategy
Mixed: subtle shadows plus light borders, matching the existing home screen.

| Level | Value | Usage |
|-------|-------|-------|
| Default | var(--shadow) | Small panels |
| Elevated | var(--shadow-lg) | Entry and KPI cards |
| Prominent | var(--shadow-xl) | Hover or modal surfaces |
