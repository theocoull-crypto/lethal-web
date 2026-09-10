// Procedural facility built from the game's own DunGen tiles (Level1Flow), simplified re-implementation of DunGen.
import * as THREE from 'three';
import { Collider, collisionEntries } from './collision.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Animator } from './anim.js';

const V = (o, mirror = true) => new THREE.Vector3(mirror ? -o.x : o.x, o.y, o.z);

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function evalCurve(curve, t) {
  if (!curve || !curve.length) return 1;
  if (t <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i][0]) { const a = curve[i - 1], b = curve[i]; const f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]); return a[1] + (b[1] - a[1]) * f; }
  }
  return curve[curve.length - 1][1];
}

export class Dungeon {
  constructor(game) {
    this.game = game; this.lib = game.lib;
    this.root = new THREE.Group(); this.root.name = 'Dungeon'; this.root.visible = false;
    game.scene.add(this.root);
    this.catalog = null;
    this.tileDefs = new Map();     // prefab file -> parsed def
    this.prefabCache = new Map();  // file -> manifest
    this.placed = [];
    this.collider = null;
    this.interactables = [];
    this.entranceInside = null; this.fireExitInside = null;
    this.scrapSpawns = []; this.hazardSpawns = []; this.vents = []; this.lights = [];
    this.doors = [];
    this.graph = null;
    this.seed = 1;
  }

  async load() {
    this.catalog = await fetch('assets/catalog.json').then(r => r.json());
    const files = new Set();
    for (const set of Object.values(this.catalog.tileSets)) for (const e of set) files.add(e.prefab);
    for (const f of this.catalog.doorParts) files.add(f);
    await Promise.all([...files].map(f => this.prefab(f)));
    for (const f of files) this.parseTile(f);
  }

  async prefab(file) {
    if (!this.prefabCache.has(file)) this.prefabCache.set(file, this.lib.manifest('prefabs/' + file).catch(() => null));
    return this.prefabCache.get(file);
  }

  parseTile(file) {
    const man = this.prefabCache.get(file) && this._sync(file);
  }
  _sync(file) { return null; }

  /** Build a tile definition from its manifest (needs manifest resolved). */
  async tileDef(file) {
    if (this.tileDefs.has(file)) return this.tileDefs.get(file);
    const man = await this.prefab(file);
    if (!man) return null;
    const byId = new Map(man.nodes.map(n => [n.id, n]));
    const root = man.nodes.find(n => !n.parent);
    // local matrices (three space) for every node relative to the tile root
    const mats = new Map();
    const localOf = n => new THREE.Matrix4().compose(new THREE.Vector3(...n.p), new THREE.Quaternion(...n.r), new THREE.Vector3(...n.s));
    const worldOf = n => {
      if (mats.has(n.id)) return mats.get(n.id);
      let m;
      if (!n.parent || n.id === root.id) m = new THREE.Matrix4(); // root transform is reset on spawn
      else m = new THREE.Matrix4().multiplyMatrices(worldOf(byId.get(n.parent)), localOf(n));
      mats.set(n.id, m); return m;
    };
    let tile = null; const doorways = [];
    for (const n of man.nodes) {
      for (const c of n.comps) {
        if (c.t !== 'MB' || !c.d) continue;
        if (c.cls === 'Tile') tile = c.d;
        if (c.cls === 'Doorway') {
          const m = worldOf(n); const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
          m.decompose(pos, q, s);
          const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q); fwd.y = 0; fwd.normalize();
          doorways.push({
            node: n, pos, q, fwd, socket: (c.d.socket || {}).n || 'NormalDoor', priority: c.d.DoorPrefabPriority || 0,
            connectors: (c.d.ConnectorPrefabWeights || []).map(w => w.GameObject && w.GameObject.$).filter(Boolean),
            connectorWeights: (c.d.ConnectorPrefabWeights || []).filter(w => w.GameObject && w.GameObject.$).map(w => w.Weight ?? 1),
            blockers: (c.d.BlockerPrefabWeights || []).map(w => w.GameObject && w.GameObject.$).filter(Boolean),
            blockerWeights: (c.d.BlockerPrefabWeights || []).filter(w => w.GameObject && w.GameObject.$).map(w => w.Weight ?? 1),
            connScene: (c.d.ConnectorSceneObjects || []).map(x => x && x.$).filter(Boolean),
            blockScene: (c.d.BlockerSceneObjects || []).map(x => x && x.$).filter(Boolean),
          });
        }
      }
    }
    let b = null;
    if (tile) {
      const src = tile.OverrideAutomaticTileBounds ? tile.TileBoundsOverride : tile.placement && tile.placement.localBounds;
      if (src) {
        const c = V(src.m_Center), e = src.m_Extent;
        b = new THREE.Box3(new THREE.Vector3(c.x - e.x, c.y - e.y, c.z - e.z), new THREE.Vector3(c.x + e.x, c.y + e.y, c.z + e.z));
      }
    }
    if (!b) b = new THREE.Box3(new THREE.Vector3(-5, -1, -5), new THREE.Vector3(5, 5, 5));
    const def = { file, man, byId, root, tile, doorways, bounds: b, allowRotation: tile ? tile.AllowRotation !== false : true, repeat: tile ? tile.RepeatMode : 0, worldOf };
    this.tileDefs.set(file, def);
    return def;
  }

  // ------------------------------------------------------------ generation
  async generate(seed) {
    this.clear();
    this.seed = seed;
    for (let attempt = 0; attempt < 12; attempt++) {
      const rnd = mulberry32(seed + attempt * 7919);
      this.rnd = rnd;
      const ok = await this._generateOnce(rnd);
      if (ok) break;
      this.placed = [];
      console.warn('dungeon: retrying generation', attempt);
    }
    await this._finalize();
    console.log('dungeon: placed', this.placed.length, 'tiles, doors', this.doors.length, 'scrap spawns', this.scrapSpawns.length, 'vents', this.vents.length, 'fire exits', this.fireExits.length);
  }

  pickWeighted(entries, rnd, key, depth) {
    let total = 0; const ws = entries.map(e => { const w = Math.max(0, (e[key] ?? 1) * evalCurve(e.depthCurve, depth)); total += w; return w; });
    if (total <= 0) return entries[Math.floor(rnd() * entries.length)];
    let r = rnd() * total;
    for (let i = 0; i < entries.length; i++) { r -= ws[i]; if (r <= 0) return entries[i]; }
    return entries[entries.length - 1];
  }

  archetypeAt(f) {
    const lines = this.catalog.flow.lines;
    for (const l of lines) if (f >= l.pos - 1e-6 && f <= l.pos + l.len + 1e-6) return l.archetypes[0];
    return lines[lines.length - 1].archetypes[0];
  }

  async _generateOnce(rnd) {
    const flow = this.catalog.flow;
    const L = flow.Length.Min + Math.floor(rnd() * (flow.Length.Max - flow.Length.Min + 1));
    // start tile
    const startSet = this.catalog.tileSets[flow.nodes[0].tileSets[0]];
    const startDef = await this.tileDef(startSet[0].prefab);
    const start = this._place(startDef, new THREE.Matrix4(), null, null, 0, true);
    this.placed.push(start);
    let prev = start;
    for (let i = 1; i < L; i++) {
      const f = i / (L - 1);
      let entries;
      if (i === L - 1) entries = this.catalog.tileSets[flow.nodes[1].tileSets[0]];
      else { const arch = this.archetypeAt(f); entries = [].concat(...arch.tileSets.map(n => this.catalog.tileSets[n])); }
      const next = await this._attach(prev, entries, rnd, 'main', f, i);
      if (!next) {
        // backtrack once
        if (this.placed.length > 2) { const bad = this.placed.pop(); this._unplace(bad); prev = this.placed[this.placed.length - 1]; i -= 2; if (i < 0) return false; continue; }
        return false;
      }
      this.placed.push(next); prev = next;
    }
    // branches
    const mainTiles = this.placed.slice();
    const want = flow.BranchCount.Min + Math.floor(rnd() * (flow.BranchCount.Max - flow.BranchCount.Min + 1));
    let made = 0, tries = 0;
    while (made < want && tries < want * 6) {
      tries++;
      const from = mainTiles[1 + Math.floor(rnd() * (mainTiles.length - 1))];
      const arch = this.archetypeAt(from.depthF);
      const blen = 1 + Math.floor(rnd() * 3);
      let cur = from; let grown = 0;
      for (let j = 0; j < blen; j++) {
        const last = j === blen - 1;
        let entries;
        if (j === 0 && arch.branchStart.length && rnd() < 0.5) entries = [].concat(...arch.branchStart.map(n => this.catalog.tileSets[n]));
        else if (last && arch.branchCap.length) entries = [].concat(...arch.branchCap.map(n => this.catalog.tileSets[n]));
        else entries = [].concat(...arch.tileSets.map(n => this.catalog.tileSets[n]));
        const t = await this._attach(cur, entries, rnd, 'branch', from.depthF, from.index, j / Math.max(1, blen - 1));
        if (!t) break;
        this.placed.push(t); cur = t; grown++;
      }
      if (grown) made++;
    }
    return this.placed.length >= L;
  }

  _place(def, matrix, viaDoorway, parentTile, index, isMain) {
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    matrix.decompose(pos, q, s);
    const bounds = def.bounds.clone().applyMatrix4(matrix);
    const doorways = def.doorways.map(d => ({ def: d, pos: d.pos.clone().applyMatrix4(matrix), fwd: d.fwd.clone().applyQuaternion(q).normalize(), q: q.clone().multiply(d.q), used: false, connected: null, socket: d.socket }));
    return { def, matrix, pos, q, bounds, doorways, parent: parentTile, index, isMain, depthF: 0, obj: null, viaDoorway };
  }

  _unplace(t) { if (t.viaDoorway) { t.viaDoorway.used = false; t.viaDoorway.connected = null; } }

  async _attach(prev, entries, rnd, kind, depthF, index, branchF = 0) {
    const open = prev.doorways.filter(d => !d.used);
    if (!open.length) return null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const e = this.pickWeighted(entries, rnd, kind === 'main' ? 'main' : 'branch', kind === 'main' ? depthF : branchF);
      const def = await this.tileDef(e.prefab);
      if (!def) continue;
      if (def.repeat === 2 && this.placed.some(p => p.def === def) && rnd() < 0.85) continue; // DisallowImmediate/ Disallow
      if (def.repeat === 1 && prev.def === def) continue;
      const shuffled = open.slice().sort(() => rnd() - 0.5);
      for (const pd of shuffled) {
        const cands = def.doorways.filter(d => d.socket === pd.socket);
        if (!cands.length) continue;
        const cd = cands[Math.floor(rnd() * cands.length)];
        // rotation so that cd.fwd == -pd.fwd
        const target = pd.fwd.clone().negate();
        const yawT = Math.atan2(target.x, target.z), yawC = Math.atan2(cd.fwd.x, cd.fwd.z);
        const yaw = def.allowRotation ? yawT - yawC : 0;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        const rotatedDoor = cd.pos.clone().applyQuaternion(q);
        const pos = pd.pos.clone().sub(rotatedDoor);
        const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
        const t = this._place(def, m, pd, prev, index, kind === 'main');
        t.depthF = depthF;
        if (this._overlaps(t)) continue;
        pd.used = true; pd.connected = t;
        const cdw = t.doorways.find(d => d.def === cd); cdw.used = true; cdw.connected = prev;
        t.viaDoorway = pd; t.entryDoorway = cdw;
        return t;
      }
    }
    return null;
  }

  _overlaps(t) {
    const b = t.bounds.clone(); b.min.addScalar(0.3); b.max.addScalar(-0.3);
    for (const p of this.placed) { if (p.bounds.intersectsBox(b)) return true; }
    return false;
  }

  // ------------------------------------------------------------ build meshes
  async _finalize() {
    const lib = this.lib;
    const collision = [];
    const propGroups = new Map();
    this._propGroups = propGroups;
    this._pendingSynced = [];
    this.doors = []; this.scrapSpawns = []; this.hazardSpawns = []; this.vents = []; this.lights = []; this.interactables = []; this.fireExits = [];
    for (const t of this.placed) {
      const inst = await lib.instantiate(t.def.man, { lights: true, filter: n => true });
      const rootObj = inst.root.children[0];
      // reset prefab root transform, apply placement
      rootObj.position.set(0, 0, 0); rootObj.quaternion.identity(); rootObj.scale.set(1, 1, 1);
      inst.root.matrix.copy(t.matrix); inst.root.matrix.decompose(inst.root.position, inst.root.quaternion, inst.root.scale);
      this.root.add(inst.root);
      inst.root.updateMatrixWorld(true);
      t.obj = inst.root; t.inst = inst;
      // doorway scene objects
      for (const d of t.doorways) {
        const on = d.used ? d.def.connScene : d.def.blockScene, off = d.used ? d.def.blockScene : d.def.connScene;
        for (const id of on) { const o = inst.objs.get(id); if (o) o.visible = true; }
        for (const id of off) { const o = inst.objs.get(id); if (o) o.visible = false; }
      }
      // props: local prop sets + global props
      const propNodes = new Set();
      for (const n of t.def.man.nodes) for (const c of n.comps) {
        if (c.t !== 'MB' || !c.d) continue;
        if (c.cls === 'LocalPropSet') {
          const ws = (c.d.Props && c.d.Props.Weights) || [];
          const ids = ws.map(w => w.Value && w.Value.$).filter(Boolean);
          ids.forEach(id => propNodes.add(id));
          const min = c.d.PropCount ? c.d.PropCount.Min : 1, max = c.d.PropCount ? c.d.PropCount.Max : 1;
          const count = min + Math.floor(this.rnd() * (max - min + 1));
          const pool = ws.slice();
          for (let i = 0; i < count && pool.length; i++) {
            const pick = this.pickWeighted(pool.map(w => ({ w, main: w.MainPathWeight, branch: w.BranchPathWeight })), this.rnd, t.isMain ? 'main' : 'branch', t.depthF);
            pool.splice(pool.indexOf(pick.w), 1);
            const o = inst.objs.get(pick.w.Value && pick.w.Value.$); if (o) o.userData.propOn = true;
          }
        } else if (c.cls === 'GlobalProp') {
          propNodes.add(n.id);
          const g = c.d.PropGroupID;
          if (!propGroups.has(g)) propGroups.set(g, []);
          propGroups.get(g).push({ inst, id: n.id, main: c.d.MainPathWeight, branch: c.d.BranchPathWeight, isMain: t.isMain, depthF: t.depthF });
        } else if (c.cls === 'RandomScrapSpawn') {
          const o = inst.objs.get(n.id); if (o) this.scrapSpawns.push({ pos: o.getWorldPosition(new THREE.Vector3()), range: c.d.itemSpawnRange || 1, tile: t });
        } else if (c.cls === 'RandomMapObject') {
          const o = inst.objs.get(n.id); if (o) this.hazardSpawns.push({ pos: o.getWorldPosition(new THREE.Vector3()), range: c.d.spawnRange || 3, prefabs: (c.d.spawnablePrefabs || []).map(p => p && p.$).filter(Boolean), tile: t });
        } else if (c.cls === 'SpawnSyncedObject') {
          const o = inst.objs.get(n.id); const pf = c.d.spawnPrefab && c.d.spawnPrefab.$;
          if (o && pf) t.synced = (t.synced || []).concat([{ obj: o, prefab: pf, name: c.d.spawnPrefab.n }]);
        }
      }
      for (const id of propNodes) { const o = inst.objs.get(id); if (o && !o.userData.propOn) o.visible = false; }
    }
    // doors + blockers at doorways (their global props / synced spawns are collected, not spawned yet)
    for (const t of this.placed) {
      for (const d of t.doorways) {
        if (d.used) {
          // one side spawns the door: the side with higher priority, or the tile placed first
          const other = d.connected; const od = other.doorways.find(x => x.connected === t);
          const mine = d.def.priority > (od ? od.def.priority : -1) || (d.def.priority === (od ? od.def.priority : -1) && t.index <= other.index && d.def.connectors.length);
          // demo: the terminal-controlled blast doors (BigDoorSpawn) are left out, hallway connections stay open
          const pick = (dd) => { const ids = dd.def.connectors, ws = dd.def.connectorWeights; const keep = ids.map((id, i) => [id, ws[i]]).filter(([id]) => !this._isBigDoor(id)); return keep.length ? this._pickPart(keep.map(x => x[1]), keep.map(x => x[0])) : null; };
          if (mine && d.def.connectors.length) { const id = pick(d); if (id) await this._spawnDoorPart(d, id, t, true); }
          else if (mine && !d.def.connectors.length && od && od.def.connectors.length) { const id = pick(od); if (id) await this._spawnDoorPart(od, id, other, true); }
        } else if (d.def.blockers.length) {
          await this._spawnDoorPart(d, this._pickPart(d.def.blockerWeights, d.def.blockers), t, false);
        }
      }
      for (const s of (t.synced || [])) this._pendingSynced.push([s, t]);
    }
    // global props by group budget: tiles AND door parts together (this is what limits fire exits to one)
    for (const [g, list] of propGroups) {
      const range = (this.catalog.flow.GlobalProps || []).find(x => x.ID === g);
      const min = range ? range.Count.Min : 0, max = range ? range.Count.Max : 2;
      let count = Math.min(list.length, min + Math.floor(this.rnd() * (max - min + 1)));
      const pool = list.slice();
      while (count-- > 0 && pool.length) {
        const pick = this.pickWeighted(pool, this.rnd, 'main', 0.5);
        pool.splice(pool.indexOf(pick), 1);
        const o = pick.inst.objs.get(pick.id); if (o) o.visible = true;
      }
    }
    // synced objects (vents, valves, breaker box, entrance teleports) - only under active objects
    for (const [s, t] of this._pendingSynced) {
      let p = s.obj, on = true; while (p && p !== this.root) { if (p.visible === false) { on = false; break; } p = p.parent; }
      if (on) await this._spawnSynced(s, t);
    }
    // collision
    const entries = [];
    for (const t of this.placed) {
      const e = await collisionEntries(lib, t.inst, { exclude: n => [9, 13, 14, 15, 22, 26, 29].includes(n.layer) });
      for (const x of e) entries.push(x);
      for (const ex of (t.extraInst || [])) { const e2 = await collisionEntries(lib, ex, { exclude: n => [9, 13, 14, 15, 22, 26, 29].includes(n.layer) || n.comps.some(c => c.t === 'MB' && c.cls === 'DoorLock') }); for (const x of e2) entries.push(x); }
    }
    this.collider = new Collider('dungeon').build(entries, null);
    for (const t of this.placed) this._mergeStatic(t);
    console.log('dungeon collider tris', this.collider.triCount);
    this._buildGraph();
    this._collectLights();
    this.root.updateMatrixWorld(true);
  }

  /** Merge a tile's static meshes per material to cut draw calls (props / animated bits stay separate). */
  _mergeStatic(t) {
    const inst = t.inst; if (!inst) return;
    const groups = new Map();
    const rootInv = new THREE.Matrix4().copy(inst.root.matrixWorld).invert();
    inst.root.updateMatrixWorld(true);
    const list = [];
    inst.root.traverse(o => {
      if (!o.isMesh || o.isSkinnedMesh) return;
      let p = o, ok = true;
      while (p && p !== inst.root) { if (p.visible === false || p.userData.propOn !== undefined) { ok = false; break; } p = p.parent; }
      if (!ok) return;
      const m = o.material; if (!m || m.transparent || m.visible === false) return;
      const g = o.geometry; if (!g.attributes.position || !g.attributes.normal) return;
      list.push(o);
    });
    for (const o of list) {
      const key = o.material.uuid;
      if (!groups.has(key)) groups.set(key, { mat: o.material, geoms: [] });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', o.geometry.attributes.position);
      g.setAttribute('normal', o.geometry.attributes.normal);
      g.setAttribute('uv', o.geometry.attributes.uv || new THREE.BufferAttribute(new Float32Array(o.geometry.attributes.position.count * 2), 2));
      if (o.geometry.index) g.setIndex(o.geometry.index);
      const gg = g.toNonIndexed();
      gg.applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld));
      groups.get(key).geoms.push(gg);
      o.parent.remove(o);
    }
    let count = 0;
    for (const { mat, geoms } of groups.values()) {
      if (!geoms.length) continue;
      const merged = mergeGeometries(geoms, false);
      if (!merged) continue;
      const m = new THREE.Mesh(merged, mat); m.castShadow = true; m.receiveShadow = true; m.userData.merged = true;
      inst.root.add(m); count++;
    }
    t.mergedCount = count;
  }

  _isBigDoor(aid) { const f = this.catalog.doorParts.find(f => f.endsWith('__' + aid + '.json')); return !!f && /BigDoor/.test(f); }

  _pickPart(weights, ids) {
    let total = 0; for (const w of weights) total += Math.max(0, w);
    let r = this.rnd() * (total || ids.length);
    for (let i = 0; i < ids.length; i++) { r -= total ? Math.max(0, weights[i]) : 1; if (r <= 0) return ids[i]; }
    return ids[ids.length - 1];
  }

  async _spawnDoorPart(d, prefabAid, tile, isConnector) {
    const file = this.catalog.doorParts.find(f => f.endsWith('__' + prefabAid + '.json'));
    if (!file) return;
    const man = await this.prefab(file); if (!man) return;
    const inst = await this.lib.instantiate(man, { lights: true });
    const rootObj = inst.root.children[0];
    if (rootObj) { rootObj.position.set(0, 0, 0); rootObj.quaternion.identity(); }
    inst.root.position.copy(d.pos); inst.root.quaternion.copy(d.q);
    this.root.add(inst.root); inst.root.updateMatrixWorld(true);
    tile.extraInst = (tile.extraInst || []).concat([inst]);
    // nested synced spawns (e.g. BigDoorSpawn -> BigDoor, blockers -> EntranceTeleportB) and global props (fire exit containers)
    for (const n of man.nodes) for (const c of n.comps) {
      if (c.t !== 'MB' || !c.d) continue;
      if (c.cls === 'SpawnSyncedObject' && c.d.spawnPrefab) {
        const o = inst.objs.get(n.id); if (o) this._pendingSynced.push([{ obj: o, prefab: c.d.spawnPrefab.$, name: c.d.spawnPrefab.n }, tile]);
      } else if (c.cls === 'GlobalProp') {
        const o = inst.objs.get(n.id); if (o) o.visible = false;
        const g = c.d.PropGroupID;
        if (!this._propGroups.has(g)) this._propGroups.set(g, []);
        this._propGroups.get(g).push({ inst, id: n.id, main: c.d.MainPathWeight, branch: c.d.BranchPathWeight, isMain: tile.isMain, depthF: tile.depthF });
      }
    }
  }

  async _spawnSynced(s, tile) {
    const file = this.catalog.doorParts.find(f => f.endsWith('__' + s.prefab + '.json'));
    if (!file) return;
    const man = await this.prefab(file); if (!man) return;
    const inst = await this.lib.instantiate(man, { lights: true });
    const rootObj = inst.root.children[0];
    if (rootObj) { rootObj.position.set(0, 0, 0); rootObj.quaternion.identity(); }
    s.obj.getWorldPosition(inst.root.position); s.obj.getWorldQuaternion(inst.root.quaternion);
    this.root.add(inst.root); inst.root.updateMatrixWorld(true);
    tile.extraInst = (tile.extraInst || []).concat([inst]);
    const name = s.name || '';
    if (/BigDoor|SteelDoor|FancyDoor/.test(name)) this._setupDoor(inst, name);
    if (/^VentEntrance/.test(name)) this.vents.push({ pos: inst.root.getWorldPosition(new THREE.Vector3()), inst, tile });
    if (/^EntranceTeleportA/.test(name)) this._setupEntrance(inst, false);
    if (/^EntranceTeleportB/.test(name)) this._setupEntrance(inst, true);
  }

  _setupEntrance(inst, isFire) {
    const root = inst.root;
    const tele = root.getObjectByName('telePoint') || root;
    const p = tele.getWorldPosition(new THREE.Vector3()); const q = tele.getWorldQuaternion(new THREE.Quaternion());
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const spot = { pos: p.clone().add(new THREE.Vector3(0, 0.1, 0)), yaw: Math.atan2(-f.x, -f.z) };
    if (isFire) { this.fireExitInside = spot; this.fireExits.push(spot); } else this.entranceInside = spot;
    const doorPos = root.getWorldPosition(new THREE.Vector3());
    this.interactables.push({ pos: doorPos.clone().add(new THREE.Vector3(0, 1.2, 0)), radius: 1.6, label: () => isFire ? '[E] Exit (fire exit)' : '[E] Exit facility', action: () => this.game.exitFacility(isFire) });
  }

  _setupDoor(inst, name) {
    // SteelDoorMapModel: DoorMesh has an Animator (Door1Open / Door1Close) and a DoorSound audio source; the trigger box sits on DoorMesh/Cube
    const root = inst.root;
    const mesh = root.getObjectByName('DoorMesh');
    if (!mesh) return;
    const ac = mesh.userData.node.comps.find(c => c.t === 'Animator');
    const anim = ac && ac.controller ? new Animator(mesh, ac.controller) : null;
    if (anim) anim.load();
    let clipOpen = null, clipClose = null;
    const snd = root.getObjectByName('DoorSound');
    if (snd) { const a = snd.userData.node.comps.find(c => c.t === 'Audio'); if (a) clipOpen = clipClose = a.clip; }
    inst.manifest.nodes.forEach(n => n.comps.forEach(c => { if (c.t === 'MB' && c.d && c.cls === 'AnimatedObjectTrigger') { const o = (c.d.boolTrueAudios || []).map(x => x && x.$).filter(Boolean), cl = (c.d.boolFalseAudios || []).map(x => x && x.$).filter(Boolean); if (o[0]) clipOpen = o[0]; if (cl[0]) clipClose = cl[0]; } }));
    const door = { inst, root, mesh, anim, open: false, clipOpen, clipClose, pos: mesh.getWorldPosition(new THREE.Vector3()), collider: null };
    // the door leaf gets its own collider that follows the swing (the merged dungeon collider skips DoorLock boxes)
    const trig = mesh.children.find(c => c.userData.node && c.userData.node.comps.some(x => x.t === 'MB' && x.cls === 'DoorLock'));
    if (trig) {
      const n = trig.userData.node; const box = n.comps.find(c => c.t === 'Box' && !c.trigger);
      if (box) {
        const g = new THREE.BoxGeometry(1, 1, 1);
        const local = new THREE.Matrix4().compose(new THREE.Vector3(box.c[0], box.c[1], box.c[2]), new THREE.Quaternion(), new THREE.Vector3(box.s[0] * 1.2, box.s[1], box.s[2]));
        const m = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().copy(mesh.matrixWorld).invert(), trig.matrixWorld).multiply(local);
        door.collider = new Collider('steeldoor').build([{ geometry: g, matrix: m }], mesh);
      }
    }
    this.doors.push(door);
    // interaction point = the door leaf's trigger box (the DoorMesh pivot sits on the hinge)
    const ipos = trig ? trig.getWorldPosition(new THREE.Vector3()) : door.pos.clone().add(new THREE.Vector3(0, 1.3, 0));
    door.ipos = ipos;
    this.interactables.push({ pos: ipos, radius: 1.5, label: () => door.open ? '[E] Close door' : '[E] Use door', action: () => this.toggleDoor(door) });
  }

  toggleDoor(door) {
    door.open = !door.open;
    if (door.anim && door.anim.ready) { const n = door.anim.find(door.open ? [/Open/] : [/Close/]); if (n) door.anim.play(n, { once: true, loop: false, fade: 0.05 }); }
    const clip = door.open ? door.clipOpen : door.clipClose;
    if (clip) this.game.sound.play(clip, { pos: door.pos, vol: 0.8, min: 2, max: 30 });
    this.game.enemies.onNoise(door.pos, 0.6);
  }

  _buildGraph() {
    // waypoint graph for enemy navigation: doorway points + tile centres
    const nodes = [], edges = [];
    const add = (p, tile) => { nodes.push({ p, tile, n: [] }); return nodes.length - 1; };
    for (const t of this.placed) { t.center = t.bounds.getCenter(new THREE.Vector3()); t.center.y = t.bounds.min.y + 0.5; t.nodeId = add(t.center, t); }
    for (const t of this.placed) {
      for (const d of t.doorways) {
        if (!d.used || d.nodeId != null) continue;
        const other = d.connected; const od = other.doorways.find(x => x.connected === t);
        const id = add(d.pos.clone().add(new THREE.Vector3(0, 0.3, 0)), t);
        d.nodeId = id; if (od) od.nodeId = id;
        edges.push([t.nodeId, id]); edges.push([other.nodeId, id]);
      }
    }
    for (const [a, b] of edges) { nodes[a].n.push(b); nodes[b].n.push(a); }
    this.graph = { nodes };
  }

  _collectLights() {
    this.lights = [];
    this.root.traverse(o => {
      if (o.isPointLight || o.isSpotLight) {
        let p = o, vis = true; while (p && p !== this.root) { if (p.visible === false) { vis = false; break; } p = p.parent; }
        if (!vis) return;
        this.lights.push({ pos: o.getWorldPosition(new THREE.Vector3()), color: o.color.clone(), intensity: Math.min(o.userData.unity?.intensity || 20, 120) * 0.05, distance: Math.max((o.distance || 8) * 1.6, 13), obj: o });
        o.visible = false;
      }
    });
  }

  tileAt(p) { for (const t of this.placed) if (t.bounds.containsPoint(p)) return t; let best = null, bd = 1e9; for (const t of this.placed) { const d = t.bounds.distanceToPoint(p); if (d < bd) { bd = d; best = t; } } return best; }

  nearestNode(p) { let b = -1, bd = 1e9; this.graph.nodes.forEach((n, i) => { const d = n.p.distanceToSquared(p); if (d < bd) { bd = d; b = i; } }); return b; }

  path(from, to) {
    const N = this.graph.nodes; const a = this.nearestNode(from), b = this.nearestNode(to);
    if (a < 0 || b < 0) return [];
    const prev = new Map([[a, -1]]); const q = [a];
    while (q.length) { const c = q.shift(); if (c === b) break; for (const n of N[c].n) if (!prev.has(n)) { prev.set(n, c); q.push(n); } }
    if (!prev.has(b)) return [];
    const out = []; let c = b; while (c !== -1) { out.push(N[c].p); c = prev.get(c); }
    return out.reverse();
  }

  scannables(from, range) { return []; }

  update(dt) {
    for (const d of this.doors) if (d.anim && d.anim.ready) d.anim.update(dt);
  }

  /** door panels as dynamic collision: treat closed doors as thin boxes */
  doorBlocks(p) { return null; }

  clear() {
    for (const t of this.placed) { if (t.obj) this.root.remove(t.obj); for (const ex of (t.extraInst || [])) this.root.remove(ex.root); }
    this.placed = []; this.doors = []; this.interactables = []; this.scrapSpawns = []; this.vents = []; this.lights = []; this.hazardSpawns = [];
    this.entranceInside = null; this.fireExitInside = null;
    if (this.collider) { this.collider.dispose(); this.collider = null; }
    while (this.root.children.length) this.root.remove(this.root.children[0]);
  }
}
