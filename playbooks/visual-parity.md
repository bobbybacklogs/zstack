# Playbook: Visual Parity

> **Trigger:** Implementing or refining web, mobile, or desktop UI to match reference designs or mockups.

Deliver pixel-precise, responsive interfaces by verifying against real visual output.

---

## Step 1: Analyze Reference Hierarchy & Tokens
- Identify core layout grid, typography scale, color tokens, and spacing rhythm from the design spec.
- Check semantic HTML structure and accessibility primitives before styling.

## Step 2: Build Responsive Scaffolding
- Implement layout starting from mobile/base viewport up to desktop widths.
- Ensure fluid responsive behavior using modern CSS (Flexbox, Grid, container queries).

## Step 3: Verify Against the Rendered Interface
- Do not assume CSS works based on syntax alone. Render the page in a browser or headless browser.
- Inspect actual DOM elements, computed box models, focus rings, and contrast ratios.

## Step 4: Fix Visual Drift
- Adjust spacing, font weights, and border radii until the rendered page matches the design reference.
- Verify both light and dark mode appearance.
