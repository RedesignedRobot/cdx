# cdx TUI lane report

The opt-in prototype is implemented. `CDX_TUI=1` selects the new full status and usage output. Default output and JSON, line, brief, and watch modes retain the existing paths. No dependencies were added.

Changed files:

- `tui.ts` contains terminal detection, colours, width-aware layout, status, lane tree, usage table, prism rasterisation, PNG encoding, Kitty transmission, and the cell loader.
- `cdx.ts` selects the renderer from the environment and keeps the existing lane details, quota data, selection rules, and job ownership filter.
- `tui-demo.ts` writes the prism PNG and prints sample status, usage, and a bounded loader. It does not import cdx.
- `tsconfig.json` includes the demo in the liaison's eventual typecheck. The cdx import already includes `tui.ts`.
- `docs/tui-design.md` records the design system, portal sources, live protocol references, fallback rules, and run instructions.
- `docs/tui-prism.png` and `docs/tui-demo.txt` are generated demo artifacts.
- `docs/tui-report.md` is this handoff.

Run `bun tui-demo.ts` in Ghostty for the inline PNG and animated lattice. Run `CDX_TUI=1 bun cdx.ts status` or `CDX_TUI=1 bun cdx.ts usage` for real data after integration. The usage command retains its existing provider probes and cache writes. This lane did not run those commands.

Artifact generation used `bun tui-demo.ts > docs/tui-demo.txt` and exited 0. That proves the isolated demo ran through the plain-output path and wrote its PNG. It does not prove Ghostty rendering or command integration. No tests, typechecks, builds, or wall ran. The lane gate owns verification.

Remaining risks and omissions:

- Graphics detection trusts known terminal identity variables and excludes known multiplexers. It does not query terminal replies. Stale SSH or wrapper variables may require `CDX_TUI_GRAPHICS=0`.
- Real Ghostty placement, scrolling, font cell proportions, resize during loader playback, and monochrome presentation have no visual acceptance in this lane.
- The status renderer reuses existing formatted block content after stripping controls. A future change to those blocks carries into the TUI.
- Event lines, the report view, and pixel wipe are design-only. Production commands do not run the loader or print a large prism. The standalone demo exercises those implemented primitives.
- `/lanes` captures stdout, so it gets plain text. This lane did not alter hook environment propagation.
- Context7 failed to connect. Official Kitty, Ghostty, Bun, Node, and PNG documentation supplied the implementation references.

No child lanes ran. No commits, pushes, deployments, servers, or cdx state changes occurred. Report paths are `docs/tui-report.md` and `docs/tui-design.md`; the demo capture is `docs/tui-demo.txt`. PushNotification is unavailable in this worker's tool set.

Net text line delta: +480 lines, 492 added and 12 removed. The PNG is additional binary output.

Duplicated investigation or rework: none across workers. Initial combined source output was too large; bounded excerpts recovered the omitted sections.
