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
