"""Pack Unity hierarchies (scenes / prefabs) into web assets.

Reads hierarchies through AssetRipper's HTTP API (see ar.py) and writes:
  assets/meshes/<aid>.glb     one glb per Unity Mesh (AssetRipper export; X axis already mirrored to glTF)
  assets/tex/<aid>.png        textures (normal maps un-swizzled, HDRP mask maps converted to ORM)
  assets/audio/<aid>.ogg      audio clips
  assets/materials.json       all materials referenced
  assets/<group>/<name>.json  node manifests, transforms converted to three.js handedness (X mirrored)
"""
import json, os, sys, re, math, io
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ar import AR, key_id
from walk import walk

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')

DROP_MB = ('UnityEngine.UI.', 'TMPro.', 'UnityEngine.Rendering.', 'Unity.AI.Navigation.',
           'Unity.Netcode.', 'OccludeAudio', 'AudioReverbTrigger', 'UnityEngine.EventSystems.', 'Dissonance.', 'SoftMasking.',
           'EasyTextEffects.', 'DigitalRuby.', 'UnityEngine.InputSystem.', 'DunGen.Adapters.', 'AmazingAssets.')


def write_pb_glb(d, path):
    """Rebuild a ProBuilder mesh (positions/faces stored in the ProBuilderMesh component) as a glb with SubMesh_i nodes.
    Mirrors X like AssetRipper's exporter; flat normals; UVs from m_Textures0 (v flipped for glTF)."""
    import struct
    import numpy as np
    from pygltflib import GLTF2, Scene, Node, Mesh, Primitive, Attributes, Accessor, BufferView, Buffer
    P = d.get('m_Positions') or []
    T = d.get('m_Textures0') or []
    if not P:
        return False
    pos = np.array([[-p['x'], p['y'], p['z']] for p in P], dtype=np.float32)
    uv = np.array([[t['x'], 1.0 - t['y']] for t in T], dtype=np.float32) if len(T) == len(P) else np.zeros((len(P), 2), np.float32)
    subs = {}
    for f in d.get('m_Faces') or []:
        idx = f.get('m_Indexes') or []
        subs.setdefault(f.get('m_SubmeshIndex', 0), []).extend(idx)
    if not subs:
        return False
    blob = bytearray(); views = []; accs = []; meshes = []; nodes = []
    def add_view(arr, target):
        off = len(blob); data = arr.tobytes(); blob.extend(data)
        while len(blob) % 4: blob.append(0)
        views.append(BufferView(buffer=0, byteOffset=off, byteLength=len(data), target=target)); return len(views) - 1
    for si in sorted(subs):
        tri = np.array(subs[si], dtype=np.int64).reshape(-1, 3)
        if not len(tri):
            continue
        # mirroring X flips handedness: swap two corners to keep faces front-facing in glTF
        a, b, c = pos[tri[:, 0]], pos[tri[:, 2]], pos[tri[:, 1]]
        n = np.cross(b - a, c - a); ln = np.linalg.norm(n, axis=1, keepdims=True); ln[ln == 0] = 1; n = n / ln
        vpos = np.concatenate([a, b, c], axis=1).reshape(-1, 3).astype(np.float32)
        vnor = np.repeat(n, 3, axis=0).astype(np.float32)
        vuv = np.concatenate([uv[tri[:, 0]], uv[tri[:, 2]], uv[tri[:, 1]]], axis=1).reshape(-1, 2).astype(np.float32)
        vidx = np.arange(len(vpos), dtype=np.uint32)
        vp = add_view(vpos, 34962); vn = add_view(vnor, 34962); vt = add_view(vuv, 34962); vi = add_view(vidx, 34963)
        accs.append(Accessor(bufferView=vp, componentType=5126, count=len(vpos), type='VEC3', min=vpos.min(0).tolist(), max=vpos.max(0).tolist())); ap = len(accs) - 1
        accs.append(Accessor(bufferView=vn, componentType=5126, count=len(vnor), type='VEC3')); an = len(accs) - 1
        accs.append(Accessor(bufferView=vt, componentType=5126, count=len(vuv), type='VEC2')); at = len(accs) - 1
        accs.append(Accessor(bufferView=vi, componentType=5125, count=len(vidx), type='SCALAR')); ai = len(accs) - 1
        meshes.append(Mesh(primitives=[Primitive(attributes=Attributes(POSITION=ap, NORMAL=an, TEXCOORD_0=at), indices=ai)]))
        nodes.append(Node(name=f'SubMesh_{si}', mesh=len(meshes) - 1))
    root = Node(name='pb', children=list(range(1, len(nodes) + 1)))
    g = GLTF2(scene=0, scenes=[Scene(nodes=[0])], nodes=[root] + nodes, meshes=meshes, accessors=accs, bufferViews=views, buffers=[Buffer(byteLength=len(blob))])
    g.set_binary_blob(bytes(blob))
    g.save(path)
    return True


class Packer:
    def __init__(self, ar):
        self.ar = ar
        self.meshes = {}      # aid -> (key,pid)
        self.textures = {}    # aid -> (key,pid,role)
        self.audio = {}       # aid -> (key,pid)
        self.materials = {}   # aid -> dict
        self.skinned = set()  # mesh aids used by SkinnedMeshRenderers (need bind poses)
        self.prefab_index = None
        for d in ('meshes', 'tex', 'audio'):
            os.makedirs(os.path.join(ASSETS, d), exist_ok=True)
        mf = os.path.join(ASSETS, 'materials.json')
        if os.path.exists(mf):
            self.materials = json.load(open(mf, encoding='utf-8'))

    # ---------- refs ----------
    def kp(self, aid):
        cid, pid = aid.rsplit('_', 1)
        return self.ar.key_by_id[cid], int(pid)

    def ref(self, aid):
        """Describe an asset id: class + name."""
        k, p = self.kp(aid)
        return self.ar.cls(k, p), self.ar.name(k, p)

    def resolve_refs(self, key, obj, depth=0):
        """Recursively replace PPtrs in MonoBehaviour data with {'$': aid, 'c': cls, 'n': name}; schedules audio."""
        if isinstance(obj, dict):
            if set(obj.keys()) == {'m_FileID', 'm_PathID'}:
                r = self.ar.resolve(key, obj)
                if not r:
                    return None
                cls, name = self.ar.cls(*r), self.ar.name(*r)
                aid = self.ar.aid(*r)
                if cls == 'AudioClip':
                    self.audio[aid] = r
                return {'$': aid, 'c': cls, 'n': name}
            return {k: self.resolve_refs(key, v, depth + 1) for k, v in obj.items()}
        if isinstance(obj, list):
            return [self.resolve_refs(key, v, depth + 1) for v in obj]
        return obj

    # ---------- materials ----------
    def material(self, aid):
        if aid in self.materials:
            m = self.materials[aid]
            for slot, role in (('map', 'color'), ('normalMap', 'normal'), ('maskMap', 'mask'), ('emissiveMap', 'color')):
                t = m.get(slot)
                if t and t['id'] not in self.textures:
                    self.textures[t['id']] = self.kp(t['id']) + (role,)
            return m
        key, pid = self.kp(aid)
        mj = self.ar.json(key, pid)
        if mj.get('_missing'):
            self.materials[aid] = {'name': '?'}
            return self.materials[aid]
        sh = self.ar.resolve(key, mj.get('m_Shader'))
        shader = self.ar.name(*sh) if sh else '?'
        sp = mj.get('m_SavedProperties', {})
        te, fl, co = sp.get('m_TexEnvs', {}), sp.get('m_Floats', {}), sp.get('m_Colors', {})
        def norm(x):
            if isinstance(x, dict):
                return x
            return {(t['first'] if 'first' in t else list(t.keys())[0]): (t['second'] if 'second' in t else list(t.values())[0]) for t in x}
        te, fl, co = norm(te), norm(fl), norm(co)
        m = {'name': mj.get('m_Name'), 'shader': shader, 'queue': mj.get('m_CustomRenderQueue', -1), 'keywords': mj.get('m_ValidKeywords', [])}
        def tex(slot, role):
            v = te.get(slot)
            if not isinstance(v, dict):
                return None
            r = self.ar.resolve(key, v.get('m_Texture'))
            if not r or self.ar.cls(*r) not in ('Texture2D',):
                return None
            taid = self.ar.aid(*r)
            if taid not in self.textures or self.textures[taid][2] == 'color':
                self.textures[taid] = (r[0], r[1], role)
            sc, of = v.get('m_Scale', {}), v.get('m_Offset', {})
            return {'id': taid, 'scale': [sc.get('m_X', 1), sc.get('m_Y', 1)], 'offset': [of.get('m_X', 0), of.get('m_Y', 0)]}
        m['map'] = tex('_BaseColorMap', 'color') or tex('_MainTex', 'color') or tex('_UnlitColorMap', 'color')
        m['normalMap'] = tex('_NormalMap', 'normal') or tex('_BumpMap', 'normal')
        m['maskMap'] = tex('_MaskMap', 'mask')
        m['emissiveMap'] = tex('_EmissiveColorMap', 'color') or tex('_EmissionMap', 'color')
        m['detailMap'] = tex('_DetailMap', 'detail')
        c = co.get('_BaseColor') or co.get('_Color') or co.get('_UnlitColor') or {'m_R': 1, 'm_G': 1, 'm_B': 1, 'm_A': 1}
        m['color'] = [c.get('m_R', 1), c.get('m_G', 1), c.get('m_B', 1), c.get('m_A', 1)]
        e = co.get('_EmissiveColor') or co.get('_EmissionColor') or {'m_R': 0, 'm_G': 0, 'm_B': 0}
        m['emissive'] = [e.get('m_R', 0), e.get('m_G', 0), e.get('m_B', 0)]
        m['emissiveIntensity'] = fl.get('_EmissiveIntensity', 1)
        m['useEmissiveIntensity'] = fl.get('_UseEmissiveIntensity', 0)
        m['emissiveExposureWeight'] = fl.get('_EmissiveExposureWeight', 1)
        m['metallic'] = fl.get('_Metallic', 0)
        m['smoothness'] = fl.get('_Smoothness', fl.get('_Glossiness', 0.5))
        m['normalScale'] = fl.get('_NormalScale', 1)
        m['surfaceType'] = fl.get('_SurfaceType', 0)
        m['blendMode'] = fl.get('_BlendMode', 0)
        m['alphaTest'] = fl.get('_AlphaCutoffEnable', 0)
        m['cutoff'] = fl.get('_AlphaCutoff', fl.get('_Cutoff', 0.5))
        m['doubleSided'] = fl.get('_DoubleSidedEnable', 0)
        m['cull'] = fl.get('_CullMode', 2)
        m['zwrite'] = fl.get('_ZWrite', 1)
        m['smoothnessRemap'] = [fl.get('_SmoothnessRemapMin', 0), fl.get('_SmoothnessRemapMax', 1)]
        m['aoRemap'] = [fl.get('_AORemapMin', 0), fl.get('_AORemapMax', 1)]
        self.materials[aid] = m
        return m

    # ---------- nodes ----------
    def convert_node(self, n, key_of_node):
        """Mirror X: pos (-x,y,z), quat (x,-y,-z,w), scale unchanged."""
        p, r, s = n['p'], n['r'], n['s']
        out = {'id': n['id'], 'name': n['name'], 'active': n['active'], 'layer': n['layer'], 'tag': n['tag'], 'parent': n['parent'],
               'p': [-p[0], p[1], p[2]], 'r': [r[0], -r[1], -r[2], r[3]], 's': s, 'comps': []}
        if n.get('mesh'):
            out['mesh'] = n['mesh']
        pb = next((c for c in n['comps'] if c['t'] == 'MB' and c['cls'].endswith('ProBuilderMesh') and c.get('d')), None)
        pbid = None
        if pb and (not n.get('mesh') or any(c['t'] == 'MeshCol' and not c.get('mesh') for c in n['comps'])):
            pbid = 'pb_' + n['id']
            dst = os.path.join(ASSETS, 'meshes', pbid + '.glb')
            if not os.path.exists(dst):
                try:
                    if not write_pb_glb(pb['d'], dst):
                        pbid = None
                except Exception as e:
                    print('   !! probuilder failed', n['name'], e); pbid = None
            if pbid and not n.get('mesh'):
                out['mesh'] = pbid
        for c in n['comps']:
            t = c['t']
            if t == 'MR':
                if not c['enabled']:
                    continue
                mats = [m for m in c['mats']]
                for m in mats:
                    if m:
                        self.material(m)
                if out.get('mesh') and not out['mesh'].startswith('pb_'):
                    self.meshes[out['mesh']] = self.kp(out['mesh'])
                out['comps'].append({'t': 'MR', 'mats': mats, 'sb': c['sb'], 'shadows': c['shadows'], 'lm': c.get('lm', 65535)})
            elif t == 'SMR':
                if c['mesh']:
                    self.meshes[c['mesh']] = self.kp(c['mesh'])
                    self.skinned.add(c['mesh'])
                for m in c['mats']:
                    if m:
                        self.material(m)
                out['comps'].append({'t': 'SMR', 'mesh': c['mesh'], 'mats': c['mats'], 'bones': c['bones'], 'root': c['root'], 'enabled': c['enabled']})
            elif t == 'Light':
                out['comps'].append(c)
            elif t == 'Audio':
                if c['clip']:
                    self.audio[c['clip']] = self.kp(c['clip'])
                out['comps'].append(c)
            elif t in ('Box', 'Capsule', 'Sphere'):
                cc = dict(c)
                cc['c'] = [-c['c'][0], c['c'][1], c['c'][2]]
                out['comps'].append(cc)
            elif t == 'MeshCol':
                cc = dict(c)
                if cc['mesh']:
                    self.meshes[cc['mesh']] = self.kp(cc['mesh'])
                elif pbid:
                    cc['mesh'] = pbid
                out['comps'].append(cc)
            elif t == 'MB':
                cls = c['cls']
                if any(cls.startswith(d) for d in DROP_MB):
                    continue
                mb = {'t': 'MB', 'cls': cls.split('.')[-1], 'enabled': c['enabled']}
                if 'd' in c:
                    k, _ = self.kp(c['_key'])
                    mb['d'] = self.resolve_refs(k, c['d'])
                out['comps'].append(mb)
            elif t in ('Animator', 'LOD'):
                out['comps'].append(c)
            elif t in ('ParticleSystem', 'Camera', 'Rigidbody', 'NavMeshObstacle', 'CharacterController', 'LineRenderer', 'SpriteRenderer', 'NavMeshAgent'):
                out['comps'].append({'t': t})
        return out

    def pack_hierarchy(self, hkey, hpid, out_path, prune=None, root_filter=None):
        d = walk(self.ar, hkey, hpid)
        nodes = d['nodes']
        byid = {n['id']: n for n in nodes}
        # prune subtrees by name
        drop = set()
        if prune:
            for n in nodes:
                if n['name'] in prune:
                    drop.add(n['id'])
            changed = True
            while changed:
                changed = False
                for n in nodes:
                    if n['id'] not in drop and n['parent'] in drop:
                        drop.add(n['id']); changed = True
        keep = []
        if root_filter:
            # keep only subtrees whose root name matches
            roots = {n['id'] for n in nodes if n['name'] in root_filter}
            allowed = set(roots)
            changed = True
            while changed:
                changed = False
                for n in nodes:
                    if n['id'] not in allowed and n['parent'] in allowed:
                        allowed.add(n['id']); changed = True
            for n in nodes:
                if n['id'] in allowed and n['id'] not in drop:
                    keep.append(n)
            # bake the world transform of each filtered root so it keeps its scene placement
            import numpy as np
            def trs(n):
                x, y, z, w = n['r']
                R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                              [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                              [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
                M = np.eye(4); M[:3, :3] = R @ np.diag(n['s']); M[:3, 3] = n['p']
                return M
            for n in keep:
                if n['id'] in roots:
                    M = trs(n); par = byid.get(n['parent']) if n['parent'] else None
                    while par:
                        M = trs(par) @ M
                        par = byid.get(par['parent']) if par['parent'] else None
                    n['parent'] = None
                    n['p'] = M[:3, 3].tolist()
                    sx, sy, sz = [float(np.linalg.norm(M[:3, i])) for i in range(3)]
                    R = M[:3, :3] / np.array([sx, sy, sz])
                    t = R[0, 0] + R[1, 1] + R[2, 2]
                    if t > 0:
                        S = (t + 1) ** 0.5 * 2; w = 0.25 * S; x = (R[2, 1] - R[1, 2]) / S; y = (R[0, 2] - R[2, 0]) / S; z = (R[1, 0] - R[0, 1]) / S
                    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
                        S = (1 + R[0, 0] - R[1, 1] - R[2, 2]) ** 0.5 * 2; w = (R[2, 1] - R[1, 2]) / S; x = 0.25 * S; y = (R[0, 1] + R[1, 0]) / S; z = (R[0, 2] + R[2, 0]) / S
                    elif R[1, 1] > R[2, 2]:
                        S = (1 + R[1, 1] - R[0, 0] - R[2, 2]) ** 0.5 * 2; w = (R[0, 2] - R[2, 0]) / S; x = (R[0, 1] + R[1, 0]) / S; y = 0.25 * S; z = (R[1, 2] + R[2, 1]) / S
                    else:
                        S = (1 + R[2, 2] - R[0, 0] - R[1, 1]) ** 0.5 * 2; w = (R[1, 0] - R[0, 1]) / S; x = (R[0, 2] + R[2, 0]) / S; y = (R[1, 2] + R[2, 1]) / S; z = 0.25 * S
                    n['r'] = [float(x), float(y), float(z), float(w)]
                    n['s'] = [sx, sy, sz]
        else:
            keep = [n for n in nodes if n['id'] not in drop]
        out_nodes = [self.convert_node(n, None) for n in keep]
        # MonoBehaviour refs to Transform components -> the owning node id (so JS can find the object)
        tr2go = d.get('tr2go', {})
        def remap(o):
            if isinstance(o, dict):
                if o.get('c') == 'Transform' and o.get('$') in tr2go:
                    o['$'] = tr2go[o['$']]; o['c'] = 'Node'
                else:
                    for v in o.values():
                        remap(v)
            elif isinstance(o, list):
                for v in o:
                    remap(v)
        for n in out_nodes:
            for c in n['comps']:
                if c.get('t') == 'MB' and 'd' in c:
                    remap(c['d'])
        managers = []
        for m in d.get('managers', []):
            if m['cls'] == 'RenderSettings':
                rs = m['d']
                managers.append({'cls': 'RenderSettings', 'fog': rs.get('m_Fog'), 'fogColor': rs.get('m_FogColor'), 'fogMode': rs.get('m_FogMode'),
                                 'fogDensity': rs.get('m_FogDensity'), 'fogStart': rs.get('m_LinearFogStart'), 'fogEnd': rs.get('m_LinearFogEnd'),
                                 'ambient': rs.get('m_AmbientSkyColor'), 'ambientIntensity': rs.get('m_AmbientIntensity')})
        res = {'name': d['name'], 'nodes': out_nodes, 'managers': managers}
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        txt = json.dumps(res, separators=(',', ':')).replace('-Infinity', '-1e30').replace('Infinity', '1e30').replace('NaN', '0')
        open(out_path, 'w', encoding='utf-8').write(txt)
        print(f'  packed {d["name"]}: {len(out_nodes)} nodes -> {os.path.relpath(out_path, ROOT)}')
        return res

    # ---------- prefab lookup ----------
    def build_prefab_index(self):
        if self.prefab_index is not None:
            return self.prefab_index
        idx = {}
        g0 = self.ar.key_by_id['g0']
        coll = self.ar.coll(g0)
        pids = list(coll.assets.keys())
        self.ar.prefetch([(g0, p) for p in pids])
        for p in pids:
            h = self.ar.json(g0, p)
            r = self.ar.resolve(g0, h.get('Root', {}))
            if r:
                idx[self.ar.aid(*r)] = p
                idx[h.get('Name')] = p
        self.prefab_index = idx
        return idx

    def pack_prefab(self, root_aid_or_name, out_path, **kw):
        idx = self.build_prefab_index()
        p = idx.get(root_aid_or_name)
        if p is None:
            print('  !! prefab not found:', root_aid_or_name)
            return None
        return self.pack_hierarchy(self.ar.key_by_id['g0'], p, out_path, **kw)

    # ---------- binary assets ----------
    def flush(self, workers=8):
        json.dump(self.materials, open(os.path.join(ASSETS, 'materials.json'), 'w', encoding='utf-8'), separators=(',', ':'))
        jobs = []
        for aid, (k, p) in self.meshes.items():
            dst = os.path.join(ASSETS, 'meshes', aid + '.glb')
            if not os.path.exists(dst):
                jobs.append(('glb', k, p, dst, None))
        for aid, (k, p) in self.audio.items():
            dst = os.path.join(ASSETS, 'audio', aid + '.ogg')
            if not os.path.exists(dst):
                jobs.append(('audio', k, p, dst, None))
        for aid, (k, p, role) in self.textures.items():
            dst = os.path.join(ASSETS, 'tex', aid + '.png')
            if not os.path.exists(dst):
                jobs.append(('image', k, p, dst, role))
        print(f'  fetching {len(jobs)} binary assets ({len(self.meshes)} meshes, {len(self.textures)} textures, {len(self.audio)} clips total)')
        def run(j):
            kind, k, p, dst, role = j
            try:
                if kind == 'image':
                    tmp = dst + '.raw.png'
                    self.ar.save('image', k, p, tmp)
                    self.convert_texture(tmp, dst, role)
                    os.remove(tmp)
                else:
                    self.ar.save(kind, k, p, dst)
            except Exception as e:
                print('   !! failed', kind, self.ar.aid(k, p), e)
        with ThreadPoolExecutor(workers) as ex:
            list(ex.map(run, jobs))
        # bind poses for skinned meshes (Unity row-major e00..e33) -> assets/meshes/<aid>.bind.json
        for aid in self.skinned:
            dst = os.path.join(ASSETS, 'meshes', aid + '.bind.json')
            if os.path.exists(dst):
                continue
            try:
                mj = self.ar.json(*self.kp(aid))
                bp = mj.get('m_BindPose', [])
                rows = [[m.get(f'm_E{r}{c}', m.get(f'e{r}{c}', 0.0)) for r in range(4) for c in range(4)] for m in bp]
                json.dump({'bindposes': rows, 'boneHashes': mj.get('m_BoneNameHashes', []), 'root': mj.get('m_RootBoneNameHash', 0)}, open(dst, 'w'))
            except Exception as e:
                print('   !! bindpose failed', aid, e)
        # texture meta (sizes) for the loader
        meta = {}
        for aid in self.textures:
            f = os.path.join(ASSETS, 'tex', aid + '.png')
            if os.path.exists(f):
                try:
                    im = Image.open(f); meta[aid] = [im.size[0], im.size[1], self.textures[aid][2]]
                except Exception:
                    pass
        old = {}
        tf = os.path.join(ASSETS, 'textures.json')
        if os.path.exists(tf):
            old = json.load(open(tf))
        old.update(meta)
        json.dump(old, open(tf, 'w'), separators=(',', ':'))

    @staticmethod
    def convert_texture(src, dst, role):
        im = Image.open(src)
        if role == 'normal':
            im = im.convert('RGBA')
            import numpy as np
            a = np.asarray(im).astype(np.float32) / 255.0
            r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
            # DXT5nm swizzle: X in alpha, Y in green, R ~ 1. BC5: X in red, Y in green, B = 0/1.
            if r.mean() > 0.9 and al.std() > 0.01:
                x, y = al, g
            elif b.std() < 0.01 and (b.mean() < 0.05 or b.mean() > 0.95):
                x, y = r, g
            else:
                x, y = r, g
                if b.std() > 0.01:
                    Image.fromarray((a[..., :3] * 255).astype(np.uint8), 'RGB').save(dst, optimize=False)
                    return
            nx, ny = x * 2 - 1, y * 2 - 1
            nz = np.sqrt(np.clip(1 - nx * nx - ny * ny, 0, 1))
            out = np.stack([(nx + 1) / 2, (ny + 1) / 2, (nz + 1) / 2], -1)
            Image.fromarray((out * 255).astype(np.uint8), 'RGB').save(dst, optimize=False)
        elif role == 'mask':
            im = im.convert('RGBA')
            import numpy as np
            a = np.asarray(im)
            # HDRP mask: R metallic, G AO, B detail, A smoothness -> three ORM: R AO, G roughness, B metallic
            orm = np.stack([a[..., 1], 255 - a[..., 3], a[..., 0]], -1)
            Image.fromarray(orm.astype(np.uint8), 'RGB').save(dst, optimize=False)
        else:
            if im.mode not in ('RGB', 'RGBA'):
                im = im.convert('RGBA')
            # drop useless alpha to keep files small
            if im.mode == 'RGBA':
                ext = im.getextrema()
                if ext[3][0] == 255:
                    im = im.convert('RGB')
            im.save(dst, optimize=False)


if __name__ == '__main__':
    ar = AR()
    pk = Packer(ar)
    what = sys.argv[1:] or ['ship']
    if 'ship' in what:
        print('== ship')
        pk.pack_hierarchy(ar.key_by_id['g9'], 1, os.path.join(ASSETS, 'scenes', 'ship.json'), root_filter={'HangarShip'},
                          prune={'ShipInnerRoomBoundsTrigger', 'PlacementBlockers', 'ShipStrictInnerRoomBounds', 'ShipBoundsTrigger', 'LandingShipNavObstacle', 'Cameras'})
    if 'moon' in what:
        print('== experimentation')
        pk.pack_hierarchy(ar.key_by_id['g8'], 1, os.path.join(ASSETS, 'scenes', 'experimentation.json'),
                          prune={'ConstructingLevelTiles', 'TestRoom', 'Editor', 'OutOfBoundsColliders', 'Cutscenes', 'ItemShipAnimContainer'})
    if 'assurance' in what:
        print('== assurance')
        pk.pack_hierarchy(ar.key_by_id['g7'], 1, os.path.join(ASSETS, 'scenes', 'assurance.json'),
                          prune={'ConstructingLevelTiles', 'TestRoom', 'Editor', 'OutOfBoundsColliders', 'Cutscenes', 'ItemShipAnimContainer'})
    if 'march' in what:
        print('== march')
        pk.pack_hierarchy(ar.key_by_id['g3'], 1, os.path.join(ASSETS, 'scenes', 'march.json'),
                          prune={'ConstructingLevelTiles', 'TestRoom', 'Editor', 'OutOfBoundsColliders', 'Cutscenes', 'ItemShipAnimContainer'})
    if 'company' in what:
        print('== company building')
        name = [n for n in ar.by_name if n.startswith('CompanyBuilding')][0]
        pk.pack_hierarchy(ar.by_name[name], 1, os.path.join(ASSETS, 'scenes', 'company.json'),
                          prune={'TestRoom', 'Cutscenes', 'StoryLogs', 'ItemShipAnimContainer', 'Canvas', 'CompanyMonstersAnims', 'Test'})
    pk.flush()
    print('done')
