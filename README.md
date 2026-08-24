# Plume

A 3D sketchbook that runs in a browser. No build step, no bundler, no package
manager: `Plume/plume.html` is a plain page of `<script>` tags and opens
straight from disk.

## Try it

**https://redraptor22.github.io/Pl/**

The site is rebuilt and redeployed by GitHub Actions on every push, so the URL
always serves the newest commit — there is nothing to download. The mechanics
suite runs there too, on whatever device you are holding:

| | |
|---|---|
| the app | https://redraptor22.github.io/Pl/ |
| the tests | https://redraptor22.github.io/Pl/test.html |
| what is live | https://redraptor22.github.io/Pl/build.txt |

A phone that has been to the URL before may hold the page in its cache for a
few minutes. The deployed copy carries the commit it was built from and checks
`build.txt` on load, so a stale page reloads itself once rather than quietly
running old code.

## Run it locally

Opening `Plume/plume.html` from disk works. The test page needs a server,
because it drives the app inside an iframe and `file://` gives every document
its own origin:

    cd Plume && python3 -m http.server 8125
    # app    http://127.0.0.1:8125/plume.html
    # tests  http://127.0.0.1:8125/test.html

`node Plume/pt_test.js` covers the frame maths on its own, without a browser.

## Deployment

`.github/workflows/pages.yml` builds the site with `.github/pages/build.py` and
publishes it. The build script only ever touches the uploaded copy — it stamps
assets with the commit sha and injects the staleness check — so the source in
this repo stays a plain, buildless page. Whichever branch was pushed last is
what the site serves; `build.txt` names it.
