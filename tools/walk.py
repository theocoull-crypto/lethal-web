"""Walk a Unity scene / prefab hierarchy through AssetRipper and dump it as a compact node list (raw Unity values)."""
import json, sys, os
from ar import AR, key_id

V3 = lambda v: [v['m_X'], v['m_Y'], v['m_Z']]
Q4 = lambda v: [v['m_X'], v['m_Y'], v['m_Z'], v['m_W']]
COL = lambda c: [c.get('m_R', c.get('r', 1)), c.get('m_G', c.get('g', 1)), c.get('m_B', c.get('b', 1)), c.get('m_A', c.get('a', 1))]


def pp(ar, key, pptr):
    r = ar.resolve(key, pptr)
    return ar.aid(*r) if r else None


def walk(ar, hkey, hpid, keep_mb=None):
    h = ar.json(hkey, hpid)
    gos = [ar.resolve(hkey, p) for p in h['GameObjects']]
    gos = [g for g in gos if g]
    ar.prefetch(gos)
    comps = []
    for gk in gos:
        gj = ar.json(*gk)
        for c in gj.get('m_Components', []):
            r = ar.resolve(gk[0], c['m_Component'])
            if r:
                comps.append(r)
    ar.prefetch(comps)
    nodes = {}
    tr2go = {}
    order = []
    for gk in gos:
        gj = ar.json(*gk)
        nid = ar.aid(*gk)
        node = {'id': nid, 'name': gj.get('m_Name', ''), 'active': gj.get('m_IsActive', True),
                'layer': gj.get('m_Layer', 0), 'tag': gj.get('m_TagString', ''), 'parent': None,
                'p': [0, 0, 0], 'r': [0, 0, 0, 1], 's': [1, 1, 1], 'comps': []}
        nodes[nid] = node
        order.append(nid)
        for c in gj.get('m_Components', []):
            r = ar.resolve(gk[0], c['m_Component'])
            if not r:
                continue
            ck, cp = r
            cls = ar.cls(ck, cp)
            cj = ar.json(ck, cp)
            if cls in ('Transform', 'RectTransform'):
                node['p'] = V3(cj['m_LocalPosition']); node['r'] = Q4(cj['m_LocalRotation']); node['s'] = V3(cj['m_LocalScale'])
                node['_father'] = pp(ar, ck, cj.get('m_Father'))
                tr2go[ar.aid(ck, cp)] = nid
            elif cls == 'MeshFilter':
                node['mesh'] = pp(ar, ck, cj.get('m_Mesh'))
            elif cls == 'MeshRenderer':
                sb = cj.get('m_StaticBatchInfo', {}) or {}
                sb_first = sb.get('m_FirstSubMesh', sb.get('firstSubMesh', 0)); sb_count = sb.get('m_SubMeshCount', sb.get('subMeshCount', 0))
                node['comps'].append({'t': 'MR', 'mats': [pp(ar, ck, m) for m in cj.get('m_Materials', [])],
                                      'sb': [sb_first, sb_count] if sb_count else None,
                                      'enabled': bool(cj.get('m_Enabled', 1)), 'shadows': cj.get('m_CastShadows', 1),
                                      'lm': cj.get('m_LightmapIndex', 65535)})
            elif cls == 'SkinnedMeshRenderer':
                node['comps'].append({'t': 'SMR', 'mesh': pp(ar, ck, cj.get('m_Mesh')),
                                      'mats': [pp(ar, ck, m) for m in cj.get('m_Materials', [])],
                                      'bones': [pp(ar, ck, b) for b in cj.get('m_Bones', [])],
                                      'root': pp(ar, ck, cj.get('m_RootBone')), 'enabled': bool(cj.get('m_Enabled', 1))})
            elif cls == 'Light':
                node['comps'].append({'t': 'Light', 'type': cj.get('m_Type'), 'color': COL(cj.get('m_Color', {})),
                                      'intensity': cj.get('m_Intensity'), 'range': cj.get('m_Range'),
                                      'spot': cj.get('m_SpotAngle'), 'innerSpot': cj.get('m_InnerSpotAngle'),
                                      'shadows': (cj.get('m_Shadows') or {}).get('m_Type', 0), 'enabled': bool(cj.get('m_Enabled', 1))})
            elif cls == 'AudioSource':
                node['comps'].append({'t': 'Audio', 'clip': pp(ar, ck, cj.get('m_audioClip')), 'loop': bool(cj.get('Loop')),
                                      'play': bool(cj.get('m_PlayOnAwake')), 'vol': cj.get('m_Volume'), 'pitch': cj.get('m_Pitch'),
                                      'min': cj.get('MinDistance'), 'max': cj.get('MaxDistance'),
                                      'enabled': bool(cj.get('m_Enabled', 1))})
            elif cls == 'BoxCollider':
                node['comps'].append({'t': 'Box', 'c': V3(cj['m_Center']), 's': V3(cj['m_Size']), 'trigger': bool(cj.get('m_IsTrigger')), 'enabled': bool(cj.get('m_Enabled', 1))})
            elif cls == 'MeshCollider':
                node['comps'].append({'t': 'MeshCol', 'mesh': pp(ar, ck, cj.get('m_Mesh')), 'convex': bool(cj.get('m_Convex')), 'trigger': bool(cj.get('m_IsTrigger')), 'enabled': bool(cj.get('m_Enabled', 1))})
            elif cls == 'CapsuleCollider':
                node['comps'].append({'t': 'Capsule', 'c': V3(cj['m_Center']), 'radius': cj.get('m_Radius'), 'height': cj.get('m_Height'), 'dir': cj.get('m_Direction'), 'trigger': bool(cj.get('m_IsTrigger')), 'enabled': bool(cj.get('m_Enabled', 1))})
            elif cls == 'SphereCollider':
                node['comps'].append({'t': 'Sphere', 'c': V3(cj['m_Center']), 'radius': cj.get('m_Radius'), 'trigger': bool(cj.get('m_IsTrigger'))})
            elif cls == 'MonoBehaviour':
                sn = ar.script_name(ck, cj.get('m_Script')) or '?'
                mb = {'t': 'MB', 'cls': sn, 'enabled': bool(cj.get('m_Enabled', 1))}
                if keep_mb is None or sn in keep_mb or sn.split('.')[-1] in keep_mb:
                    mb['d'] = cj.get('m_Structure', {})
                mb['_key'] = ar.aid(ck, cp)
                node['comps'].append(mb)
            elif cls == 'Animator':
                node['comps'].append({'t': 'Animator', 'controller': pp(ar, ck, cj.get('m_Controller')), 'avatar': pp(ar, ck, cj.get('m_Avatar')), 'applyRoot': bool(cj.get('m_ApplyRootMotion'))})
            elif cls == 'LODGroup':
                node['comps'].append({'t': 'LOD', 'lods': [{'h': l.get('screenRelativeHeight'), 'r': [pp(ar, ck, r['renderer']) for r in l.get('renderers', [])]} for l in cj.get('m_LODs', [])]})
            elif cls == 'Terrain':
                node['comps'].append({'t': 'Terrain', 'data': pp(ar, ck, cj.get('m_TerrainData')), 'enabled': bool(cj.get('m_Enabled', 1))})
            elif cls in ('ParticleSystem', 'ParticleSystemRenderer', 'Camera', 'Rigidbody', 'NavMeshObstacle', 'OffMeshLink', 'OcclusionArea', 'LineRenderer', 'SpriteRenderer', 'CharacterController', 'Canvas', 'CanvasRenderer', 'ReflectionProbe', 'TerrainCollider', 'WindZone', 'Animation', 'DecalProjector', 'TrailRenderer', 'Cloth', 'Halo', 'LensFlare', 'AudioListener', 'AudioReverbZone', 'NavMeshAgent', 'PlayableDirector', 'VideoPlayer', 'BillboardRenderer'):
                node['comps'].append({'t': cls})
            else:
                node['comps'].append({'t': cls})
    for nid in order:
        n = nodes[nid]
        f = n.pop('_father', None)
        n['parent'] = tr2go.get(f) if f else None
        for c in n['comps']:
            if c['t'] == 'SMR':
                c['bones'] = [tr2go.get(b, b) for b in c['bones']]
                c['root'] = tr2go.get(c['root'], c['root'])
            if c['t'] == 'LOD':
                for l in c['lods']:
                    l['r'] = [tr2go.get(r, r) for r in l['r']]
    # renderer refs (LOD) point at component ids; map component aid -> node id is not stored, keep as is
    managers = []
    for m in h.get('Managers', []):
        r = ar.resolve(hkey, m)
        if r:
            managers.append({'cls': ar.cls(*r), 'd': ar.json(*r)})
    return {'name': h.get('Name'), 'nodes': [nodes[i] for i in order], 'managers': managers, 'tr2go': tr2go}


if __name__ == '__main__':
    ar = AR()
    coll, pid, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    key = ar.key_by_id[coll]
    d = walk(ar, key, pid)
    json.dump(d, open(out, 'w', encoding='utf-8'))
    from collections import Counter
    c = Counter(); mb = Counter()
    for n in d['nodes']:
        for k in n['comps']:
            c[k['t']] += 1
            if k['t'] == 'MB':
                mb[k['cls']] += 1
    print(d['name'], len(d['nodes']), 'nodes')
    print(c.most_common())
    print(mb.most_common(80))
