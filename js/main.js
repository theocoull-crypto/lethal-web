// LETHAL WEB - game orchestration.
import * as THREE from 'three';
import { AssetLib } from './loader.js';
import { World } from './world.js';
import { Player } from './player.js';
import { HUD } from './hud.js';
import { SoundManager, pickClip } from './audio.js';
import { Dungeon } from './dungeon.js';
import { Items } from './items.js';
import { Enemies } from './enemies.js';
import { LightPool } from './lights.js';
import { Terminal } from './terminal.js';
import { Settings } from './settings.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = id => document.getElementById(id);
const PIXEL_HEIGHT = 520;
const LIGHT_GAIN = 0.08, RANGE_GAIN = 1.6;   // brightness / range multipliers for the game's point lights   // the game renders its world at a low internal resolution and upscales it

class Game {
  constructor() {
    this.canvas = $('c');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    // a neutral environment so metals and glossy surfaces have something to reflect
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.08, 1500);
    this.scene.add(this.camera);
    this.lib = new AssetLib(this.renderer);
    this.sound = new SoundManager();
    this.hud = new HUD();
    this.clock = new THREE.Clock();
    this.state = 'loading';
    this.wantsLock = false;
    this.quota = 130; this.credits = 60; this.daysLeft = 3; this.scrapOnShip = 0; this.quotaRound = 1;
    this.dayCount = 0;
    this.inside = false;
    this.flashlightOn = false;
    this.scanT = 0; this.scanTargets = [];
    this.pixelFilter = true;
    this.lightGain = 1; this.shadowLamps = 0; this.shadowsOn = true; this.paused = false;
    this._resize();
    addEventListener('resize', () => this._resize());
    // surface errors on screen instead of a silent dead button
    const showErr = msg => { const el = $('menu-status'); if (el) el.textContent = 'Error: ' + msg + ' (press F5 to reload; if it persists, send this text)'; };
    addEventListener('error', e => showErr(e.message || String(e)));
    addEventListener('unhandledrejection', e => showErr((e.reason && (e.reason.message || e.reason)) || 'promise rejection'));
    // the start button is wired immediately; it waits for boot to finish
    this.ready = false;
    $('btn-play').onclick = () => { if (this.ready) this.startGame(); else $('menu-status').textContent = 'Still loading, one moment...'; };
    addEventListener('keydown', e => { if ((e.code === 'Enter' || e.code === 'Space') && this.state === 'menu' && this.ready) this.startGame(); });
    window.G = this;
  }

  _resize() {
    const aspect = innerWidth / innerHeight;
    this.camera.aspect = aspect; this.camera.updateProjectionMatrix();
    if (this.pixelFilter) {
      const h = Math.min(this.pixelLines || PIXEL_HEIGHT, innerHeight), w = Math.round(h * aspect);
      this.renderer.setPixelRatio(1); this.renderer.setSize(w, h, false);
      this.canvas.style.imageRendering = 'pixelated';
    } else {
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25)); this.renderer.setSize(innerWidth, innerHeight, false);
      this.canvas.style.imageRendering = 'auto';
    }
    this.canvas.style.width = '100%'; this.canvas.style.height = '100%';
  }

  togglePixelFilter() { this.pixelFilter = !this.pixelFilter; this._resize(); document.body.classList.toggle('nofilter', !this.pixelFilter); }

  async boot() {
    const fill = $('load-fill'), text = $('load-text');
    const t0 = performance.now(); let phase = 'Loading...';
    const setText = t => { phase = t; text.textContent = t; };
    // keep the loading screen visibly alive: elapsed time, and a hint if it takes unusually long (normal is 20-40 s)
    const tick = setInterval(() => {
      if (this.ready || this.state !== 'loading') { clearInterval(tick); return; }
      const s = Math.round((performance.now() - t0) / 1000);
      text.textContent = phase + '  (' + s + 's' + (s > 60 ? ' - this is taking too long, press F5 to reload' : '') + ')';
    }, 1000);
    try { await this.lib.init(); }
    catch (e) {
      $('loading').classList.add('hidden'); $('menu').classList.remove('hidden');
      $('menu-status').textContent = 'No extracted assets found in assets/. Run tools\\extract.bat with your own Lethal Company install first.';
      $('btn-play').disabled = true; return;
    }
    this.lib.onProgress = (l, t) => { fill.style.width = Math.min(100, 100 * l / Math.max(1, t)) + '%'; };
    try {
    this.world = new World(this);
    await this.world.load(setText);
    setText('Loading facility blueprints...');
    this.dungeon = new Dungeon(this);
    await this.dungeon.load();
    setText('Loading company property...');
    this.items = new Items(this);
    await this.items.load();
    this.enemies = new Enemies(this);
    await this.enemies.load();
    this.player = new Player(this);
    this.player.radius = 0.4; this.player.standHeight = 2.5; this.player.crouchHeight = 1.5;
    this.lightPool = new LightPool(this.scene, 14);
    this._refreshLightSources();
    this._setupFlashlight();
    this.terminal = new Terminal(this);
    this.settings = new Settings(this);
    fill.style.width = '100%';
    $('loading').classList.add('hidden'); $('menu').classList.remove('hidden');
    $('btn-continue').onclick = () => this.continueAfterResults();
    $('btn-menu-settings').onclick = () => { this.settings.show(); };
    $('btn-menu-controls').onclick = () => { $('menu-controls').classList.toggle('hidden'); };
    this.state = 'menu'; this.ready = true;
    this.startMenuMusic();
    this.spawnPlayerInShip();
    this.loop();
    } catch (e) {
      console.error(e);
      $('loading').classList.add('hidden'); $('menu').classList.remove('hidden');
      $('menu-status').textContent = 'Failed to load: ' + (e && e.message ? e.message : e) + '. Press F5 to reload. If it keeps failing, run tools/extract.bat again.';
    }
  }

  _refreshLightSources() {
    const src = [];
    const add = (l, area) => { if (!l.isPointLight && !l.isSpotLight) return; src.push({ obj: l, area, pos: new THREE.Vector3(), color: l.color.clone(), intensity: l.userData.baseIntensity != null ? Math.min(l.userData.baseIntensity, 60) * LIGHT_GAIN : l.intensity, distance: Math.max((l.distance || 8) * RANGE_GAIN, 14) }); l.visible = false; };
    for (const l of this.world.shipLights) add(l, 'ship');
    for (const l of this.world.moonLights) add(l, 'moon');
    for (const l of this.dungeon.lights) src.push({ obj: null, area: 'inside', pos: l.pos.clone(), color: l.color, intensity: l.intensity, distance: l.distance });
    this.lightSources = src;
    this.lightPool.setSources(src);
  }

  _updateLights() {
    const inside = this.inside, lit = this.world.lightsOn;
    for (const s of this.lightSources) {
      if (s.area === 'inside') { s.enabled = inside; continue; }
      s.enabled = !inside && (s.area !== 'moon' || !this.world.inOrbit);
      if (s.obj) { s.obj.getWorldPosition(s.pos); if (s.area === 'ship') s.intensity = (lit ? 1 : 0) * (s.obj.userData.baseIntensity != null ? Math.min(s.obj.userData.baseIntensity, 60) * LIGHT_GAIN : 0.5); }
    }
    this.lightPool.update(this.player.pos);
  }

  _setupFlashlight() {
    this.flash = new THREE.SpotLight(0xffe9c4, 0, 45, THREE.MathUtils.degToRad(31), 0.7, 1.4);
    this.flash.layers.set(0);
    this.flash.castShadow = true; this.flash.shadow.mapSize.set(1024, 1024); this.flash.shadow.bias = -0.002; this.flash.shadow.camera.near = 0.2;
    this.flashTarget = new THREE.Object3D();
    this.camera.add(this.flash); this.camera.add(this.flashTarget);
    this.flash.position.set(0.25, -0.2, 0.1); this.flashTarget.position.set(0, 0, -5); this.flash.target = this.flashTarget;
    this.nearLight = new THREE.PointLight(0xffffff, 0.0, 6, 2); this.camera.add(this.nearLight);
    this.nearLight.layers.enable(1);
    this.heldLight = new THREE.DirectionalLight(0xffffff, 0.35); this.heldLight.position.set(0.5, 1, 1); this.camera.add(this.heldLight); this.heldLight.target = this.camera; this.heldLight.layers.set(1);
    this.camera.layers.enable(1);
  }

  spawnPlayerInShip() {
    const p = this.world.shipObj.localToWorld(new THREE.Vector3(4.0, 1.4, -9.0));
    this.player.teleport(p, -Math.PI * 0.5);
    this.player.attachTo(this.world.shipObj);
  }

  startMenuMusic() {
    if (this.menuMusic) return;
    const kick = () => { this.sound.resume(); this.sound.play('b9_16', { loop: true, vol: 0.55 }).then(h => { this.menuMusic = h; }); removeEventListener('pointerdown', kick); removeEventListener('keydown', kick); };
    // browsers only allow audio after a gesture; the first click/key on the menu starts it
    addEventListener('pointerdown', kick); addEventListener('keydown', kick);
    this.menuMusic = true;
  }
  stopMenuMusic() { if (this.menuMusic && this.menuMusic.stop) this.menuMusic.stop(1.0); this.menuMusic = null; }

  startGame() {
    if (this.state === 'play') return;
    this.stopMenuMusic();
    this.sound.play('b9_18', { vol: 0.5 });
    $('menu-status').textContent = '';
    $('menu').classList.add('hidden');
    this.hud.show(true);
    this.sound.resume();
    this.state = 'play';
    this._suppressSettings = true; this.player.lock();
    this.world.startLoop('shipAmb', this.world.clips.shipAmb, { vol: 0.35 });
    this.world.startLoop('thruster', this.world.clips.thruster, { vol: 0.25 });
    this.hud.showTip('Pull the lever by the door to land on 41-Experimentation.\nUse the terminal to buy gear and check the quota.', 8);
    this.hud.setQuota(this.scrapOnShip, this.quota, this.daysLeft, this.credits);
  }

  // ---------- events from player ----------
  onKey(code, down) {
    if (!down) return;
    if (this.terminal && this.terminal.open) return;
    if (this.state !== 'play') return;
    if (code === 'KeyE') { this.interact(); this.enemies.onMash(); }
    if (code === 'KeyG') this.items.dropHeld();
    if (code === 'KeyF') this.toggleFlashlight();
    if (code === 'KeyP') { this.settings.v.pixel = !this.settings.v.pixel; this.settings.apply(); this.settings.save(); }
    if (code === 'Digit1') this.items.select(0); if (code === 'Digit2') this.items.select(1); if (code === 'Digit3') this.items.select(2); if (code === 'Digit4') this.items.select(3);
  }
  onMouse(button, down) {
    if (this.state !== 'play' || !down || (this.terminal && this.terminal.open)) return;
    if (button === 0) this.items.useHeld();
    if (button === 2) this.scan();
  }
  onWheel(dir) { if (this.state === 'play' && !(this.terminal && this.terminal.open)) this.items.select((this.items.active + (dir > 0 ? 1 : 3)) % 4); }
  onLockChange(locked) {
    if (!locked && this.state === 'play' && !(this.terminal && this.terminal.open) && this.settings && !this.settings.open && !this._suppressSettings) this.settings.show();
    this._suppressSettings = false;
  }
  backToMenu() {
    this.state = 'menu'; this.hud.show(false); document.exitPointerLock();
    $('menu').classList.remove('hidden');
    this.sound.stopAll(); this.world.loops = {};
    this.menuMusic = null; this.startMenuMusic();
  }
  onJump() { }
  onLand(v) { const clip = this.footClip(); if (clip) this.sound.play(clip, { vol: Math.min(1, 0.5 + -v * 0.03), pitch: 0.9 }); }
  onFootstep() {
    const clip = this.footClip();
    if (clip) this.sound.play(clip, { vol: this.player.sprinting ? 0.55 : this.player.crouching ? 0.15 : 0.35, pitch: 0.95 + Math.random() * 0.1 });
    this.enemies.onNoise(this.player.pos, this.player.sprinting ? 1 : this.player.crouching ? 0.2 : 0.5);
  }
  onLadder(on) { }
  onLadderStep() { const c = this.items.footstep('metal'); if (c) this.sound.play(c, { vol: 0.35, pitch: 1.1 }); }
  footClip() {
    const surf = this.player.attached ? 'metal' : this.inside ? 'concrete' : 'dirt';
    return this.items.footstep(surf);
  }
  onDamage(amount, source) {
    this.hud.flashDamage(Math.min(1, amount / 40));
    const c = this.items.sfx('damage'); if (c) this.sound.play(c, { vol: 0.8 });
  }
  onDeath(source) {
    this.hud.showNotice('YOU DIED', 4);
    this.hud.setSpectate(`Cause of death: ${source || 'unknown'}\nThe ship will leave without you.`);
    this.player.inputEnabled = false;
    const c = this.items.sfx('death'); if (c) this.sound.play(c, { vol: 0.9 });
    this.items.dropAll();
    // the ship leaves without you: doors shut, takeoff, then the day ends
    setTimeout(() => { if (this.state === 'play' && this.world.shipState === 'landed') this.world.setShipState('leaving'); else if (this.state === 'play') this.endDay(true); }, 4000);
  }

  toggleFlashlight() {
    if (!this.items.hasFlashlight()) { this.hud.showTip('No flashlight.', 2); return; }
    if (!this.flashlightOn && this.items.flashlightBattery() <= 0) { this.hud.showTip('Flashlight battery is dead. Charge it on the ship.', 3); return; }
    this.flashlightOn = !this.flashlightOn;
    const c = this.items.sfx(this.flashlightOn ? 'flashOn' : 'flashOff'); if (c) this.sound.play(c, { vol: 0.6 });
  }

  // ---------- interaction ----------
  interact() { const t = this.lookTarget(); if (t && t.action) t.action(); }

  lookTarget() {
    const eye = this.camera.position, dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best = null, bestD = 1e9;
    const consider = (pos, radius, entry) => {
      const reach = entry.reach != null ? entry.reach : 4.0;
      let p = pos;
      if (entry.segment) {
        // ladders: measure to the closest point of the ladder line, not its middle
        const [a, b] = entry.segment(); const ab = b.clone().sub(a); const t = THREE.MathUtils.clamp(eye.clone().sub(a).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1);
        p = a.clone().addScaledVector(ab, t);
      }
      const to = p.clone().sub(eye); const d = to.length();
      if (d > reach + radius * 0.5) return;
      const along = to.dot(dir); if (along < 0) return;
      const perp = Math.sqrt(Math.max(0, d * d - along * along));
      if (perp < radius && d < bestD) { bestD = d; best = entry; }
    };
    if (!this.inside) { for (const it of this.world.interactables) { if (it.obj) consider(this.world.worldPosOf(it.obj), it.radius, it); else if (it.pos) consider(it.pos, it.radius, it); } }
    else for (const it of this.dungeon.interactables) consider(it.pos, it.radius, it);
    for (const it of this.items.interactables()) consider(it.pos, it.radius, it);
    return best;
  }

  scan() {
    if (this.scanCooldown > 0) return;
    this.scanCooldown = 1.1;
    this.scanT = 3.0;
    this.hud.scanPulse();
    const c = this.items.sfx('scan'); if (c) this.sound.play(c, { vol: 0.5 });
    this.scanTargets = this.items.scannables(this.camera.position, 60).concat(this.enemies.scannables(this.camera.position, 60), this.dungeon.scannables(this.camera.position, 80));
  }

  openTerminal() { this._suppressSettings = true; this.terminal.show(); }
  showManual() { this.hud.showTip('WELCOME TO THE COMPANY\n1. Land on the moon (lever).\n2. Find the facility entrance.\n3. Collect scrap, bring it to the ship.\n4. Be back before midnight.\n5. Do not die. Cost of replacement is high.', 10); }

  // ---------- day flow ----------
  onShipDeparting(leaving) {
    if (leaving) { this.hud.showNotice('SHIP DEPARTING', 3, '#e8c85a'); }
  }
  onShipLanded() {
    this.hud.showNotice('LANDED ON 41-EXPERIMENTATION', 4, '#e8c85a');
    this.dayCount++;
    this.dungeon.generate(this.dayCount * 7919 + Date.now() % 1000).then(() => { this.items.spawnScrap(); this._refreshLightSources(); });
    this.enemies.beginDay();
    this.world.stopLoop('thruster');
    this.world.startLoop('outside', this.items.ambienceClip('outside'), { vol: 0.5 });
    this.items.onLanded();
  }
  onShipLeft() { this.endDay(this.player.dead); }
  endDay(playerDead) {
    if (this.state !== 'play') return;
    this.state = 'results';
    const collected = this.items.scrapValueOnShip();
    this.scrapOnShip = collected;
    this.daysLeft--;
    const lines = [];
    lines.push(playerDead ? 'The ship left without you. Your body was not recovered.' : 'You returned to the ship.');
    lines.push(`Scrap on ship: $${collected}`);
    lines.push(`Profit quota: $${this.quota}   (${this.daysLeft} day${this.daysLeft === 1 ? '' : 's'} left)`);
    let fired = false;
    if (this.daysLeft <= 0) {
      if (collected >= this.quota) {
        lines.push(`\nQUOTA MET. The Company is... satisfied. New quota assigned.`);
        this.credits += collected - this.quota;
        this.quotaRound++;
        this.quota = Math.round(this.quota + 100 * (1 + Math.pow(this.quotaRound, 2) / 16) * (0.85 + Math.random() * 0.3));
        this.items.sellScrap();
        this.scrapOnShip = 0;
        this.daysLeft = 3;
      } else {
        lines.push(`\nQUOTA NOT MET. Performance review: unacceptable.\nYou have been let go. Every crew member is jettisoned into space.`);
        fired = true;
      }
    }
    if (playerDead) lines.push('\nA new employee has been hired to replace you.');
    $('results-text').textContent = lines.join('\n');
    $('results').classList.remove('hidden');
    this._suppressSettings = true; document.exitPointerLock();
    this.fired = fired;
    this.enemies.clearAll();
    this.dungeon.clear();
    this.items.clearWorldScrap();
    this.world.stopLoop('outside'); this.world.stopLoop('inside');
    this.hud.setSpectate('');
    const c = this.items.sfx('results'); if (c) this.sound.play(c, { vol: 0.5 });
  }
  continueAfterResults() {
    $('results').classList.add('hidden');
    if (this.fired) { this.quota = 130; this.credits = 60; this.daysLeft = 3; this.scrapOnShip = 0; this.quotaRound = 1; this.items.sellScrap(); this.fired = false; }
    this.player.dead = false; this.player.health = 100; this.player.inputEnabled = true; this.player.ladder = null;
    this.inside = false;
    this.spawnPlayerInShip();
    this.items.clearInventory();
    this.state = 'play';
    this.hud.setQuota(this.scrapOnShip, this.quota, this.daysLeft, this.credits);
    this.player.lock();
    this.world.startLoop('thruster', this.world.clips.thruster, { vol: 0.25 });
  }

  // ---------- facility transitions ----------
  enterFacility(viaFireExit) {
    const spot = viaFireExit ? this.dungeon.fireExitInside : this.dungeon.entranceInside;
    if (!spot) return;
    this.inside = true;
    this.player.attachTo(null);
    this.player.teleport(spot.pos, spot.yaw);
    const c = pickClip(this.world.entrance?.clips); if (c) this.sound.play(c, { vol: 0.8 });
    this.world.stopLoop('outside'); this.world.startLoop('inside', this.items.ambienceClip('inside'), { vol: 0.45 });
    this.enemies.onPlayerEntered(true);
  }
  exitFacility(viaFireExit) {
    const ent = viaFireExit ? this.world.fireExit : this.world.entrance;
    if (!ent) return;
    this.inside = false;
    const p = this.world.worldPosOf(ent.tele);
    const q = new THREE.Quaternion(); ent.tele.getWorldQuaternion(q);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    this.player.teleport(p.clone().add(new THREE.Vector3(0, 0.1, 0)), Math.atan2(-f.x, -f.z));
    const c = pickClip(ent.clips); if (c) this.sound.play(c, { vol: 0.8 });
    this.world.stopLoop('inside'); this.world.startLoop('outside', this.items.ambienceClip('outside'), { vol: 0.5 });
    this.enemies.onPlayerEntered(false);
  }

  activeColliders() {
    const list = [];
    if (this.inside) { if (this.dungeon.collider) list.push(this.dungeon.collider); for (const d of this.dungeon.doors) if (d.collider && !d.open) list.push(d.collider); }
    else { list.push(this.world.shipCollider, ...this.world.doorColliders); if (!this.world.inOrbit) list.push(this.world.moonCollider); }
    return list;
  }

  // ---------- loop ----------
  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(0.05, this.clock.getDelta());
    this.tick(dt);
    this.renderer.render(this.scene, this.camera);
  }

  step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) this.tick(dt); this.renderer.render(this.scene, this.camera); }

  tick(dt) {
    const p = this.player;
    if (this.paused) { this.hud.update(dt); return; }
    if (this.lightPool) this.lightPool.gain = this.lightGain;
    if (this.state === 'play' || this.state === 'menu' || this.state === 'results') {
      this.world.update(dt);
      if (this.state === 'play') {
        p.update(dt, this.activeColliders());
        p.heal(dt);
        if (!this.inside) {
          // ride the ship whenever we stand on it (or on its doors) or are inside its room while it moves
          const w = this.world;
          // anywhere on the deck (room + catwalk) counts as riding the ship, whatever the terrain under it says
          const onShipGeom = p.groundCollider === w.shipCollider || w.doorColliders.includes(p.groundCollider);
          p.attachTo(onShipGeom || w.onShipDeck(p.pos) ? w.shipObj : null);
          if (w.inOrbit && !p.attached && !w.onShipDeck(p.pos)) p.damage(1000, 'space');
        }
        this.items.update(dt);
        this.enemies.update(dt);
        this.dungeon.update(dt);
        this._updateHud(dt);
        this._updateScan(dt);
      }
      this.dungeon.root.visible = this.inside;
      this.world.moonRoot.visible = !this.inside && !this.world.inOrbit;
      this.world.shipRoot.visible = !this.inside;
      this.world.sun.visible = !this.inside;
      this.world.setFocus(p.pos);
      this._updateLights();
      if (this.flashlightOn && this.items.flashlightBattery() <= 0) this.flashlightOn = false;
      const on = this.flashlightOn && this.items.hasFlashlight() && this.state === 'play';
      this.flash.intensity += ((on ? 140 : 0) - this.flash.intensity) * Math.min(1, dt * 14);
      this.nearLight.intensity = this.inside ? 0.3 : 0.1;
      this.sound.setListener(this.camera.position, new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion), new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion));
      this.hud.update(dt);
    }
  }

  _updateHud(dt) {
    const w = this.world, p = this.player;
    const { h, m } = w.clockText();
    this.hud.setClock(h, m, w.dayFrac, !this.inside && !w.inOrbit);
    this.hud.setStamina(p.stamina, this.items.carryWeightLb());
    this.hud.setHealth(p.health);
    const t = this.lookTarget();
    this.hud.setTooltip(t ? (typeof t.label === 'function' ? t.label() : t.label) : (p.ladder ? 'W/S climb  ·  Space let go' : ''));
    this.hud.setQuota(this.items.scrapValueOnShip(), this.quota, this.daysLeft, this.credits);
    if (w.shipState === 'landed' && w.dayFrac >= 1) { w.setShipState('leaving'); this.hud.showNotice('THE SHIP IS LEAVING', 4); }
    else if (w.shipState === 'landed' && w.dayFrac > 0.93 && !this._warned) { this._warned = true; this.hud.showNotice('THE SHIP LEAVES AT MIDNIGHT', 4, '#e8c85a'); const c = this.items.sfx('alert'); if (c) this.sound.play(c, { vol: 0.6 }); }
    if (w.shipState !== 'landed') this._warned = false;
  }

  _updateScan(dt) {
    this.scanCooldown = (this.scanCooldown || 0) - dt;
    if (this.scanT <= 0) { this.hud.setScanTags([]); return; }
    this.scanT -= dt;
    const tags = [];
    const v = new THREE.Vector3();
    for (const s of this.scanTargets) {
      const pos = s.pos();
      if (!pos) continue;
      v.copy(pos).project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      tags.push({ x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, text: s.text, value: s.value, alpha: Math.min(1, this.scanT) });
    }
    this.hud.setScanTags(tags);
  }
}

new Game().boot();
