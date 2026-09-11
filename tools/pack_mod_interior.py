"""Pack a mod interior (a DunGen DungeonFlow and every tile / doorway part it references) from a mod asset bundle that
was loaded into AssetRipper with tools/load_mod_bundle.py.  Everything lands in ./assets like the game's own content,
under ids prefixed by AR_PREFIX so they never collide with the game's ids.

Usage:  set AR_PREFIX=sh  &&  python tools/pack_mod_interior.py <catalog file> [<moon catalog to merge into>]
  e.g.  AR_PREFIX=sh python tools/pack_mod_interior.py catalog_slaughterhouse.json catalog_titan.json
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if not os.environ.get('AR_PREFIX'):
    raise SystemExit('set AR_PREFIX (e.g. sh) so the mod assets get their own ids')
from ar import AR
from pack import Packer, ASSETS

out_file = sys.argv[1] if len(sys.argv) > 1 else 'catalog_mod.json'
merge_into = sys.argv[2] if len(sys.argv) > 2 else None

ar = AR()
pk = Packer(ar)
pk.hier_key = ar.by_name['Prefab Hierarchies']
DATA = ar.by_name[next(n for n in ar.by_name if n.startswith('cab-'))]   # the bundle's data collection
OUT = os.path.join(ASSETS, 'prefabs')
os.makedirs(OUT, exist_ok=True)

catalog = {'tileSets': {}, 'doorParts': [], 'flows': {}, 'modInterior': True}


def safe(name):
    return ''.join(ch if ch.isalnum() or ch in '-_' else '_' for ch in name)


packed = {}


def pack_go(aid):
    if aid in packed:
        return packed[aid]
    idx = pk.build_prefab_index()
    if aid not in idx:
        print('  !! no prefab hierarchy for', aid, pk.ref(aid))
        packed[aid] = None
        return None
    name = safe(pk.ref(aid)[1])
    fn = f'{name}__{aid}.json'
    res = pk.pack_prefab(aid, os.path.join(OUT, fn))
    packed[aid] = fn
    if not res:
        return fn
    for n in res['nodes']:
        for c in n['comps']:
            if c['t'] == 'MB' and c['cls'].endswith('Doorway') and 'd' in c:
                for grp in ('ConnectorPrefabWeights', 'BlockerPrefabWeights'):
                    for w in c['d'].get(grp, []) or []:
                        go = w.get('GameObject')
                        if go and go.get('c') == 'GameObject':
                            sub = pack_go(go['$'])
                            if sub and sub not in catalog['doorParts']:
                                catalog['doorParts'].append(sub)
            if c['t'] == 'MB' and c['cls'].endswith('SpawnSyncedObject') and 'd' in c:
                go = (c['d'].get('spawnPrefab') or {})
                if go and go.get('c') == 'GameObject':
                    sub = pack_go(go['$'])
                    if sub and sub not in catalog['doorParts']:
                        catalog['doorParts'].append(sub)
    return fn


def ref_aid(pptr, key):
    r = ar.resolve(key, pptr)
    return ar.aid(*r) if r else None


def tileset(pp, key):
    r = ar.resolve(key, pp)
    ts = ar.json(*r)['m_Structure']
    name = ar.name(*r)
    if name not in catalog['tileSets']:
        entries = []
        for w in ts['TileWeights']['Weights']:
            go = ref_aid(w['Value'], r[0])
            if not go:
                continue
            fn = pack_go(go)
            if fn:
                curve = [(k['time'], k['value']) for k in (w.get('DepthWeightScale', {}) or {}).get('m_Curve', [])]
                entries.append({'prefab': fn, 'main': w.get('MainPathWeight', 1), 'branch': w.get('BranchPathWeight', 1), 'depthCurve': curve})
        catalog['tileSets'][name] = entries
    return name


def pack_flow(key, pid, name):
    flow = ar.json(key, pid)['m_Structure']
    out = {'name': name, 'rarity': 0, 'Length': flow['Length'], 'BranchCount': flow['BranchCount'], 'BranchMode': flow['BranchMode'],
           'DoorwayConnectionChance': flow.get('DoorwayConnectionChance'), 'GlobalProps': flow.get('GlobalProps'), 'nodes': [], 'lines': []}
    for n in flow['Nodes']:
        out['nodes'].append({'label': n.get('Label'), 'pos': n.get('Position'), 'type': n.get('NodeType'), 'tileSets': [tileset(t, key) for t in n.get('TileSets', [])]})
    for l in flow['Lines']:
        arch = []
        for a in l.get('DungeonArchetypes', []):
            r = ar.resolve(key, a); aj = ar.json(*r)['m_Structure']
            arch.append({'name': ar.name(*r), 'tileSets': [tileset(t, r[0]) for t in aj.get('TileSets', [])],
                         'branchStart': [tileset(t, r[0]) for t in aj.get('BranchStartTileSets', [])],
                         'branchCap': [tileset(t, r[0]) for t in aj.get('BranchCapTileSets', [])],
                         'branchCapType': aj.get('BranchCapType'), 'straighten': aj.get('StraightenChance'),
                         'branchStartType': aj.get('BranchStartType')})
        out['lines'].append({'pos': l.get('Position'), 'len': l.get('Length'), 'archetypes': arch})
    return out


# every DungeonFlow in the bundle (normally one)
coll = ar.coll(DATA)
flows = []
for pid, v in coll.assets.items():
    if v[0] != 'MonoBehaviour':
        continue
    j = ar.json(DATA, int(pid))
    sn = ar.script_name(DATA, j.get('m_Script')) or ''
    if sn.endswith('DungeonFlow') and 'Extended' not in sn:
        flows.append((int(pid), v[1]))
    if sn.endswith('ExtendedDungeonFlow'):
        st = j.get('m_Structure') or {}
        catalog['extended'] = {k: st.get(k) for k in ('dungeonSizeMin', 'dungeonSizeMax', 'dungeonSizeLerpPercentage', 'dungeonDisplayName')}
        catalog['extended']['mapTileSize'] = st.get('<MapTileSize>k__BackingField')
if not flows:
    raise SystemExit('no DungeonFlow found in the bundle')
for pid, name in flows:
    print('== flow', name)
    catalog['flows'][name] = pack_flow(DATA, pid, name)
    catalog['flow'] = catalog['flows'][name]

open(os.path.join(ASSETS, out_file), 'w', encoding='utf-8').write(json.dumps(catalog, indent=1).replace('-Infinity', '-1e30').replace('Infinity', '1e30').replace('NaN', '0'))
pk.flush()
print('mod interior packed:', len([v for v in packed.values() if v]), 'prefabs,', len(catalog['tileSets']), 'tile sets,', len(catalog['doorParts']), 'door parts ->', out_file)

if merge_into:
    mp = os.path.join(ASSETS, merge_into)
    moon = json.load(open(mp, encoding='utf-8'))
    for k, v in catalog['flows'].items():
        moon.setdefault('flows', {})[k] = v
    moon['tileSets'].update(catalog['tileSets'])
    for f in catalog['doorParts']:
        if f not in moon['doorParts']:
            moon['doorParts'].append(f)
    moon['modInterior'] = list(catalog['flows'].keys())
    open(mp, 'w', encoding='utf-8').write(json.dumps(moon, indent=1).replace('-Infinity', '-1e30').replace('Infinity', '1e30').replace('NaN', '0'))
    print('merged into', merge_into, '-> flows', list(moon['flows'].keys()))
