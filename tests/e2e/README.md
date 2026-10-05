# Browser evidence and visual review

For developers validating changes to the operational journal. Run `npm run test:e2e` with Microsoft Edge. The suite builds production assets and uses an isolated server and database. Design fixtures are synthetic; they do not contain an owner's workspace data.

## Automated evidence

`design.spec.ts` checks these bounded contracts:

- No document-level horizontal overflow on the sampled screens and viewport widths.
- Presence of the main heading and workspace bar; attention before the checks register; decision priority and movement/evidence semantics.
- Existence and interaction of sampled controls, editing focus and cancel, and repository-context disclosure.
- Keyboard skip-link, its focus outline, and transfer of focus to main content.
- Loading message, disabled refresh, error alert and recovery.

`post-design.spec.ts` additionally checks:

- A project with only paused unfinished checks still shows its checks section and the `На паузе` label. Completed checks are absent there and remain reachable in the archive.
- All seven navigation links are visible and reachable with keyboard activation at 1440, 1100, 800, 550 and 390 px. Each transition exposes one current link through `aria-current` and the existing selected style.
- Navigation labels stay on one text line, links do not overlap each other or the brand/refresh, controls do not extend beyond the viewport, and no horizontal overflow appears on the sampled navigation screen.

A separate enlarged-text regression checks that the project-heading action remains on one text line and opens the editor with keyboard activation at 1100 px. This is a bounded control-layout assertion, not a readability score.

These checks prove only their asserted states in the test browser and fixtures. They are not a full accessibility audit or proof that every element, data state and browser is usable. The root-font-size overflow assertion is a limited geometry smoke: fixed-pixel text does not all scale, and readability is not asserted.

## Manual visual acceptance

Screenshot generation is an artifact step, with no visual baseline or image-quality assertion. A successful screenshot call does not confirm design quality. Review the ignored `.local/design-discovery/screenshots/` and `.local/post-design-review/` artifacts separately for:

- Readability with enlarged text; distinguish text scaling from actual browser zoom.
- Composition at 390 px, including long headings and controls.
- Visual density, spacing, accidental wraps, clipping and awkward empty areas.
- Navigation row count and height, competition with the brand/refresh and ease of recognizing the current section.
- Overall operational-journal character and preservation of the accepted hierarchy, palette and typography.

Navigation metrics record geometry for review; row count and bar height do not by themselves establish comfortable navigation. Record which artifacts and states were inspected and any remaining limits. Revisit this checklist when adding a screen, navigation item or layout breakpoint.
