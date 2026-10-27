---
title: Design Token Taxonomy
tags: [taxonomy, design-tokens]
owner: design-systems
---

# Design Token Taxonomy

This document is the source of truth for design-token naming. The context pipeline
indexes every document tagged `taxonomy` and evaluates incoming documentation changes
against it.

## Naming convention

Tokens follow `--ds-{category}-{property}-{variant}`:

- `category`: one of `color`, `space`, `radius`, `font`, `shadow`, `motion`
- `property`: the semantic role (for example `surface`, `text`, `border`)
- `variant`: a scale step (`100`–`900`) or a state (`hover`, `pressed`, `disabled`)

Raw values (hex codes, pixel values) must never appear in component documentation.

## Color tokens

- `--ds-color-surface-default`: default page and card background
- `--ds-color-surface-raised`: elevated surfaces such as popovers
- `--ds-color-text-primary`: body copy
- `--ds-color-text-subtle`: secondary copy and captions
- `--ds-color-action-primary`: primary button background
- `--ds-color-action-primary-hover`: primary button hover state
- `--ds-color-border-default`: dividers and input borders

## Spacing tokens

- `--ds-space-100`: 4px, icon gaps
- `--ds-space-200`: 8px, stacked controls and cards
- `--ds-space-300`: 12px, button padding
- `--ds-space-400`: 16px, section gutters

## Radius tokens

- `--ds-radius-100`: inputs and buttons
- `--ds-radius-200`: cards and dialogs
