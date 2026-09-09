// Scrap and tools: spawning, pickup, drop, inventory, ship counting, sound tables.
import * as THREE from 'three';
import { pickClip } from './audio.js';

const F = new THREE.Matrix4().makeScale(-1, 1, 1);
export function unityEulerToQuat(x, y, z) {
  const d = Math.PI / 180;
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), x * d);
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), y * d);
  const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), z * d);
  const q = qy.multiply(qx).multiply(qz); // Unity: Z, then X, then Y
  return new THREE.Quaternion(q.x, -q.y, -q.z, q.w); // mirror X
}

export class Items {
  constructor(game) {
    this.game = game; this.lib = game.lib;
    this.catalog = null;
    this.world = [];        // item instances in the world
    this.inventory = [null, null, null, null];
    this.active = 0;
    this.heldObj = null;
    this.sfxTable = {}; this.footsteps = {};
    this.ambience = { inside: 'b8_1757', outside: 'b7_174', cues: { inside: [], outside: [], ship: [] } };
    this.cueTimer = 20;
    this.swingT = 0;
    this.honks = 0;
  }

  async load() {
    this.catalog = this.game.dungeon.catalog;
    const sys = await this.lib.manifest('scenes/systems.json').catch(() => null);
    if (sys) {
      for (const n of sys.nodes) for (const c of n.comps) {
        if (c.t !== 'MB' || !c.d) continue;
        const d = c.d, id = x => x && x.$;
        if (c.cls === 'StartOfRound') {
          for (const s of (d.footstepSurfaces || [])) this.footsteps[(s.surfaceTag || '').toLowerCase()] = (s.clips || []).map(id).filter(Boolean);
          Object.assign(this.sfxTable, { damage: id(d.damageSFX), fallDamage: id(d.fallDamageSFX), landSoft: id(d.playerHitGroundSoft), landHard: id(d.playerHitGroundHard), jump: id(d.playerJumpSFX), death: id(d.playerFallDeath), grab: id(d.playerGrabSFX), space: id(d.suckedIntoSpaceSFX), fired: id(d.firedVoiceSFX), depart: id(d.shipDepartSFX), arrive: id(d.shipArriveSFX), alarm: id(d.alarmSFX), zeroDays: id(d.zeroDaysLeftAlertSFX), doorMetal: id(d.shutDoorMetal), intro: id(d.shipIntroSpeechSFX) });
        }
        if (c.cls === 'HUDManager') Object.assign(this.sfxTable, { scan: id(d.scanSFX), alert: pickClip(d.warningSFX), notify: id(d.globalNotificationSFX), results: pickClip(d.endStatsMusic), addScrap: id(d.addToScrapTotalSFX), finishScrap: id(d.finishAddingToTotalSFX), tips: pickClip(d.tipsSFX), newQuota: id(d.newProfitQuotaSFX), reachedQuota: id(d.reachedQuotaSFX), oneDay: id(d.OneDayToMeetQuotaSFX), critical: id(d.criticalInjury) });
        if (c.cls === 'SoundManager') Object.assign(this.sfxTable, { heartbeat: pickClip(d.heartbeatClips), steelOpen: pickClip(d.steelDoorOpenSFX), steelClose: pickClip(d.steelDoorCloseSFX) });
        if (c.cls === 'TimeOfDay') this.sfxTable.timeCues = (d.timeOfDayCues || []).map(id);
      }
    }
    const amb = this.catalog.level.ambienceData;
    if (amb) { this.ambience.cues.inside = (amb.insideAmbience || []).map(x => x && x.$).filter(Boolean); this.ambience.cues.outside = (amb.outsideAmbience || []).map(x => x && x.$).filter(Boolean); this.ambience.cues.ship = (amb.shipAmbience || []).map(x => x && x.$).filter(Boolean); }
    // preload manifests
    this.defs = this.catalog.scrap.filter(s => s.prefab);
    await Promise.all(this.defs.map(s => this.lib.manifest('prefabs/' + s.prefab).catch(() => null)));
    this.toolDefs = {};
    for (const [k, v] of Object.entries(this.catalog.tools)) if (!k.endsWith('_item') && v) { this.toolDefs[k] = { name: k, prefab: v, item: this.catalog.tools[k + '_item'] || {} }; await this.lib.manifest('prefabs/' + v).catch(() => null); }
    // flashlight click clips from the prefab
    const fl = await this.lib.manifest('prefabs/' + this.catalog.tools.FlashlightItem).catch(() => null);
    if (fl) for (const n of fl.nodes) for (const c of n.comps) if (c.t === 'MB' && c.cls === 'FlashlightItem' && c.d) { const cl = (c.d.flashlightClips || []).map(x => x && x.$).filter(Boolean); this.sfxTable.flashOn = cl[0]; this.sfxTable.flashOff = cl[1] || cl[0]; }
  }

  sfx(name) { return this.sfxTable[name] || null; }
  footstep(surface) {
    const map = { metal: 'catwalk', concrete: 'concrete', dirt: 'gravel', rock: 'rock' };
    const list = this.footsteps[map[surface] || surface] || this.footsteps.concrete || [];
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  }
  ambienceClip(area) { return this.ambience[area]; }

  // ---------- instances ----------
  async makeInstance(def, value) {
    const man = await this.lib.manifest('prefabs/' + def.prefab);
    const inst = await this.lib.instantiate(man, { lights: false });
    const rootObj = inst.root.children[0];
    const scale = rootObj ? rootObj.scale.clone() : new THREE.Vector3(1, 1, 1);
    if (rootObj) { rootObj.position.set(0, 0, 0); rootObj.quaternion.identity(); }
    // scan header text
    let scanName = def.itemName || def.name;
    for (const n of man.nodes) for (const c of n.comps) if (c.t === 'MB' && c.cls === 'ScanNodeProperties' && c.d && c.d.headerText) scanName = c.d.headerText;
    const bbox = new THREE.Box3().setFromObject(inst.root);
    const it = { def, value, obj: inst.root, inst, held: false, onShip: false, scanName, name: def.itemName || def.name, weightLb: Math.max(0, Math.round(((def.weight || 1) - 1) * 105)), twoHanded: !!def.twoHanded, size: bbox.getSize(new THREE.Vector3()), bboxMinY: bbox.min.y, grabSFX: pickClip(def.grabSFX), dropSFX: pickClip(def.dropSFX) };
    inst.root.userData.item = it;
    inst.root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = true; } });
    return it;
  }

  restQuat(def) {
    const r = def.restingRotation || { x: 0, y: 0, z: 0 };
    return unityEulerToQuat(r.x || 0, r.y || 0, r.z || 0);
  }

  placeOnFloor(it, pos, colliders, yaw) {
    // raycast down to find the floor
    const origin = pos.clone(); origin.y += 1.5;
    let y = pos.y;
    for (const c of colliders) { const h = c.raycast(origin, new THREE.Vector3(0, -1, 0), 8); if (h) { y = h.point.y; break; } }
    it.obj.quaternion.copy(this.restQuat(it.def));
    if (yaw != null) it.obj.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    it.obj.position.set(pos.x, y, pos.z);
    it.obj.updateMatrixWorld(true);
    // lift so the lowest point sits on the floor
    const bb = new THREE.Box3().setFromObject(it.obj);
    if (isFinite(bb.min.y)) it.obj.position.y += (y - bb.min.y) + 0.01;
    it.obj.position.y += (it.def.floorYOffset || 0) * 0.0 ;
  }

  async spawnScrap() {
    this.clearWorldScrap();
    const lvl = this.catalog.level, d = this.game.dungeon;
    if (!d.scrapSpawns.length) return;
    const count = lvl.minScrap + Math.floor(Math.random() * (lvl.maxScrap - lvl.minScrap + 1));
    const total = this.defs.reduce((a, s) => a + s.rarity, 0);
    const pick = () => { let r = Math.random() * total; for (const s of this.defs) { r -= s.rarity; if (r <= 0) return s; } return this.defs[0]; };
    const colliders = [d.collider];
    const spawns = d.scrapSpawns.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < count; i++) {
      const def = pick();
      const value = Math.round((def.minValue + Math.random() * (def.maxValue - def.minValue)) * 0.4);
      const sp = spawns[i % spawns.length];
      const a = Math.random() * Math.PI * 2, r = Math.random() * Math.min(sp.range, 3);
      const pos = sp.pos.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.5, Math.sin(a) * r));
      const it = await this.makeInstance(def, value);
      d.root.add(it.obj);
      this.placeOnFloor(it, pos, colliders, Math.random() * Math.PI * 2);
      it.area = 'inside';
      this.world.push(it);
    }
  }

  async giveStarterItems() {
    if (this.inventory.some(x => x)) return;
    const fl = this.toolDefs.FlashlightItem;
    if (fl) {
      const def = Object.assign({ name: 'Pro-flashlight', prefab: fl.prefab, weight: 1.05, twoHanded: false }, fl.item, { itemName: fl.item.itemName || 'Pro-flashlight' });
      const it = await this.makeInstance(def, 0);
      it.isFlashlight = true; it.name = def.itemName;
      this.addToInventory(it, 0);
    }
    const w = this.toolDefs.WalkieTalkie;
    if (w) {
      const def = Object.assign({ name: 'Walkie-talkie', prefab: w.prefab, weight: 1.0 }, w.item, { itemName: w.item.itemName || 'Walkie-talkie' });
      const it = await this.makeInstance(def, 0); it.name = def.itemName;
      this.addToInventory(it, 1);
    }
    this.select(0);
  }

  // ---------- inventory ----------
  addToInventory(it, slot) {
    if (slot == null) { slot = this.inventory[this.active] ? this.inventory.findIndex(x => !x) : this.active; }
    if (slot < 0) return false;
    this.inventory[slot] = it; it.held = true; it.onShip = false;
    if (it.obj.parent) it.obj.parent.remove(it.obj);
    const i = this.world.indexOf(it); if (i >= 0) this.world.splice(i, 1);
    this.select(slot);
    this.updateWeight();
    return true;
  }

  select(i) {
    this.active = i;
    const it = this.inventory[i];
    if (this.heldObj) { this.game.camera.remove(this.heldObj); this.heldObj = null; }
    if (it) {
      const o = it.obj; this.heldObj = o;
      const ro = it.def.rotationOffset || { x: 0, y: 0, z: 0 }, po = it.def.positionOffset || { x: 0, y: 0, z: 0 };
      o.quaternion.copy(unityEulerToQuat(ro.x || 0, ro.y || 0, ro.z || 0));
      const base = it.twoHanded ? new THREE.Vector3(0.05, -0.5, -0.75) : new THREE.Vector3(0.42, -0.36, -0.62);
      o.position.copy(base).add(new THREE.Vector3(-(po.x || 0), po.y || 0, po.z || 0));
      o.traverse(m => { if (m.isMesh) { m.frustumCulled = false; m.castShadow = false; m.layers.set(1); } });
      this.game.camera.add(o);
    }
    this.game.hud.setInventory(this.inventory.map(x => x ? { name: x.name, value: x.value } : null), this.active);
    this.game.flashlightOn = this.game.flashlightOn && this.hasFlashlight();
  }

  hasFlashlight() { return this.inventory.some(x => x && x.isFlashlight); }
  carryWeightLb() { return this.inventory.reduce((a, x) => a + (x ? x.weightLb : 0), 0); }
  updateWeight() { this.game.player.carryWeight = this.carryWeightLb(); }

  interactables() {
    const out = [];
    const eye = this.game.camera.position;
    for (const it of this.world) {
      if (it.area === 'inside' && !this.game.inside) continue;
      if (it.area !== 'inside' && this.game.inside) continue;
      const p = it.obj.getWorldPosition(new THREE.Vector3());
      if (p.distanceToSquared(eye) > 36) continue;
      out.push({ pos: p, radius: Math.max(0.5, Math.max(it.size.x, it.size.z) * 0.6 + 0.2), label: () => this.inventory.every(x => x) ? `${it.scanName}\n(inventory full)` : `[E] Grab ${it.scanName}${it.value ? '  $' + it.value : ''}`, action: () => this.pickUp(it) });
    }
    return out;
  }

  pickUp(it) {
    if (this.inventory.every(x => x)) return;
    if (!this.addToInventory(it)) return;
    const c = it.grabSFX || this.sfx('grab'); if (c) this.game.sound.play(c, { vol: 0.7 });
    this.game.enemies.onNoise(this.game.player.pos, 0.3);
  }

  dropHeld() {
    const it = this.inventory[this.active];
    if (!it) return;
    this.inventory[this.active] = null; it.held = false;
    this.game.camera.remove(it.obj);
    it.obj.traverse(m => { if (m.isMesh) { m.frustumCulled = true; m.castShadow = true; m.layers.set(0); } });
    const p = this.game.player;
    const fwd = p.forward(new THREE.Vector3());
    const pos = p.pos.clone().addScaledVector(fwd, 0.9); pos.y += 0.4;
    this._placeInWorld(it, pos);
    this.select(this.active);
    this.updateWeight();
    const c = it.dropSFX || this.sfx('grab'); if (c) this.game.sound.play(c, { vol: 0.6 });
  }

  dropAll() { for (let i = 0; i < 4; i++) { if (this.inventory[i]) { this.active = i; this.dropHeld(); } } this.select(0); }

  _placeInWorld(it, pos) {
    const g = this.game;
    if (g.inside) { g.dungeon.root.add(it.obj); this.placeOnFloor(it, pos, [g.dungeon.collider], g.player.yaw); it.area = 'inside'; it.onShip = false; }
    else {
      const local = g.world.shipRoot.worldToLocal(pos.clone());
      const onShip = local.x > -9 && local.x < 11.5 && local.z > -12.5 && local.z < -1 && local.y > -2.5 && local.y < 5;
      if (onShip) { g.world.shipRoot.add(it.obj); this.placeOnFloor(it, pos, [g.world.shipCollider], g.player.yaw); it.obj.position.copy(g.world.shipRoot.worldToLocal(it.obj.position.clone())); it.onShip = local.x > -2.9; it.area = 'ship'; }
      else { g.scene.add(it.obj); this.placeOnFloor(it, pos, [g.world.moonCollider, g.world.shipCollider], g.player.yaw); it.onShip = false; it.area = 'outside'; }
    }
    this.world.push(it);
    if (it.onShip && it.value) { const c = this.sfx('addScrap'); }
  }

  useHeld() {
    const it = this.inventory[this.active];
    if (!it) return;
    const g = this.game;
    if (it.isFlashlight) { g.toggleFlashlight(); return; }
    const n = (it.def.name || '').toLowerCase();
    if (/airhorn|clownhorn|whoopie|bell|remote|boombox/.test(n)) {
      const clips = []; it.inst.manifest.nodes.forEach(nd => nd.comps.forEach(c => { if (c.t === 'MB' && c.d) { for (const k of Object.keys(c.d)) { const v = c.d[k]; if (Array.isArray(v)) v.forEach(x => { if (x && x.c === 'AudioClip') clips.push(x.$); }); else if (v && v.c === 'AudioClip') clips.push(v.$); } } }));
      const c = clips[Math.floor(Math.random() * clips.length)]; if (c) g.sound.play(c, { vol: 0.9 });
      g.enemies.onNoise(g.player.pos, 1.5);
      return;
    }
    if (/shovel|sign|stopsign|yieldsign/.test(n) || it.def.name === 'ShovelItem') { this.swing(it); return; }
    if (/walkie/.test(n)) { g.hud.showTip('Nobody is on the other end.', 2); return; }
  }

  swing(it) {
    if (this.swingT > 0) return;
    this.swingT = 0.6;
    const g = this.game;
    const c = this.sfx('grab');
    setTimeout(() => { g.enemies.hitInFront(g.player, 3.2, 1); }, 250);
  }

  // ---------- queries ----------
  scannables(from, range) {
    const out = [];
    for (const it of this.world) {
      if ((it.area === 'inside') !== !!this.game.inside) continue;
      const p = it.obj.getWorldPosition(new THREE.Vector3());
      if (p.distanceTo(from) > range) continue;
      out.push({ pos: () => it.obj.getWorldPosition(new THREE.Vector3()), text: it.scanName, value: it.value || null });
    }
    return out;
  }

  scrapValueOnShip() { return this.world.reduce((a, it) => a + (it.onShip ? it.value : 0), 0); }

  sellScrap() { for (const it of this.world.slice()) if (it.onShip) { it.obj.parent && it.obj.parent.remove(it.obj); this.world.splice(this.world.indexOf(it), 1); } }

  clearWorldScrap() {
    for (const it of this.world.slice()) if (it.area === 'inside' || it.area === 'outside') { it.obj.parent && it.obj.parent.remove(it.obj); this.world.splice(this.world.indexOf(it), 1); }
  }
  clearInventory() { for (let i = 0; i < 4; i++) { const it = this.inventory[i]; if (it) { this.game.camera.remove(it.obj); this.inventory[i] = null; } } this.select(0); this.updateWeight(); }

  update(dt) {
    if (this.swingT > 0) { this.swingT -= dt; if (this.heldObj) this.heldObj.rotation.x = Math.sin(this.swingT * 10) * 0.8; }
    // held item sway
    if (this.heldObj) { const p = this.game.player; this.heldObj.position.y += (Math.sin(p.bob * 2) * p.bobAmp * 0.5 - (this.heldObj.userData.sw || 0)); this.heldObj.userData.sw = Math.sin(p.bob * 2) * p.bobAmp * 0.5; }
    // ambience cues
    this.cueTimer -= dt;
    if (this.cueTimer <= 0) {
      this.cueTimer = 15 + Math.random() * 35;
      const g = this.game;
      const area = g.inside ? 'inside' : g.player.attached ? 'ship' : 'outside';
      const list = this.ambience.cues[area];
      if (list && list.length && g.state === 'play' && !g.world.inOrbit) {
        const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 12;
        const pos = g.player.pos.clone().add(new THREE.Vector3(Math.cos(a) * r, 1, Math.sin(a) * r));
        g.sound.play(list[Math.floor(Math.random() * list.length)], { pos, vol: 0.6, min: 3, max: 40 });
      }
    }
  }
}
