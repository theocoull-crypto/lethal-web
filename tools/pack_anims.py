"""Export animation clips for every packed prefab that has an Animator: AnimatorController -> clips -> YAML curves ->
assets/anims/<clipaid>.json  (three.js friendly: per bone path position/quaternion/scale keys, X mirrored)."""
import sys, os, json, glob, re, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import yaml
from ar import AR
from pack import ASSETS

ar = AR()
OUT = os.path.join(ASSETS, 'anims')
os.makedirs(OUT, exist_ok=True)


def unity_yaml(txt):
    class L(yaml.SafeLoader):
        pass
    L.add_multi_constructor('tag:unity3d.com,2011:', lambda loader, suffix, node: loader.construct_mapping(node, deep=True))
    txt = '\n'.join(l for l in txt.splitlines() if not l.startswith('%'))
    txt = re.sub(r'!u!\d+\s*', '', txt)
    docs = list(yaml.load_all(txt, Loader=L))
    return docs


def euler_to_quat(x, y, z):
    """Unity Euler (degrees, ZXY order) -> quaternion (x,y,z,w) in Unity space."""
    rx, ry, rz = math.radians(x), math.radians(y), math.radians(z)
    cx, sx = math.cos(rx / 2), math.sin(rx / 2)
    cy, sy = math.cos(ry / 2), math.sin(ry / 2)
    cz, sz = math.cos(rz / 2), math.sin(rz / 2)
    # q = qy * qx * qz
    qx = (sx, 0, 0, cx); qy = (0, sy, 0, cy); qz = (0, 0, sz, cz)
    def mul(a, b):
        ax, ay, az, aw = a; bx, by, bz, bw = b
        return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)
    return mul(mul(qy, qx), qz)


def convert_clip(key, pid):
    txt = ar.yaml(key, pid)
    docs = unity_yaml(txt)
    clip = None
    for d in docs:
        if isinstance(d, dict) and 'AnimationClip' in d:
            clip = d['AnimationClip']; break
    if clip is None:
        return None
    tracks = {}
    def tr(path):
        return tracks.setdefault(path, {'pos': [], 'rot': [], 'scale': []})
    for c in clip.get('m_EulerCurves') or []:
        path = c.get('path', '')
        keys = c['curve']['m_Curve']
        out = tr(path)['rot']
        for k in keys:
            v = k['value']; q = euler_to_quat(v['x'], v['y'], v['z'])
            out.append([k['time'], q[0], -q[1], -q[2], q[3]])
    for c in clip.get('m_RotationCurves') or []:
        path = c.get('path', '')
        out = tr(path)['rot']
        for k in c['curve']['m_Curve']:
            v = k['value']; out.append([k['time'], v['x'], -v['y'], -v['z'], v['w']])
    for c in clip.get('m_PositionCurves') or []:
        path = c.get('path', '')
        out = tr(path)['pos']
        for k in c['curve']['m_Curve']:
            v = k['value']; out.append([k['time'], -v['x'], v['y'], v['z']])
    for c in clip.get('m_ScaleCurves') or []:
        path = c.get('path', '')
        out = tr(path)['scale']
        for k in c['curve']['m_Curve']:
            v = k['value']; out.append([k['time'], v['x'], v['y'], v['z']])
    # float curves: only keep active / weight style props (IK weights, GameObject active toggles) as generic
    floats = []
    for c in clip.get('m_FloatCurves') or []:
        attr = c.get('attribute', ''); path = c.get('path', '')
        keys = [[k['time'], k['value']] for k in c['curve']['m_Curve']]
        floats.append({'path': path, 'attr': attr, 'keys': keys, 'classID': c.get('classID')})
    events = [{'time': e.get('time'), 'name': e.get('functionName'), 's': e.get('data')} for e in (clip.get('m_Events') or [])]
    length = clip.get('m_MuscleClip', {}).get('m_StopTime') if isinstance(clip.get('m_MuscleClip'), dict) else None
    if not length:
        length = max([k[0] for t in tracks.values() for arr in t.values() for k in arr] + [f['keys'][-1][0] for f in floats if f['keys']] + [0.0])
    return {'name': clip.get('m_Name'), 'length': length, 'rate': clip.get('m_SampleRate', 60), 'loop': bool((clip.get('m_AnimationClipSettings') or {}).get('m_LoopTime', 0)), 'tracks': tracks, 'floats': floats, 'events': events}


def kp(aid):
    cid, pid = aid.rsplit('_', 1)
    return ar.key_by_id[cid], int(pid)


index = {}
files = glob.glob(os.path.join(ASSETS, 'prefabs', '*.json')) + [os.path.join(ASSETS, 'scenes', 'ship.json'), os.path.join(ASSETS, 'scenes', 'player.json')]
for f in files:
    m = json.load(open(f, encoding='utf-8'))
    for n in m['nodes']:
        for c in n['comps']:
            if c['t'] == 'Animator' and c.get('controller'):
                ctrl = c['controller']
                if ctrl in index:
                    continue
                k, p = kp(ctrl)
                cj = ar.json(k, p)
                clips = []
                seen = set()
                for pp in cj.get('m_AnimationClips', []):
                    r = ar.resolve(k, pp)
                    if not r or ar.aid(*r) in seen:
                        continue
                    seen.add(ar.aid(*r))
                    aid = ar.aid(*r)
                    dst = os.path.join(OUT, aid + '.json')
                    if not os.path.exists(dst):
                        try:
                            data = convert_clip(*r)
                            if data:
                                json.dump(data, open(dst, 'w'), separators=(',', ':'))
                        except Exception as e:
                            print('  !! clip failed', aid, ar.name(*r), e); continue
                    clips.append({'id': aid, 'name': ar.name(*r)})
                # state machine: layer 0 states -> clip names (for default state)
                states = []
                for layer in (cj.get('m_AnimatorLayers') or [])[:1]:
                    pass
                index[ctrl] = {'name': cj.get('m_Name'), 'clips': clips, 'owner': os.path.basename(f)}
                print(os.path.basename(f), '->', cj.get('m_Name'), len(clips), 'clips:', ', '.join(x['name'] for x in clips)[:200])
json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), indent=1)
print('controllers:', len(index))
