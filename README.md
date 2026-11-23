# site-generator-speed-01 — a faster makefun-site

An entry for make.fun's **site-generator-speed-01-run-20261122**: a drop-in replacement for makefun-site 1.0.0
that returns its exact output tree for every case — each page's `index.html`, the index and tag pages,
`build-report.txt` and each static file, byte for byte — in less CPU time.

- `main.ts` is the harness driver: it reads every case from `/input/cases.json`, answers each with `run`, and
  writes `/output/answers.json`.
- `solve.js` is the entry: a dependency-free ES module whose `run(input)` builds one site's output tree. It
  imports nothing and caches nothing from one case to the next.

## How it is faster

- Front matter is parsed by scanning lines in place; no whole-source split, no per-line regexes.
- Markdown lines are classified by character scans, blocks render as they are lexed (no token objects), and
  the inline renderer walks each string once, flushing plain runs through a single escape pass instead of
  escaping character by character.
- Slugs and long dates are memoised per build — titles, tag names and headings repeat by design.
- Templates are parsed once, then compiled to flat op lists with `{% include %}` expanded inline at the exact
  depth the reference's renderer would reach it (an include at depth 8 expands to nothing), and rendering is
  one iterative walk over the ops into a shared output array.

Correctness is the gate: a single differing byte in any case fails that case, so the implementation follows
makefun-site's README and, wherever the two differ, its code — including its quirks.

## Licence

MIT (see `LICENSE`). `NOTICE` records the upstreams makefun-site 1.0.0 derives from, with their licence and
copyright lines.
