#!/usr/bin/env python3
"""Add Lucide icons to vendor/icons.svg as <symbol id="i-NAME">.
Usage: npm pack lucide-static@1.66.0 && tar xzf lucide-static-*.tgz && python3 tools/add-icons.py package/icons chevron-down ..."""
import re, sys
d, names = sys.argv[1], sys.argv[2:]
p = "vendor/icons.svg"; s = open(p).read()
for n in names:
    if f'id="i-{n}"' in s: continue
    body = re.search(r"<svg[^>]*>(.*)</svg>", open(f"{d}/{n}.svg").read(), re.S).group(1)
    body = " ".join(x.strip() for x in body.strip().splitlines())
    i = s.rindex("</svg>")
    s = s[:i] + f'<symbol id="i-{n}" viewBox="0 0 24 24">{body}</symbol>\n' + s[i:]
open(p, "w").write(s)
