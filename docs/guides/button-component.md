---
title: Button Component
tags: [components]
---

# Button Component

Buttons trigger a single, clearly labelled action.

## Anatomy

- Container: `--ds-color-action-primary` background with `--ds-radius-100` corners
- Label: `--ds-color-text-primary` on secondary buttons
- Padding: `--ds-space-300` horizontally

## States

Hover uses `--ds-color-action-primary-hover`. Disabled buttons keep their layout
but drop to 40% opacity and must expose `aria-disabled="true"`.

## Usage

Use one primary button per view. Group related actions with `--ds-space-200` between them.
