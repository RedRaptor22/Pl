#!/usr/bin/env python3
"""Lay out the Pages site.

The repo deliberately has no build step: plume.html is a plain page of
<script> tags that opens straight from disk. That stays true. This script
touches only the copy that gets uploaded, and only to solve the one problem
a hosted copy has that a local one does not — a phone that has already been
to the URL will happily serve you last week's JavaScript out of its cache.

Two measures against that, both keyed to the commit being deployed:

  * every local script and stylesheet gets ?v=<short sha>, so new HTML can
    never pull old code;
  * a few lines at the top of the page compare the sha baked into it against
    build.txt, fetched with no-store, and hop once to a fresh URL if the page
    itself came out of a stale cache.

Layout: the app is the site root, so the bookmark is just the Pages URL, and
the mechanics suite sits beside it at /test.html.
"""

import os
import re
import shutil
import sys
from datetime import datetime, timezone

SRC = "Plume"
SHA = os.environ.get("PLUME_SHA", "local")
REF = os.environ.get("PLUME_REF", "local")
SHORT = SHA[:7]
STAMPED = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

# src="js/..." and href="...css" that point inside the site, not off it
LOCAL_ASSET = re.compile(
    r'((?:src|href)=")(?!https?:|//|data:|#|mailto:)([^"?#]+\.(?:js|css))(")'
)

FRESHEN = """<script>
/* Injected by .github/pages/build.py — hosted copy only.
   If this page came out of a stale cache, hop once to a fresh URL. */
(function(){
  var BUILD = "%s";
  try{
    fetch("build.txt", {cache:"no-store"}).then(function(r){
      return r.ok ? r.text() : "";
    }).then(function(text){
      var live = (text.split(/\\s+/)[0] || "");
      if(!live || live === BUILD) return;
      if(sessionStorage.getItem("plume-build-tried") === live) return;
      sessionStorage.setItem("plume-build-tried", live);
      location.replace(location.pathname + "?b=" + encodeURIComponent(live));
    }).catch(function(){});
  }catch(e){}
})();
</script>
"""


def stamp(html, freshen):
    html = LOCAL_ASSET.sub(lambda m: m.group(1) + m.group(2) + "?v=" + SHORT + m.group(3), html)
    head = "<meta name=\"plume-build\" content=\"%s %s %s\">\n" % (SHORT, REF, STAMPED)
    if freshen:
        head += FRESHEN % SHORT
    if "</head>" in html:
        html = html.replace("</head>", head + "</head>", 1)
    return html


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "site"
    if os.path.isdir(out):
        shutil.rmtree(out)
    shutil.copytree(SRC, out)

    for name in os.listdir(out):
        if not name.endswith(".html"):
            continue
        path = os.path.join(out, name)
        with open(path, encoding="utf-8") as fh:
            html = fh.read()
        # test.html drives plume.html in an iframe; letting BOTH pages decide
        # to navigate would fight, so only the app itself freshens.
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(stamp(html, freshen=(name == "plume.html")))

    # plume.html is the app, so it is also the site's front door.
    shutil.copyfile(os.path.join(out, "plume.html"), os.path.join(out, "index.html"))

    with open(os.path.join(out, "build.txt"), "w", encoding="utf-8") as fh:
        fh.write("%s %s %s\n" % (SHORT, REF, STAMPED))

    print("site: %s from %s (%s), %d files"
          % (out, SHORT, REF, sum(len(f) for _, _, f in os.walk(out))))


if __name__ == "__main__":
    main()
