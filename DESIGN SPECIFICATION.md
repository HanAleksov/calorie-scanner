# DESIGN SPECIFICATION: Apple-Fluid Dark Mode Overhaul

## 1. Visual Theme & Color Palette
Replace static dark gray surfaces with pure blacks and translucent blurred glass layers.

- **Background (Base):** `#000000` (OLED True Black)
- **Surface (Glass Cards):** `rgba(255, 255, 255, 0.05)`
  - `backdrop-filter: blur(20px) saturate(180%)`
  - `border: 1px solid rgba(255, 255, 255, 0.08)`
  - `box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37)`
- **Accent Color (Primary Action):** Vibrant Electric Orange Gradient
  - `background: linear-gradient(135deg, #FF6B00 0%, #FF3B00 100%)`
  - `box-shadow: 0 4px 20px rgba(255, 59, 0, 0.35)`
- **Text Primary:** `#FFFFFF`
- **Text Secondary:** `rgba(255, 255, 255, 0.55)`
- **Macro Accents:** 
  - Protein: `#30D158` (iOS Mint Green)
  - Carbs: `#0A84FF` (iOS Blue)
  - Fats: `#FFD60A` (iOS Gold)

---

## 2. Component Layouts & Typography

### A. Typography Scale
- Font Stack: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", sans-serif`
- Number Metrics: `font-variant-numeric: tabular-nums; letter-spacing: -0.03em;`
- Header Titles: `font-weight: 700; letter-spacing: -0.02em;`

### B. Floating Glass Navigation Header & Bottom Bar
- **Top Bar:** Fixed `sticky top-0`, translucent `rgba(0,0,0,0.6)` background with `backdrop-blur-xl`.
- **Bottom Nav:** Floating glass pill elevated `16px` off the bottom:
  - `margin: 0 16px 20px 16px; border-radius: 9999px;`
  - Active tab indicator: Glowing pill backdrop with smooth CSS translation.

### C. Bottom Sheet Modals ("Edit Entry" / "Suggested Goals")
- Replace inline forms with iOS-style drag-to-dismiss bottom sheets.
- Overlay: `background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(8px);`
- Sheet Container:
  - `border-top-left-radius: 28px; border-top-right-radius: 28px;`
  - Top handle bar: `width: 36px; height: 5px; background: rgba(255, 255, 255, 0.3); border-radius: 9999px;`

---

## 3. Micro-Interactions & Spring Animations

Apply smooth iOS spring physics to all interactive elements:

```css
/* Core Spring Animation Utility */
:root {
  --ios-spring: cubic-bezier(0.16, 1, 0.3, 1);
  --ios-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Button Tap Press State */
button, .clickable {
  transition: transform 0.2s var(--ios-spring), opacity 0.2s ease;
}
button:active, .clickable:active {
  transform: scale(0.95);
  opacity: 0.8;
}

/* Smooth Card Elevation on Hover/Focus */
.glass-card {
  transition: transform 0.3s var(--ios-spring), border-color 0.3s ease;
}

/* Sheet Slide-Up Keyframes */
@keyframes slideUp {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
.bottom-sheet {
  animation: slideUp 0.4s var(--ios-spring);
}