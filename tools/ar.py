"""Thin client for AssetRipper's local web API (AssetRipper.GUI.Free --headless --port 8790).
Everything is fetched per-asset over HTTP and cached on disk, so we never do a full project export."""
import json, os, re, html, urllib.parse, urllib.request, urllib.error, threading
from concurrent.futures import ThreadPoolExecutor

BASE = os.environ.get('AR_BASE', 'http://127.0.0.1:8790')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache')
os.makedirs(CACHE, exist_ok=True)


def _get(url, binary=False, timeout=900):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        import sys
        print(f'[ar] HTTP {e.code}: {urllib.parse.unquote(url)}', file=sys.stderr)
        raise
    return data if binary else data.decode('utf-8')


def q(s):
    return urllib.parse.quote(s, safe='')


def asset_path(key, pid):
    return json.dumps({"C": {"B": {"P": list(key[0])}, "I": key[1]}, "D": int(pid)}, separators=(',', ':'))


def coll_path(key):
    return json.dumps({"B": {"P": list(key[0])}, "I": key[1]}, separators=(',', ':'))


def key_id(key):
    return ('g' if key[0] else 'b') + str(key[1])


_ROW = re.compile(r'<tr[^>]*>(.*?)</tr>', re.S)
_TD = re.compile(r'<td[^>]*>(.*?)</td>', re.S)
_HREF = re.compile(r'href="([^"]+)"')
_TAG = re.compile(r'<[^>]+>')


def _parse_path_link(href):
    u = html.unescape(href)
    m = re.search(r'Path=([^&]+)', u)
    if not m:
        return None
    p = json.loads(urllib.parse.unquote(m.group(1)))
    if 'C' in p:
        return (tuple(p['C']['B']['P']), p['C']['I']), p['D']
    return (tuple(p['B']['P']), p['I']), None


class Collection:
    def __init__(self, key, name, deps, assets):
        self.key, self.name, self.deps, self.assets = key, name, deps, assets


class AR:
    def __init__(self):
        self.colls = {}
        self.by_name = {}
        self._lock = threading.Lock()
        self._jsoncache = {}
        for bp in ((), (0,)):
            h = _get(f'{BASE}/Bundles/View?Path=' + q(json.dumps({"P": list(bp)})))
            for m in re.finditer(r'<a[^>]*href="([^"]+)"[^>]*>([^<]*)</a>', h):
                href = html.unescape(m.group(1))
                if '/Collections/View' not in href:
                    continue
                r = _parse_path_link(href)
                if r and r[1] is None:
                    self.by_name[html.unescape(m.group(2))] = r[0]
        self.key_by_id = {key_id(k): k for k in self.by_name.values()}

    # ---- collections ----
    def coll(self, key):
        key = (tuple(key[0]), key[1])
        with self._lock:
            if key in self.colls:
                return self.colls[key]
        cf = os.path.join(CACHE, f'coll_{key_id(key)}.json')
        if os.path.exists(cf):
            d = json.load(open(cf, encoding='utf-8'))
        else:
            h = _get(f'{BASE}/Collections/View?Path={q(coll_path(key))}')
            i = h.find('<main')
            body = h[i:]
            di = body.find('<h2>Dependencies</h2>')
            assets_html, deps_html = (body, '') if di < 0 else (body[:di], body[di:])
            assets = {}
            for row in _ROW.finditer(assets_html):
                cells = _TD.findall(row.group(1))
                if len(cells) >= 3:
                    pid = int(_TAG.sub('', cells[0]).strip())
                    cls = _TAG.sub('', cells[1]).strip()
                    name = html.unescape(_TAG.sub('', cells[2]).strip())
                    assets[pid] = (cls, name)
            deps = {}
            for row in _ROW.finditer(deps_html):
                cells = _TD.findall(row.group(1))
                if len(cells) >= 2:
                    m = _HREF.search(cells[1])
                    r = _parse_path_link(m.group(1)) if m else None
                    try:
                        fid = int(_TAG.sub('', cells[0]).strip())
                    except ValueError:
                        continue
                    deps[str(fid)] = list(r[0][0]) + [r[0][1]] if r else None
            mname = re.search(r'<h1>([^<]*)</h1>', body)
            name = html.unescape(mname.group(1)) if mname else str(key)
            d = {'name': name, 'deps': deps, 'assets': {str(k): v for k, v in assets.items()}}
            json.dump(d, open(cf, 'w', encoding='utf-8'))
        deps = {int(k): ((tuple(x[:-1]), x[-1]) if x else None) for k, x in d['deps'].items()}
        c = Collection(key, d['name'], deps, {int(k): tuple(v) for k, v in d['assets'].items()})
        with self._lock:
            self.colls[key] = c
        return c

    def resolve(self, key, pptr):
        if not pptr:
            return None
        pid = pptr.get('m_PathID', 0)
        if pid == 0:
            return None
        fid = pptr.get('m_FileID', 0)
        if fid == 0:
            return (key, pid)
        c = self.coll(key)
        dep = c.deps.get(fid)
        if dep is None and fid == 1 and c.name.endswith('(Generated Assets)'):
            dep = self._scene_dep(key)
            if dep is not None:
                c.deps[fid] = dep
        if dep is None:
            return None
        return (dep, pid)

    def _scene_dep(self, key):
        """Some '(Generated Assets)' scene collections come with an empty dependency table; their objects live in the
        'levelN' collection with exactly the same number of GameObjects as the scene hierarchy lists."""
        try:
            n = len(self.json(key, 1).get('GameObjects') or [])
        except Exception:
            return None
        for name, k in self.by_name.items():
            if isinstance(k, tuple) and k[0] == () and name.startswith('level'):
                cc = self.coll(k)
                if sum(1 for v in cc.assets.values() if v[0] == 'GameObject') == n:
                    return k
        return None

    def cls(self, key, pid):
        return self.coll(key).assets.get(pid, ('?', '?'))[0]

    def name(self, key, pid):
        return self.coll(key).assets.get(pid, ('?', '?'))[1]

    def aid(self, key, pid):
        return f'{key_id(key)}_{pid}'

    # ---- assets ----
    def json(self, key, pid):
        k = (key, pid)
        with self._lock:
            if k in self._jsoncache:
                return self._jsoncache[k]
        cf = os.path.join(CACHE, f'json_{self.aid(key, pid)}.json')
        if os.path.exists(cf):
            txt = open(cf, encoding='utf-8').read()
        else:
            try:
                txt = _get(f'{BASE}/Assets/Json?Path={q(asset_path(key, pid))}')
            except urllib.error.HTTPError as e:
                txt = json.dumps({'_missing': True, '_code': e.code})
            open(cf, 'w', encoding='utf-8').write(txt)
        try:
            d = json.loads(txt)
        except json.JSONDecodeError:
            d = {'_error': txt[:200]}
        with self._lock:
            self._jsoncache[k] = d
        return d

    def yaml(self, key, pid):
        cf = os.path.join(CACHE, f'yaml_{self.aid(key, pid)}.yaml')
        if os.path.exists(cf):
            return open(cf, encoding='utf-8').read()
        txt = _get(f'{BASE}/Assets/Yaml?Path={q(asset_path(key, pid))}')
        open(cf, 'w', encoding='utf-8').write(txt)
        return txt

    def save(self, kind, key, pid, dst, ext=None):
        if os.path.exists(dst) and os.path.getsize(dst) > 0:
            return dst
        url = {'glb': '/Assets/Model.glb?Path=', 'image': '/Assets/Image?Path=', 'audio': '/Assets/Audio?Path='}[kind]
        u = f'{BASE}{url}{q(asset_path(key, pid))}'
        if kind == 'image':
            u += f'&Extension={ext or "png"}'
        data = _get(u, binary=True)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'wb') as f:
            f.write(data)
        return dst

    def search(self, query):
        h = _get(f'{BASE}/Search/View?q={q(query)}')
        out = []
        for row in _ROW.finditer(h[h.find('<main'):]):
            cells = _TD.findall(row.group(1))
            if len(cells) >= 4:
                m = _HREF.search(cells[2])
                if not m:
                    continue
                r = _parse_path_link(m.group(1))
                out.append((r[0], r[1], _TAG.sub('', cells[1]).strip(),
                            html.unescape(_TAG.sub('', cells[2]).strip()),
                            html.unescape(_TAG.sub('', cells[3]).strip())))
        return out

    def prefetch(self, items, workers=12):
        with ThreadPoolExecutor(workers) as ex:
            list(ex.map(lambda kp: self.json(*kp), items))

    # ---- helpers ----
    def script_name(self, key, pptr):
        r = self.resolve(key, pptr)
        if not r:
            return None
        d = self.json(*r)
        ns = d.get('m_Namespace', '')
        return (ns + '.' if ns else '') + d.get('m_ClassName', '?')


if __name__ == '__main__':
    ar = AR()
    print(len(ar.by_name), 'collections')
    for n, k in sorted(ar.by_name.items()):
        print(' ', key_id(k), n)
