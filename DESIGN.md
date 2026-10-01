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
- **Structure**: an opaque sticky header contains back, title, and refresh controls. The body leads with the KST-anchored recent-three-month range and source query timestamp, then a partial company search and one native status select. A single result line precedes expandable company summaries.
- **Fixed scope**: the successful `fetched_at` instant is converted to a KST end date; the inclusive start is three calendar months earlier with month-end clamping. Only valid full-year order dates in that range and orders not marked complete for shipping are shown. Blank, invalid, and yearless order dates are excluded with a small `발주일 미확인 N건 제외` note; future dates are excluded without joining that note.
- **Status semantics**: each material stage counts every fixed-scope order once as complete, unchecked, or needs-review. Company cards always retain every fixed-scope order for a selected company, even when a material status filter matched only one order. Stage cells show `미체크 N건`, an additional `확인필요 N건` when both exist, `확인필요 N건` when it is the only incomplete state, or `전체 완료`; the labels are `발주서 수령`, `자재 발주`, and `자재 입고`. Complete cells use the existing green-light surface with dark text and a green edge, needs-review uses blue-light/blue-dark with a blue edge, and unchecked stays neutral; red is reserved for refresh failure.
- **Responsive behavior**: desktop company summaries align name/count, three stage cells, and disclosure in a compact row; at tablet and mobile widths details become labelled two-column cards without an inner scroll container. Mobile company stage cells remain one horizontal row at 320px, with CJK-safe wrapping and no ellipsis.
- **Interaction**: search, native select, refresh, disclosure, and load-more controls use the shared 44px minimum. Search and status changes reset the 40-company window. A failed manual refresh retains the old data and anchor and shows a visible stale warning with the original query time. Status meaning is always textual; color only reinforces it. The displayed range keeps each complete date (`YYYY. M. D.`) as a nowrap meaning unit so narrow screens may move the range as a whole without splitting a date.

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
