# Story 003 — diagnosis

## File and line

`src/components/Collections/CollectionsMenu.tsx`, line 97 — the className expression
on the mykhaita `<Link>` element.

## What causes the wrap

DaisyUI v5's `.tab` class (node\_modules/daisyui/components/tab.css) sets:

```
display: inline-flex;
flex-wrap: wrap;
```

The tab therefore acts as a flex container whose children can wrap onto a second
row when their combined width exceeds the element's inline-axis constraint.

The mykhaita tab has two flex children:

1. `<HeartIcon className="w-6 fill-primary" />` — 1.5 rem wide
2. `<span className="hidden md:block">{active === "mykhaita" ? "My Khaita" : ""}</span>`

When **inactive**, the span has empty content → effectively zero width → nothing
to trigger wrapping. The tab renders icon-only, the height matches every other tab.

When **active**, the span has the text "My Khaita". The combined width of icon +
gap-4 + label overflows the tab's available inline width (the tab is a flex item
in the `tabs` row and can be shrunk by the surrounding flex algorithm), so
`flex-wrap: wrap` kicks in and the label falls onto a second row directly below
the icon. The tab grows taller, pushing the outer wrapper taller too.

## Why the active variant behaves differently

Only the active variant populates the span (`{active === "mykhaita" ? "My Khaita" : ""}`).
The inactive span is present in the DOM but has no text → zero intrinsic width →
no wrap trigger.

## Mechanism

`flex-wrap: wrap` in DaisyUI v5's `.tab` utility, combined with the tab being a
flex item that can be shrunk by its parent flex row.

The `whitespace-nowrap` on the container div (line 91) prevents inline text
from breaking at word boundaries but has no effect on flex-item wrapping inside
each tab element — those are distinct CSS properties at different nesting levels.

## Fix direction

Add `flex-nowrap` (Tailwind → `flex-wrap: nowrap`) to the active-branch
conditional class on the mykhaita link. This overrides DaisyUI's `flex-wrap:
wrap` for that tab only when the label is visible, keeping icon and label on one
row. The inactive state needs no change because the span is empty and causes no
wrapping regardless.
