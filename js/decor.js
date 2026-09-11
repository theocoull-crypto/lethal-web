// Ship decor: buy furniture at the terminal, it turns up on the ship, and you rearrange it like the game's build mode:
// look at a piece and press B to pick it up, move the mouse to carry it, R (or the wheel) to rotate, left click or B to
// put it down. Pieces live under the ship object so they ride along on landing and take-off, and they collide.
import * as THREE from 'three';
import { Collider, collisionEntries } from './collision.js';
import { Animator } from './anim.js';

// ship-local spots where new purchases appear, tried in order; a spot is used only if the deck is bare floor there
// and no other piece is within reach of it (the back wall of the main room first, then the sides)
const SLOTS = [[-3.4, 0, -8.6], [0.8, 0, -8.6], [-3.5, 0, -6.2], [1.5, 0, -6.2], [-2, 0, -4.8], [1, 0, -4.8], [-0.5, 0, -5.4], [4, 0, -7.5], [6.4, 0, -6.6], [-1.2, 0, -8.6]];
// the cabin interior in ship-local coordinates (the door is on the +x side; beyond it is the outside catwalk)
const CABIN = { xMin: -9.4, xMax: 6.8, zMin: -9.5, zMax: -4.2 };
// pieces that hang rather than stand
const CEILING = /Disco Ball/i, WALL = /painting|welcome mat/i;
// the ship's built-in fixtures (ship-local x min, x max, z min, z max, with a little margin): nothing goes on top of these
const FIXTURES = [[-8.0, -4.3, -10.5, -7.3], [-10.5, -7.6, -10.5, -4.5], [-2.5, -0.5, -9.8, -8.3], [2.0, 6.6, -6.9, -4.0], [-10.4, -6.0, -5.5, -2.7], [-7.2, -4.7, -4.8, -2.7], [4.2, 6.3, -9.5, -8.2]];
const SAVE_KEY = 'lethalweb.decor';

export class Decor {
  constructor(game) {
    this.game = game; this.lib = game.lib;
    this.catalog = []; this.placed = []; this.carry = null; this.slot = 0;
  }

  async load() {
    try { this.catalog = await fetch('assets/decor.json').then(r => r.ok ? r.json() : []); } catch (e) { this.catalog = []; }
    for (const d of this.catalog) this.lib.manifest('prefabs/' + d.prefab).catch(() => null);
  }

  /** store entries for the terminal */
  storeList() {
    return this.catalog.map(d => ({ key: d.name.toLowerCase(), name: d.name, price: d.price, decor: d, names: [d.name.toLowerCase(), d.name.toLowerCase().split(' ')[0]] }));
  }

  owned(d) { return this.placed.filter(e => e.def === d).length; }

  async buy(d, opts = {}) {
    const g = this.game, w = g.world;
    const man = await this.lib.manifest('prefabs/' + d.prefab).catch(() => null);
    if (!man) return null;
    const inst = await this.lib.instantiate(man, { lights: true });
    const root = inst.root;
    // these prefabs are authored with the model already sitting at its default spot on the ship (the game moves the
    // model, not the container): re-centre so the root is the piece's footprint centre (bottom for floor pieces, top
    // for hanging ones)
    root.position.set(0, 0, 0); root.quaternion.identity(); root.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(root);
    if (!bb.isEmpty()) {
      const c = bb.getCenter(new THREE.Vector3());
      const anchor = new THREE.Vector3(c.x, CEILING.test(d.name) ? bb.max.y : bb.min.y, c.z);
      for (const ch of root.children) ch.position.sub(anchor);
    }
    // pure-white surfaces (the toilet, the shower) bloom under the cabin lights; take them down a notch
    root.traverse(o => { if (o.isMesh) { for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && m.color && !m.userData.dimmed) { m.userData.dimmed = true; const mx = Math.max(m.color.r, m.color.g, m.color.b); if (mx > 0.8) m.color.multiplyScalar(0.8 / mx); } } });
    w.shipObj.add(root);
    const slot = opts.local || this._freeSlot();
    root.position.set(slot[0], slot[1], slot[2]); root.rotation.set(0, opts.yaw || 0, 0);
    root.updateMatrixWorld(true);
    const entry = { def: d, inst, root, col: null, anim: null, yaw: opts.yaw || 0, sfx: null };
    // placement sound + any looping animation (disco ball, television)
    for (const n of man.nodes) for (const c of n.comps) {
      if (c.t === 'MB' && /PlaceableShipObject$/.test(c.cls || '') && c.d && c.d.placeObjectSFX && c.d.placeObjectSFX.$) entry.sfx = c.d.placeObjectSFX.$;
      if (c.t === 'Animator' && c.controller && !entry.anim) { const o = inst.objs.get(n.id); if (o) { entry.anim = new Animator(o, c.controller); entry.anim.load().then(() => { const names = entry.anim.names(); if (names.length) entry.anim.play(names[0], { loop: true }); }).catch(() => null); } }
    }
    await this._buildCollider(entry);
    this._settle(entry);
    this.placed.push(entry);
    w.interactables.push({ obj: root, radius: 1.5, reach: 3.2, label: () => this.carry ? '' : `[B] Move ${d.name}`, action: () => {}, decor: entry });
    if (!opts.silent && entry.sfx) g.sound.play(entry.sfx, { pos: root.getWorldPosition(new THREE.Vector3()), vol: 0.8, min: 2, max: 30 });
    this.save();
    return entry;
  }

  /** first candidate spot that is bare deck and clear of other furniture; otherwise beside the player */
  _freeSlot() {
    const w = this.game.world;
    for (const s of SLOTS) {
      const o = w.shipObj.localToWorld(new THREE.Vector3(s[0], 3.5, s[2]));
      const h = w.shipCollider.raycast(o, new THREE.Vector3(0, -1, 0), 6);
      if (!h) continue;
      const ly = w.shipObj.worldToLocal(h.point.clone()).y;
      if (ly > 0.15 || ly < -0.5) continue;
      const taken = this.placed.some(e => Math.hypot(e.root.position.x - s[0], e.root.position.z - s[2]) < 1.8);
      if (!taken) return [s[0], ly, s[2]];
    }
    const pl = w.shipObj.worldToLocal(this.game.player.pos.clone());
    return [pl.x + 1.5, pl.y, pl.z];
  }

  async _buildCollider(entry) {
    const entries = await collisionEntries(this.lib, entry.inst, { relativeTo: entry.root, exclude: n => [9, 13, 14, 15, 22, 26, 29].includes(n.layer) });
    if (entries.length) entry.col = new Collider('decor').build(entries, entry.root);
  }

  /** deck height (ship-local y) at a ship-local x/z, or null when that spot is a fixture, a wall or off the deck */
  _floorAt(x, z) {
    const w = this.game.world;
    const o = w.shipObj.localToWorld(new THREE.Vector3(x, 3.2, z));
    const h = w.shipCollider.raycast(o, new THREE.Vector3(0, -1, 0), 6);
    if (!h) return null;
    const ly = w.shipObj.worldToLocal(h.point.clone()).y;
    if (ly > 0.3 || ly < -0.6) return null;
    for (const f of FIXTURES) if (x > f[0] && x < f[1] && z > f[2] && z < f[3]) return null;
    return ly;
  }

  /** drop the piece onto the deck under it (hanging pieces keep their height) */
  _settle(entry) {
    const root = entry.root;
    if (CEILING.test(entry.def.name)) {
      const w = this.game.world; const o = w.shipObj.localToWorld(new THREE.Vector3(root.position.x, 1.0, root.position.z));
      const h = w.shipCollider.raycast(o, new THREE.Vector3(0, 1, 0).applyQuaternion(w.shipObj.getWorldQuaternion(new THREE.Quaternion())), 8);
      if (h) root.position.y = w.shipObj.worldToLocal(h.point.clone()).y - 0.05;
    } else if (!(WALL.test(entry.def.name) && root.position.y > 0.4)) {
      const y = this._floorAt(root.position.x, root.position.z);
      if (y != null) root.position.y = y;
    }
    root.updateMatrixWorld(true);
  }

  colliders(except = null) { return this.placed.filter(e => e.col && e !== except && e !== this.carry).map(e => e.col); }

  // ---------- build mode ----------
  toggle() {
    if (this.carry) return this.place();
    const t = this.game.lookTarget();
    if (!t || !t.decor) return;
    const e = t.decor;
    this.carry = e; e.from = { pos: e.root.position.clone(), yaw: e.yaw };
    this.game.hud.showTip('[LMB] Place   [R] / wheel Rotate   [B] Put back', 6);
  }

  place() {
    const e = this.carry; if (!e) return;
    const w = this.game.world;
    if (!w.onShipDeck(e.root.getWorldPosition(new THREE.Vector3()))) { this.game.hud.showTip('Furniture has to stay on the ship.', 2); return; }
    this.carry = null; e.from = null;
    this._settle(e);
    if (e.sfx) this.game.sound.play(e.sfx, { pos: e.root.getWorldPosition(new THREE.Vector3()), vol: 0.7, min: 2, max: 30 });
    this.save();
  }

  cancel() {
    const e = this.carry; if (!e) return;
    if (e.from) { e.root.position.copy(e.from.pos); e.yaw = e.from.yaw; e.root.rotation.set(0, e.yaw, 0); }
    this.carry = null; e.from = null;
  }

  rotate(dir) { const e = this.carry; if (!e) return; e.yaw += dir * Math.PI / 12; e.root.rotation.set(0, e.yaw, 0); }

  update(dt) {
    for (const e of this.placed) if (e.anim && e.anim.ready) e.anim.update(dt);
    const e = this.carry; if (!e) return;
    const g = this.game, w = g.world;
    const eye = g.camera.position.clone(), dir = new THREE.Vector3(0, 0, -1).applyQuaternion(g.camera.quaternion);
    // aim at the ship: floor, walls or another piece
    let hit = null;
    for (const c of this.colliders(e).concat([w.shipCollider])) { const h = c && c.raycast(eye, dir, 7); if (h && (!hit || h.distance < hit.distance)) hit = h; }
    let target;
    if (hit) target = hit.point.clone();
    else { target = eye.clone().addScaledVector(dir, 3.5); const h = w.shipCollider.raycast(target.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, -1, 0), 4); if (h) target.y = h.point.y; }
    const local = w.shipObj.worldToLocal(target);
    local.x = THREE.MathUtils.clamp(local.x, CABIN.xMin, CABIN.xMax); local.z = THREE.MathUtils.clamp(local.z, CABIN.zMin, CABIN.zMax);
    if (CEILING.test(e.def.name)) {
      // hangs from the ceiling above the aim point
      const o = w.shipObj.localToWorld(new THREE.Vector3(local.x, 1.0, local.z)); const h = w.shipCollider.raycast(o, new THREE.Vector3(0, 1, 0).applyQuaternion(w.shipObj.getWorldQuaternion(new THREE.Quaternion())), 8);
      if (h) { local.y = w.shipObj.worldToLocal(h.point.clone()).y - 0.05; e.root.position.lerp(local, Math.min(1, dt * 18)); }
    } else if (WALL.test(e.def.name) && hit && Math.abs(w.shipObj.worldToLocal(hit.point.clone()).y - local.y) < 0.01 && local.y > 0.4) {
      // aimed at a wall: sit on it, facing back into the room
      e.root.position.lerp(local, Math.min(1, dt * 18));
      const pl = w.shipObj.worldToLocal(g.player.pos.clone()); e.yaw = Math.atan2(pl.x - local.x, pl.z - local.z);
    } else {
      // furniture goes on the deck itself: find the floor under the aim point and refuse spots on top of fixtures
      const floorY = this._floorAt(local.x, local.z);
      if (floorY != null) { local.y = floorY; e.root.position.lerp(local, Math.min(1, dt * 18)); }
    }
    e.root.rotation.set(0, e.yaw, 0);
  }

  // ---------- persistence ----------
  save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.placed.map(e => ({ id: e.def.id, pos: e.root.position.toArray(), yaw: e.yaw })))); } catch (err) { }
  }
  async restore() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(SAVE_KEY) || '[]'); } catch (err) { list = []; }
    for (const s of list) { const d = this.catalog.find(x => x.id === s.id); if (d) await this.buy(d, { local: s.pos, yaw: s.yaw, silent: true }); }
  }
}
