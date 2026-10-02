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

### Materials Status Dashboard
- **Structure**: an opaque sticky header keeps back and manual-refresh controls. Source, KST query time, inclusive three-month range, `납기 5일 경과 제외`, the separate `입고마감 = 납기 7일 전` rule, company search, the native six-value status filter, result count, exclusions, and exceptions form one compact scan band. Company summaries use a shared desktop grid: 업체/건수, 우선 확인, paired 입고마감/납기, 발주서, 자재발주, 자재입고, 상세. The uncollapsed company groups are `입고 일정 확인` (priority ranks 1, 2, 4, 5) and `확인이 필요한 업체` (rank 3). Mobile summaries use name/count, one priority line, paired dates, and three independent stage columns with the label above its value.
- **Fixed scope and shipping overlay**: `fetched_at` is the successful CSV-download instant and the only KST scope anchor. The inclusive start is three calendar months earlier with month-end clamping. Invalid, blank, and yearless order dates and future dates stay excluded. After the existing order-date and shipping exclusions, orders with a valid full-year due date at least five calendar days before the KST query date are excluded; invalid, missing, and yearless due dates remain for review. The exclusion count covers only this added due-date rule and never double-counts shipping or old-order exclusions. Every API request, including a CSV cache hit, performs a fresh read-only app-order lookup. Only a globally unique direct app ID or a globally unique exact legacy fingerprint may mark that one sheet product as app-shipped; unmatched and ambiguous rows remain visible. Public data contains only safe match state and aggregate counts, never matching phone, dimensions, or fingerprint values.
- **Deadline semantics**: `입고마감` is exactly seven calendar days before a valid full-year work-order due date, calculated with UTC calendar ordinals. Missing, yearless, invalid, and due-before-order dates are review states. A valid deadline earlier than its order date is retained and explained as `발주 시점에 입고마감 경과`. Unchecked arrival is unknown, not definite non-arrival: its states read `입고마감 경과`, `오늘 입고마감`, or `입고마감 D-N`. Confirmed arrival never receives deadline urgency, but its deadline and any past/today due meaning remain readable in dates and details.
- **Priority and ordering**: one company has exactly one emphasized state and edge color: red unchecked/past, orange unchecked/today, blue invalid/raw-status/ambiguous-match review, neutral unchecked/future, or green `전체 입고 확인`. Companies sort in that rank order. Past, today, and future ranks use the earliest relevant deadline; review uses review-order count then arrival-unconfirmed count descending; all-arrival-confirmed uses earliest valid due date; Korean company name is the stable final tie. The representative order always comes from the selected rank, and its due/deadline are shown as one pair. Calculation failures name the unavailable date and reason. Multi-order companies say `우선 확인 주문 기준` once; review summaries include the review count and `확인할 수 없어 유지`.
- **Stage semantics**: each stage counts every selected company's fixed-scope order once as complete, unchecked, or needs-review, preserving `C + U + R = N`. Single-order companies show only `완료`, `미체크`, or `확인필요`; multi-order cells show completed `C/N` and only applicable unchecked/review counts, or `전체 완료` when all orders are complete. Summary cells are neutral text. Large repeated colored stage boxes, duplicate due badges, framed helper cards, and color legends are not used. A single compact note explains `미체크는 입고 여부 미확인입니다.`
- **Responsive and accessibility**: company names and paired main dates use the Materials `--materials-company-name-size` and `--materials-key-date-size` tokens (18px); mobile stage labels use `--materials-stage-label-size` (14px). Common desktop rows target 64–70px and normal mobile rows target 140–155px; long names and mixed states may grow naturally. Text is never clipped or ellipsized, and 320px layouts remain horizontally contained. Body text stays at least 14px, metadata 12px, and interactive targets 44px. Search/status changes reset the shared 40-company window; refresh failure keeps old data, its anchor, and due-exclusion count; disclosure retains raw due/stage/source-row and persisted unknown values.

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
