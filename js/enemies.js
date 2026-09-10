// Enemies: spawning by the level's real spawn tables, simplified behaviours, waypoint navigation on the dungeon graph.
import * as THREE from 'three';
import { pickClip } from './audio.js';
import { buildSkinned } from './loader.js';
import { Animator, collectIK } from './anim.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3();

// clip name patterns per behaviour state (first match wins)
const CLIPS = {
  idle: [/^Idle$/i, /idle/i, /Stand/i, /Sit/i, /Sleep/i],
  walk: [/^Walk$/i, /^WalkForward/i, /^WalkCalm/i, /^CrawlSlow/i, /Creep/i, /Walk(?!Back|Side|Diag)/i, /Crawl/i, /Move/i, /Roam/i],
  run: [/^Run/i, /Sprint/i, /^Chase/i, /CrawlChase/i, /Charge/i, /Creep/i, /WalkForward/i, /WalkCalm/i, /Walk(?!Back|Side|Diag)/i],
  attack: [/Kill/i, /Attack/i, /Bite/i, /Grab/i, /Hit/i, /Slam/i, /Lunge/i, /Swing/i],
  die: [/Die/i, /Death/i, /Dead/i],
  stun: [/Stun/i],
};

const BEHAVIOURS = {
  Flowerman: { kind: 'bracken', speed: 3.2, angrySpeed: 5.5, killRange: 1.6 },
  Crawler: { kind: 'thumper', speed: 3.0, chaseSpeed: 9.5, damage: 40, hitRange: 1.8 },
  HoarderBug: { kind: 'hoarder', speed: 3.5, damage: 30, hitRange: 1.6 },
  Centipede: { kind: 'snareflea', speed: 2.5, damage: 12 },
  SandSpider: { kind: 'spider', speed: 4.2, damage: 60, hitRange: 2.0 },
  Blob: { kind: 'blob', speed: 1.1, damage: 25, hitRange: 1.9 },
  PufferEnemy: { kind: 'puffer', speed: 3.0, damage: 20 },
  DressGirl: { kind: 'ghost', speed: 2.5 },
  NutcrackerEnemy: { kind: 'nutcracker', speed: 4.5, damage: 50, hitRange: 2.2 },
  StingrayEnemy: { kind: 'idle', speed: 0 },
  MouthDog: { kind: 'dog', speed: 5.5, chaseSpeed: 11, killRange: 2.2 },
  ForestGiant: { kind: 'giant', speed: 6.0, killRange: 2.8 },
  SandWorm: { kind: 'none' },
  RadMechEnemy: { kind: 'none' },
  DoublewingedBird: { kind: 'bird', speed: 8 },
  RedLocustBees: { kind: 'none' },
  DocileLocustBees: { kind: 'locust' },
};

// demo roster: most of the moon's monsters are left out on purpose
const DEMO_ENEMIES = new Set(['Flowerman', 'HoarderBug', 'Centipede', 'Crawler', 'MouthDog', 'DoublewingedBird']);

export class Enemies {
  constructor(game) {
    this.game = game; this.lib = game.lib;
    this.list = [];
    this.spawnTimer = 45; this.outsideTimer = 30;
    this.insidePower = 0; this.outsidePower = 0;
    this.noises = [];
    this.catalog = null;
  }

  async load() {
    this.catalog = this.game.dungeon.catalog;
    const all = [...this.catalog.enemies.inside, ...this.catalog.enemies.outside, ...this.catalog.enemies.daytime];
    for (const e of all) if (e.prefab) { e.man = await this.lib.manifest('prefabs/' + e.prefab).catch(() => null); e.beh = BEHAVIOURS[e.prefab.split('__')[0]] || { kind: 'idle', speed: 2 }; }
  }

  beginDay() { this.clearAll(); this.spawnTimer = 40 + Math.random() * 40; this.outsideTimer = 20; this.insidePower = 0; this.outsidePower = 0; }
  clearAll() { for (const e of this.list) this._remove(e); this.list = []; }
  _remove(e) { if (e.root.parent) e.root.parent.remove(e.root); if (e.skin) e.skin.forEach(s => s.parent && s.parent.remove(s)); for (const h of e.loops) h && h.stop && h.stop(); }

  onNoise(pos, loudness) { this.noises.push({ pos: pos.clone(), loudness, t: 0 }); if (this.noises.length > 20) this.noises.shift(); }
  onPlayerEntered(inside) { }

  pickWeighted(list, budget) {
    const cands = list.filter(e => e.man && e.beh.kind !== 'none' && DEMO_ENEMIES.has(e.prefab.split('__')[0]) && (e.power || 1) <= budget && this.list.filter(x => x.def === e).length < (e.maxCount || 1));
    const total = cands.reduce((a, e) => a + e.rarity, 0);
    if (!total) return null;
    let r = Math.random() * total;
    for (const e of cands) { r -= e.rarity; if (r <= 0) return e; }
    return cands[cands.length - 1];
  }

  async spawn(def, pos, area) {
    const inst = await this.lib.instantiate(def.man, { lights: false });
    const rootObj = inst.root.children[0];
    if (rootObj) { rootObj.position.set(0, 0, 0); rootObj.quaternion.identity(); }
    const root = inst.root; root.position.copy(pos);
    const parent = area === 'inside' ? this.game.dungeon.root : this.game.world.moonRoot;
    parent.add(root); root.updateMatrixWorld(true);
    const skin = await buildSkinned(this.lib, inst, parent);
    // hide LOD duplicates: keep first skinned mesh set only
    // scan name
    let scanName = def.enemyName || def.name;
    for (const n of def.man.nodes) for (const c of n.comps) if (c.t === 'MB' && c.cls === 'ScanNodeProperties' && c.d && c.d.headerText) scanName = c.d.headerText;
    const bb = new THREE.Box3().setFromObject(root);
    const e = { def, beh: def.beh, root, inst, skin, area, pos: root.position, state: 'idle', t: 0, target: null, path: [], pathT: 0, hp: 4, scanName, loops: [], cooldown: 0, seenT: 0, anger: 0, dead: false, yaw: Math.random() * Math.PI * 2, height: Math.max(0.5, bb.max.y - bb.min.y), home: pos.clone(), lastPlayerPos: null, wanderT: 0, anim: null, moveAmount: 0 };
    root.userData.enemy = e;
    this.list.push(e);
    // animation: Animator component -> controller -> packed clips; IK constraints from the rig
    for (const [id, o] of inst.objs) {
      const n = o.userData.node; const ac = n && n.comps.find(c => c.t === 'Animator' && c.controller);
      if (ac) { e.anim = new Animator(o, ac.controller); e.anim.load().then(() => { e.anim.ik = collectIK(inst); this.setAnim(e, 'idle'); }); break; }
    }
    const sfx = def.sfx || {};
    e.sfx = sfx;
    return e;
  }

  setAnim(e, state, opts = {}) {
    if (!e.anim || !e.anim.ready) return;
    let name = e.anim.find(CLIPS[state] || []);
    if (!name && state === 'run') name = e.anim.find(CLIPS.walk);
    if (!name && state === 'walk') name = e.anim.find(CLIPS.run);
    if (!name && state !== 'idle') name = e.anim.find(CLIPS.idle);
    if (!name) name = e.anim.names()[0];
    if (name) e.anim.play(name, opts);
  }

  vent(pos) { return this.game.dungeon.vents.length ? this.game.dungeon.vents[Math.floor(Math.random() * this.game.dungeon.vents.length)].pos.clone() : pos; }

  update(dt) {
    const g = this.game, w = g.world, p = g.player;
    if (w.shipState !== 'landed' && w.shipState !== 'leaving') return;
    for (const n of this.noises) n.t += dt;
    this.noises = this.noises.filter(n => n.t < 6);
    // spawning: inside enemies from vents, chance rises through the day
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && g.dungeon.vents.length) {
      this.spawnTimer = 55 + Math.random() * 50;
      const chance = 0.25 + w.dayFrac * 0.65;
      if (Math.random() < chance && this.insidePower < this.catalog.level.maxEnemyPowerCount) {
        const def = this.pickWeighted(this.catalog.enemies.inside, this.catalog.level.maxEnemyPowerCount - this.insidePower);
        if (def) { const vp = this.vent(p.pos); vp.y += 0.1; this.spawn(def, vp, 'inside').then(e => { this.insidePower += def.power || 1; this._onSpawned(e); }); }
      }
    }
    this.outsideTimer -= dt;
    if (this.outsideTimer <= 0 && w.outsideNodes.length) {
      this.outsideTimer = 40 + Math.random() * 40;
      const night = w.dayFrac > 0.62;
      const list = night ? this.catalog.enemies.outside : this.catalog.enemies.daytime;
      const budget = night ? this.catalog.level.maxOutsideEnemyPowerCount : this.catalog.level.maxDaytimeEnemyPowerCount;
      if (Math.random() < (night ? 0.7 : 0.35) && this.outsidePower < budget) {
        const def = this.pickWeighted(list, budget - this.outsidePower);
        if (def) {
          const far = w.outsideNodes.filter(n => n.distanceTo(p.pos) > 40);
          const at = (far.length ? far : w.outsideNodes)[Math.floor(Math.random() * (far.length ? far.length : w.outsideNodes.length))].clone();
          this.spawn(def, at, 'outside').then(e => { this.outsidePower += def.power || 1; this._onSpawned(e); });
        }
      }
    }
    for (const e of this.list) {
      if (!e.dead && !this.frozen) { const before = e.pos.clone(); this._updateEnemy(e, dt); e.moveAmount = before.distanceTo(e.pos) / Math.max(1e-4, dt); }
      if (e.anim && e.anim.ready) {
        if (!e.dead && e.state !== 'latched' && e.state !== 'ceiling') this.setAnim(e, e.moveAmount > 4.5 ? 'run' : e.moveAmount > 0.15 ? 'walk' : 'idle');
        e.anim.update(dt);
      }
    }
  }

  _onSpawned(e) {
    const kind = e.beh.kind;
    if (kind === 'snareflea') { // climb to ceiling
      const hit = this.game.dungeon.collider && this.game.dungeon.collider.raycast(e.pos.clone().add(new THREE.Vector3(0, 0.5, 0)), new THREE.Vector3(0, 1, 0), 12);
      if (hit) { e.pos.y = hit.point.y - 0.4; e.root.rotation.x = Math.PI; e.state = 'ceiling'; }
    }
    if (kind === 'spider') e.state = 'lurk';
    if (kind === 'idle') e.state = 'idle';
  }

  // ---------- perception helpers ----------
  canSee(e, target, maxDist = 30, fovCos = -1) {
    const from = e.pos.clone().add(new THREE.Vector3(0, e.height * 0.7, 0));
    const to = target.clone(); const d = from.distanceTo(to);
    if (d > maxDist) return false;
    const dir = to.clone().sub(from).normalize();
    const col = e.area === 'inside' ? this.game.dungeon.collider : this.game.world.moonCollider;
    const hit = col && col.raycast(from, dir, d - 0.3);
    return !hit;
  }

  playerLookingAt(e, cosTol = 0.82) {
    const cam = this.game.camera;
    const dir = e.pos.clone().add(new THREE.Vector3(0, e.height * 0.6, 0)).sub(cam.position);
    const d = dir.length(); dir.normalize();
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    return f.dot(dir) > cosTol && d < 45 && this.canSee(e, cam.position, 45);
  }

  moveToward(e, target, speed, dt, turn = 6) {
    const to = target.clone().sub(e.pos); to.y = 0;
    const d = to.length(); if (d < 0.05) return d;
    to.normalize();
    const wantYaw = Math.atan2(to.x, to.z);
    let dy = wantYaw - e.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    e.yaw += THREE.MathUtils.clamp(dy, -turn * dt, turn * dt);
    const step = Math.min(d, speed * dt);
    e.pos.x += Math.sin(e.yaw) * step; e.pos.z += Math.cos(e.yaw) * step;
    // ground follow
    const col = e.area === 'inside' ? this.game.dungeon.collider : this.game.world.moonCollider;
    if (col) {
      const hit = col.raycast(e.pos.clone().add(new THREE.Vector3(0, 1.2, 0)), new THREE.Vector3(0, -1, 0), 4);
      if (hit) e.pos.y += (hit.point.y - e.pos.y) * Math.min(1, dt * 10);
    }
    e.root.rotation.y = e.yaw;
    return d;
  }

  followPath(e, target, speed, dt) {
    if (e.area === 'inside') {
      if (!e.path.length || e.pathT > 1.5) { e.path = this.game.dungeon.path(e.pos, target); e.pathT = 0; if (e.path.length) e.path.push(target.clone()); }
      e.pathT += dt;
      if (!e.path.length) return this.moveToward(e, target, speed, dt);
      const next = e.path[0];
      const d = this.moveToward(e, next, speed, dt);
      if (d < 0.6) e.path.shift();
      return e.pos.distanceTo(target);
    }
    return this.moveToward(e, target, speed, dt);
  }

  wander(e, speed, dt, radius = 12) {
    e.wanderT -= dt;
    if (e.wanderT <= 0 || !e.target) {
      e.wanderT = 3 + Math.random() * 5;
      if (e.area === 'inside') { const g = this.game.dungeon.graph; e.target = g.nodes[Math.floor(Math.random() * g.nodes.length)].p.clone(); e.path = []; }
      else { const ns = this.game.world.outsideNodes; e.target = ns.length ? ns[Math.floor(Math.random() * ns.length)].clone() : e.home.clone(); }
    }
    const d = this.followPath(e, e.target, speed, dt);
    if (d < 1) e.wanderT = 0;
  }

  playSfx(e, key, vol = 0.9) {
    const c = pickClip(e.sfx && e.sfx[key]); if (c) this.game.sound.play(c, { pos: e.pos.clone(), vol, min: 2, max: 40 });
  }

  // ---------- behaviours ----------
  _updateEnemy(e, dt) {
    const g = this.game, p = g.player, b = e.beh;
    const sameArea = (e.area === 'inside') === !!g.inside;
    const pp = p.pos.clone();
    const dist = e.pos.distanceTo(pp);
    e.cooldown -= dt; e.t += dt;
    const hurt = (dmg) => { if (e.cooldown <= 0 && sameArea && !p.dead) { p.damage(dmg, e.scanName); e.cooldown = 1.1; this.playSfx(e, 'hitBodySFX'); } };
    if (!sameArea) { if (b.kind !== 'snareflea' && b.kind !== 'spider') this.wander(e, b.speed, dt); return; }
    switch (b.kind) {
      case 'bracken': {
        const looking = this.playerLookingAt(e);
        if (looking) e.seenT += dt; else e.seenT = Math.max(0, e.seenT - dt * 0.5);
        if (e.seenT > 1.4 && e.state !== 'angry') { e.state = 'retreat'; e.anger += dt; }
        if (e.anger > 4) e.state = 'angry';
        if (e.state === 'idle' || e.state === 'stalk') {
          e.state = 'stalk';
          if (dist < b.killRange && !p.dead) { p.damage(1000, 'Bracken'); this.playSfx(e, 'hitEnemyVoiceSFX'); this.setAnim(e, 'attack', { once: true, loop: false }); e.state = 'retreat'; e.seenT = 0; }
          else if (looking && dist < 14) { /* freeze while watched */ }
          else this.followPath(e, pp, dist < 6 ? b.speed * 0.9 : b.speed, dt);
        } else if (e.state === 'retreat') {
          // run to a far node, then resume stalking
          if (!e.target || e.pos.distanceTo(e.target) < 1.5) { const ns = g.dungeon.graph.nodes; let best = null, bd = -1; for (let i = 0; i < 12; i++) { const n = ns[Math.floor(Math.random() * ns.length)]; const d = n.p.distanceTo(pp); if (d > bd) { bd = d; best = n.p; } } e.target = best.clone(); e.path = []; }
          this.followPath(e, e.target, b.angrySpeed, dt);
          if (e.pos.distanceTo(e.target) < 1.5 || e.t % 12 < dt) { e.state = 'stalk'; e.seenT = 0; }
        } else if (e.state === 'angry') {
          this.followPath(e, pp, b.angrySpeed, dt);
          if (dist < b.killRange && !p.dead) { p.damage(1000, 'Bracken'); this.playSfx(e, 'hitEnemyVoiceSFX'); e.state = 'retreat'; e.anger = 0; }
        }
        break;
      }
      case 'thumper': {
        const sees = dist < 25 && this.canSee(e, pp.clone().add(new THREE.Vector3(0, 1.5, 0)), 25);
        if (sees) { e.lastPlayerPos = pp.clone(); e.state = 'chase'; }
        if (e.state === 'chase') {
          const tgt = e.lastPlayerPos || pp;
          const sp = Math.min(b.chaseSpeed, b.speed + e.t * 2.5);
          const d = this.followPath(e, tgt, sp, dt, 2.2);
          if (dist < b.hitRange) hurt(b.damage);
          if (!sees && d < 1) { e.state = 'search'; e.t = 0; }
        } else { e.t = 0; this.wander(e, b.speed, dt); }
        break;
      }
      case 'hoarder': {
        const carrying = p.carryWeight > 0 || g.items.inventory.some(x => x && x.value);
        if (dist < 7 && carrying && this.canSee(e, pp, 12)) e.state = 'chase';
        if (e.state === 'chase') { this.followPath(e, pp, b.speed + 1, dt); if (dist < b.hitRange) hurt(b.damage); if (dist > 18) e.state = 'idle'; }
        else this.wander(e, b.speed, dt, 8);
        break;
      }
      case 'snareflea': {
        if (e.state === 'ceiling') {
          const flat = new THREE.Vector2(e.pos.x - pp.x, e.pos.z - pp.z).length();
          if (flat < 1.6 && e.pos.y > pp.y && e.pos.y - pp.y < 6 && !p.dead) { e.state = 'latched'; e.latchT = 0; e.root.rotation.x = 0; g.hud.showNotice('SNARE FLEA! MASH E', 3); e.mash = 0; this.playSfx(e, 'hitEnemyVoiceSFX'); }
        } else if (e.state === 'latched') {
          e.latchT += dt; e.pos.copy(pp); e.pos.y += 1.6;
          if (e.latchT % 1 < dt) p.damage(b.damage, 'Snare flea');
          if ((e.mash || 0) >= 6) { e.state = 'flee'; e.t = 0; g.hud.showNotice('', 0.1); }
          if (p.dead) e.state = 'idle';
        } else if (e.state === 'flee') { this.wander(e, b.speed * 2, dt); if (e.t > 6) { e.state = 'ceiling'; this._onSpawned(e); } }
        else this.wander(e, b.speed, dt);
        break;
      }
      case 'spider': {
        if (e.state === 'lurk') { if (dist < 9 && this.canSee(e, pp, 12)) e.state = 'chase'; }
        else { this.followPath(e, pp, b.speed, dt); if (dist < b.hitRange) hurt(b.damage); if (dist > 22) e.state = 'lurk'; }
        break;
      }
      case 'blob': {
        if (dist < 14) this.followPath(e, pp, b.speed, dt); else this.wander(e, b.speed * 0.6, dt);
        if (dist < b.hitRange) hurt(b.damage);
        break;
      }
      case 'puffer': {
        if (dist < 5) { const away = e.pos.clone().sub(pp).normalize().multiplyScalar(6).add(e.pos); this.moveToward(e, away, b.speed, dt); if (dist < 2.2) hurt(b.damage); }
        else this.wander(e, b.speed * 0.5, dt);
        break;
      }
      case 'ghost': {
        // only exists when player is low: appears, walks toward, kills if reached while player not looking
        if (this.playerLookingAt(e, 0.9)) { e.seenT += dt; if (e.seenT > 3) { e.pos.copy(g.dungeon.graph.nodes[Math.floor(Math.random() * g.dungeon.graph.nodes.length)].p); e.seenT = 0; } }
        else this.followPath(e, pp, b.speed, dt);
        if (dist < 1.4 && !p.dead) p.damage(1000, 'Ghost girl');
        break;
      }
      case 'nutcracker': {
        if (dist < 20 && this.canSee(e, pp, 20)) { this.followPath(e, pp, b.speed, dt); if (dist < b.hitRange) hurt(b.damage); } else this.wander(e, b.speed * 0.5, dt);
        break;
      }
      case 'dog': {
        // blind: chases noise
        let loud = null;
        for (const n of this.noises) { if (n.pos.distanceTo(e.pos) < 18 + n.loudness * 25) { if (!loud || n.t < loud.t) loud = n; } }
        if (loud) { e.target = loud.pos.clone(); e.state = 'chase'; e.t = 0; }
        if (e.state === 'chase' && e.target) {
          const d = this.moveToward(e, e.target, b.chaseSpeed, dt, 3);
          if (dist < b.killRange && !p.dead && !p.attached) { p.damage(1000, 'Eyeless dog'); this.playSfx(e, 'hitEnemyVoiceSFX'); }
          if (d < 1.5 || e.t > 8) { e.state = 'idle'; e.target = null; }
        } else this.wander(e, b.speed * 0.6, dt);
        break;
      }
      case 'giant': {
        if (dist < 35 && this.canSee(e, pp, 60)) { this.moveToward(e, pp, b.speed, dt, 1.5); if (dist < b.killRange && !p.dead && !p.attached) p.damage(1000, 'Forest keeper'); }
        else this.wander(e, b.speed * 0.4, dt);
        break;
      }
      case 'bird': {
        // flies in circles above its home
        e.pos.x = e.home.x + Math.cos(e.t * 0.5) * 12; e.pos.z = e.home.z + Math.sin(e.t * 0.5) * 12; e.pos.y = e.home.y + 8 + Math.sin(e.t) * 1.5;
        e.root.rotation.y = -e.t * 0.5;
        break;
      }
      default: break;
    }
    // simple bob for legs-less motion feel
    e.root.updateMatrixWorld(true);
  }

  onMash() { for (const e of this.list) if (e.state === 'latched') e.mash = (e.mash || 0) + 1; }

  hitInFront(player, range, dmg) {
    const f = player.forward(new THREE.Vector3());
    for (const e of this.list) {
      if (e.dead) continue;
      const to = e.pos.clone().sub(player.pos); const d = to.length();
      if (d < range && to.normalize().dot(f) > 0.5) {
        e.hp -= dmg; this.playSfx(e, 'hitBodySFX');
        if (e.beh.kind === 'bracken') { e.state = 'retreat'; e.anger = 0; }
        if (e.beh.kind === 'hoarder' || e.beh.kind === 'spider' || e.beh.kind === 'thumper') e.state = 'chase';
        if (e.hp <= 0 && e.def.canDie !== false) { e.dead = true; this.playSfx(e, 'deathSFX'); if (e.anim && e.anim.ready && e.anim.find(CLIPS.die)) this.setAnim(e, 'die', { once: true, loop: false }); else e.root.rotation.z = Math.PI / 2; if (e.area === 'inside') this.insidePower -= e.def.power || 1; else this.outsidePower -= e.def.power || 1; }
      }
    }
  }

  scannables(from, range) {
    return this.list.filter(e => (e.area === 'inside') === !!this.game.inside && e.pos.distanceTo(from) < range).map(e => ({ pos: () => e.pos.clone().add(new THREE.Vector3(0, e.height * 0.8, 0)), text: e.scanName, value: null }));
  }
}
