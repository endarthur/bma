# BMA User Manual (source)

The gift-quality user manual, EN + pt-BR. The HTML source and the build scripts
are tracked; the generated artifacts (screenshots, PDFs, synthesized example
data) are gitignored — rebuild them from here.

## Build

From this folder, with the app built (`node ../build.js`) and Playwright
installed (it ships with the repo's dev deps), using Edge/Chromium:

```bash
node manual-shots.js     # (re)generate screenshots into shots/ from the live app
node manual-pdf-en.js    # manual-en.html -> BMA-Manual-EN.pdf
node manual-pdf.js       # manual.html    -> BMA-Manual-ptBR.pdf
```

`manual-shots.js` serves the repo's built `index.html`, drives the bundled
example dataset (model + samples + a collar/survey/assays drillhole trio, plus a
synthesized domain table for the merge shot), and screenshots each tab. The PDF
renderers print the HTML to A4 via headless Edge.

## Files

| File | Role |
|------|------|
| `manual-en.html` | English source |
| `manual.html` | Portuguese (pt-BR) source — keeps English UI labels in PT prose |
| `manual-shots.js` | Playwright screenshot driver |
| `manual-pdf-en.js` / `manual-pdf.js` | HTML → PDF renderers |

The manual references the screenshots by name (`shots/NN-*.png`); after any UI
change, re-run `manual-shots.js` then the PDF scripts. Section numbering and the
two-level table of contents are hand-authored in the HTML.
