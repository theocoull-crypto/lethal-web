"""Print AssetRipper's bundle/collection tree (read-only), so nested bundles such as a mod's .lethalbundle can be found.
Usage: python tools/ar_tree.py [--assets]   (--assets also counts asset kinds per collection)"""
import os, sys, re, html, json, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar as arm

count_assets = '--assets' in sys.argv
seen = set()


def bundle_path(href):
    u = html.unescape(href)
    m = re.search(r'Path=([^&]+)', u)
    if not m:
        return None
    p = json.loads(urllib.parse.unquote(m.group(1)))
    return tuple(p['P']) if 'P' in p else None


def walk(bp, depth=0):
    page = arm._get(f'{arm.BASE}/Bundles/View?Path=' + arm.q(json.dumps({"P": list(bp)})))
    for m in re.finditer(r'<a[^>]*href="([^"]+)"[^>]*>([^<]*)</a>', page):
        href = html.unescape(m.group(1)); name = html.unescape(m.group(2))
        if '/Bundles/View' in href:
            p = bundle_path(href)
            if p is not None and p not in seen and len(p) > len(bp) and depth < 5:
                seen.add(p)
                print('  ' * depth + 'BUNDLE', name, list(p))
                walk(p, depth + 1)
        elif '/Collections/View' in href:
            r = arm._parse_path_link(href)
            key = r[0] if r else None
            extra = ''
            if count_assets and key:
                try:
                    c = arm.AR.coll(arm.AR.__new__(arm.AR), key) if False else None
                except Exception:
                    c = None
            print('  ' * depth + 'coll', name, key, extra)


walk(())
