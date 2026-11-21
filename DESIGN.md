---
name: TransitGap
description: Municipal transit atlas and service workbench
colors:
  paper: "#f6f3e9"
  panel: "#fffcf3"
  ink: "#202f29"
  muted: "#52625a"
  route-green: "#163e36"
  boundary: "#d4d8ca"
  atlas-paper: "#efeee0"
  improvement: "#1c5b42"
  caution: "#8a3c22"
typography:
  display:
    fontFamily: "Iowan Old Style, Palatino Linotype, Georgia, serif"
    fontSize: "2.05rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.04em"
  body:
    fontFamily: "Avenir Next, Trebuchet MS, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.48
rounded:
  control: "7px"
  panel: "13px"
spacing:
  panel-gap: "1rem"
  desktop-gutter: "2.5rem"
components:
  button-primary:
    backgroundColor: "{colors.route-green}"
    textColor: "{colors.panel}"
    rounded: "{rounded.control}"
    height: "40px"
---

# Design System

## Overview

A printed municipal street atlas with interactive route layers. The map carries the first screen, the inspector makes it possible to question an aggregate result, and the council brief is quiet enough to print in black and white.

## Colors

Use paper neutrals and ink for the workbench. Use green for focus of work and favorable changes, and rust for regressions and unmet access thresholds. Map layers keep a number in every neighborhood, so hue is never the only way to read service access or change.

## Typography

Use editorial serif for the brand, section heads and comparison values. Keep controls and labels in the same sans-serif family. Render table data with tabular numbers.

## Layout

Put scenario controls first, then measures, then the map next to its neighborhood inspector. Under 900 px, put the inspector directly below the map. Under 570 px, keep two comparison columns.

## Elevation & Depth

Use tonal separation and a thin rule rather than a drop shadow. Reserve the deep green panel head for the inspector and selected controls.

## Shapes

Use small rounded rectangles for data marks and common controls, and slightly larger corners for major panels.

## Components

Keep map route lines identifiable by position and stop marks, and keep supporting text clear of plotted neighborhood labels. Pair deltas with the baseline, not an unlabeled reference. Neighborhood interactions expose a focus state, a pressed state, and a native list alternative.

## Do's and Don'ts

Do keep synthetic assumptions visible in exports and briefs. Do not turn the app into a marketing page or put supporting copy above or beneath titles.
