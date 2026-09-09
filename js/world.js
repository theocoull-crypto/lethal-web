// World assembly: ship, moon exterior, sky/sun/fog, time of day, ship landing/leaving, doors, lever, lights.
import * as THREE from 'three';
import { Collider, collisionEntries } from './collision.js';
import { pickClip } from './audio.js';

const DAY_SECONDS = 780;          // ~13 real minutes from 8 AM to midnight (game: 1080 time units / 1.4)
const START_HOUR = 8, END_HOUR = 24;

export class World {
  constructor(game) {
    this.game = game; this.lib = game.lib; this.scene = game.scene;
    this.ship = null; this.moon = null;
    this.shipRoot = new THREE.Group(); this.shipRoot.name = 'ShipRoot';
    this.moonRoot = new THREE.Group(); this.moonRoot.name = 'MoonRoot';
    this.scene.add(this.shipRoot, this.moonRoot);
    this.colliders = [];
    this.shipCollider = null; this.moonCollider = null;
    this.landedY = 0; this.shipHeight = 0;
    this.shipState = 'orbit';   // orbit | landing | landed | leaving
    this.shipT = 0;
    this.doorsOpen = false; this.doorT = 0;
    this.lightsOn = true;
    this.time = 0;             // seconds since landing
    this.dayFrac = 0;
    this.hour = START_HOUR;
    this.sun = null; this.hemi = null; this.ambient = null;
    this.interactables = [];
    this.loops = {};
    this.moonLights = [];
    this.entrance = null; this.fireExit = null;
    this.shipLandingPos = new THREE.Vector3(-1.27, 0.28, -7.5);
    this.entranceDoorAnim = 0;
  }

  async load(progress) {
    const lib = this.lib;
    const shipMan = await lib.manifest('scenes/ship.json');
    progress && progress('Assembling the ship...');
    const shipInst = await lib.instantiate(shipMan, { lights: true });
    this.ship = shipInst;
    // the HangarShip root carries its landed world transform; we drive shipRoot instead
    const shipObj = shipInst.root.children[0];
    this.shipLandingPos.copy(shipObj.position);
    this.shipYaw = shipObj.quaternion.clone();
    shipObj.position.set(0, 0, 0); shipObj.quaternion.identity();
    this.shipRoot.add(shipInst.root);
    this.shipRoot.position.copy(this.shipLandingPos); this.shipRoot.quaternion.copy(this.shipYaw);
    this.shipObj = shipObj;
    this._setupShipParts();
    // collision for the ship: mesh colliders + boxes, in ship-local space
    const entries = await collisionEntries(lib, shipInst, { relativeTo: this.shipRoot });
    this.shipCollider = new Collider('ship').build(entries, this.shipRoot);
    this.colliders.push(this.shipCollider);

    progress && progress('Loading 41-Experimentation...');
    const moonMan = await lib.manifest('scenes/experimentation.json');
    const moonInst = await lib.instantiate(moonMan, { lights: true, staticRoot: this.moonRoot });
    this.moon = moonInst;
    this.moonRoot.add(moonInst.root);
    this.moonRoot.visible = false;
    const mEntries = await collisionEntries(lib, moonInst, {});
    // static batched world meshes have MeshColliders on their nodes referencing the source meshes, good. Add terrain + entrance visuals.
    this.moonCollider = new Collider('moon').build(mEntries, null);
    this.colliders.push(this.moonCollider);
    this._setupMoonParts();
    this._setupSky();
    this.setShipState('orbit');
    return this;
  }

  // ---------- ship ----------
  _setupShipParts() {
    const by = n => this.ship.byName.get(n)?.[0] || null;
    this.doorL = by('HangarDoorLeft'); this.doorR = by('HangarDoorRight');
    this.doorLRest = this.doorL ? this.doorL.position.clone() : null; this.doorRRest = this.doorR ? this.doorR.position.clone() : null;
    this.lever = by('StartGameLever'); this.leverModel = by('HangarDoorLever');
    this.shipLightsRoot = by('ShipElectricLights');
    this.lightSwitch = by('LightSwitchContainer');
    this.terminal = by('Terminal');
    this.shipInside = by('ShipInside');
    this.clipboard = by('ClipboardManual');
    // catwalk / interior entry points
    this.shipInterior = by('ShipInside.001') || this.shipInside;
    // audio nodes
    const clipOf = n => { const o = by(n); if (!o) return null; const c = o.userData.node.comps.find(x => x.t === 'Audio'); return c ? c.clip : null; };
    this.clips = {
      thruster: clipOf('ThrusterAmbientAudio'), turbulence: clipOf('ShipLandingTurbulence'), lamp: clipOf('LampSqueakAudio'),
      doorsJingle: clipOf('ShipDoorsCloseJingle'), hangarDoor: clipOf('HangarDoorAudioSource'), shipAmb: clipOf('HangarShip'),
    };
    const mb = (n, cls) => { const o = by(n); if (!o) return null; return o.userData.node.comps.find(x => x.t === 'MB' && x.cls === cls) || null; };
    const shipDoorEv = mb('AnimatedShipDoor', 'PlayAudioAnimationEvent');
    if (shipDoorEv && shipDoorEv.d) { this.clips.doorOpen = shipDoorEv.d.audioClip?.$ || null; this.clips.doorShut = shipDoorEv.d.audioClip2?.$ || null; }
    const leverEv = mb('HangarDoorLever', 'PlayAudioAnimationEvent');
    if (leverEv && leverEv.d) { this.clips.leverStart = leverEv.d.audioClip2?.$ || leverEv.d.audioClip?.$; this.clips.leverEnd = leverEv.d.audioClip?.$; }
    const sw = mb('LightSwitch', 'AnimatedObjectTrigger');
    if (sw && sw.d) { this.clips.switchOn = sw.d.boolTrueAudios?.[0]?.$ || sw.d.boolFalseAudios?.[0]?.$; }
    // ship lights: collect point lights under ShipElectricLights
    this.shipLights = [];
    this.ship.root.traverse(o => { if (o.isLight) { o.userData.baseIntensity = o.intensity; this.shipLights.push(o); } });
    // registered interactables (position in shipRoot space)
    if (this.lever) this.interactables.push({ obj: this.lever, radius: 1.6, label: () => this.shipState === 'orbit' ? '[E] Pull lever : land ship' : this.shipState === 'landed' ? '[E] Pull lever : leave moon' : '', action: () => this.pullLever() });
    if (this.lightSwitch) this.interactables.push({ obj: this.lightSwitch, radius: 1.3, label: () => '[E] Light switch', action: () => this.toggleLights() });
    if (this.terminal) this.interactables.push({ obj: this.terminal, radius: 1.8, label: () => '[E] Terminal', action: () => this.game.openTerminal() });
    if (this.clipboard) this.interactables.push({ obj: this.clipboard, radius: 1.3, label: () => '[E] Read clipboard', action: () => this.game.showManual() });
    // dim scene inside ship uses point lights from manifest; tone them
    for (const l of this.shipLights) { l.intensity = Math.min(l.userData.baseIntensity, 40) * 0.02; l.decay = 2; l.distance = Math.max(l.distance, 12); l.castShadow = false; }
  }

  toggleLights() {
    this.lightsOn = !this.lightsOn;
    this.game.sound.play(this.clips.switchOn, { pos: this.worldPosOf(this.lightSwitch), vol: 0.7 });
  }

  worldPosOf(o) { const v = new THREE.Vector3(); o.getWorldPosition(v); return v; }

  pullLever() {
    if (this.shipState === 'orbit') { this.setShipState('landing'); this.game.onShipDeparting(false); }
    else if (this.shipState === 'landed') { this.setShipState('leaving'); this.game.onShipDeparting(true); }
    if (this.leverModel) this.leverModel.rotation.x = this.shipState === 'landing' ? 0.6 : -0.6;
    this.game.sound.play(this.clips.leverStart, { pos: this.worldPosOf(this.lever), vol: 0.8 });
  }

  setShipState(s) {
    this.shipState = s; this.shipT = 0;
    if (s === 'orbit') { this.shipRoot.position.y = this.shipLandingPos.y + 400; this.setDoors(false, true); this.moonRoot.visible = false; }
    if (s === 'landing') { this.moonRoot.visible = true; this.startLoop('turbulence', this.clips.turbulence, { vol: 0.9 }); }
    if (s === 'landed') { this.shipRoot.position.y = this.shipLandingPos.y; this.stopLoop('turbulence'); this.setDoors(true); this.time = 0; }
    if (s === 'leaving') { this.setDoors(false); this.startLoop('turbulence', this.clips.turbulence, { vol: 0.9 }); }
  }

  setDoors(open, instant = false) {
    if (this.doorsOpen === open && !instant) return;
    this.doorsOpen = open;
    if (instant) this.doorT = open ? 1 : 0;
    if (!instant) this.game.sound.play(open ? this.clips.doorOpen : this.clips.doorShut, { pos: this.worldPosOf(this.doorL || this.shipObj), vol: 0.9, min: 3, max: 60 });
  }

  startLoop(name, clip, opts) {
    if (!clip || this.loops[name]) return;
    this.loops[name] = true;
    this.game.sound.play(clip, { loop: true, ...opts }).then(h => { if (this.loops[name] === true) this.loops[name] = h; else if (h) h.stop(); });
  }
  stopLoop(name, fade = 1) { const h = this.loops[name]; if (h && h !== true) h.stop(fade); delete this.loops[name]; }

  // ---------- moon ----------
  _setupMoonParts() {
    const by = n => this.moon.byName.get(n) || [];
    // entrances: EntranceTeleportA (main), EntranceTeleportB (fire exit); telePoint child = where you appear when exiting
    const ents = [];
    for (const [id, o] of this.moon.objs) {
      const n = o.userData.node;
      const et = n.comps.find(c => c.t === 'MB' && c.cls === 'EntranceTeleport');
      if (et) {
        const tp = o.children.find(ch => ch.name === 'telePoint');
        ents.push({ obj: o, tele: tp || o, id: et.d?.entranceId ?? 0, isEntrance: et.d?.isEntranceToBuilding, clips: [et.d?.doorAudios?.[0]?.$, et.d?.doorAudios?.[1]?.$].filter(Boolean) });
      }
    }
    ents.sort((a, b) => a.id - b.id);
    this.entrance = ents[0] || null; this.fireExit = ents[1] || null;
    // outside AI nodes
    this.outsideNodes = [];
    for (const o of by('OutsideAIPoints')) o.children.forEach(c => this.outsideNodes.push(this.worldPosOf(c)));
    if (!this.outsideNodes.length) { this.moon.root.traverse(o => { if (/OutsideAINode/.test(o.name)) this.outsideNodes.push(this.worldPosOf(o)); }); }
    // moon lights
    this.moon.root.traverse(o => { if (o.isLight) { o.userData.baseIntensity = o.intensity; this.moonLights.push(o); } });
    for (const l of this.moonLights) {
      if (l.isPointLight || l.isSpotLight) { l.intensity = Math.min(l.userData.baseIntensity, 60) * 0.03; l.distance = Math.max(l.distance, 14); l.decay = 2; l.castShadow = false; }
      else if (l.isDirectionalLight) { l.visible = false; }
    }
    // entrance door visuals (OutsideEntranceVisualDoorsContainer) - keep static
    // quicksand: skip
  }

  // ---------- sky / time ----------
  _setupSky() {
    this.sun = new THREE.DirectionalLight(0xffe6c8, 1.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 400;
    const s = 70; this.sun.shadow.camera.left = -s; this.sun.shadow.camera.right = s; this.sun.shadow.camera.top = s; this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0008; this.sun.shadow.normalBias = 0.05;
    this.sunTarget = new THREE.Object3D(); this.scene.add(this.sunTarget); this.sun.target = this.sunTarget;
    this.scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0x8a7e78, 0x2a2118, 0.6); this.hemi.layers.enable(1); this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0x403830, 0.35); this.scene.add(this.ambient);
    this.scene.fog = new THREE.FogExp2(0x5c4e44, 0.012);
    this.scene.background = new THREE.Color(0x5c4e44);
    // stars for orbit
    const g = new THREE.BufferGeometry(); const pts = [];
    for (let i = 0; i < 1500; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(900); pts.push(v.x, v.y, v.z); }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: true, fog: false }));
    this.scene.add(this.stars);
    // planet in orbit view
    const planet = new THREE.Mesh(new THREE.SphereGeometry(260, 48, 32), new THREE.MeshStandardMaterial({ color: 0x7a5a48, roughness: 1, fog: false }));
    planet.position.set(120, -420, -520); this.planet = planet; this.scene.add(planet);
  }

  get inOrbit() { return this.shipState === 'orbit'; }

  update(dt) {
    // ship motion
    if (this.shipState === 'landing') {
      this.shipT += dt;
      const T = 9; const t = Math.min(1, this.shipT / T);
      const e = 1 - Math.pow(1 - t, 3);
      this.shipRoot.position.y = this.shipLandingPos.y + 400 * (1 - e);
      this.shipRoot.rotation.z = Math.sin(this.shipT * 7) * 0.004 * (1 - t);
      if (t >= 1) { this.shipRoot.rotation.z = 0; this.setShipState('landed'); this.game.onShipLanded(); }
    } else if (this.shipState === 'leaving') {
      this.shipT += dt;
      if (this.shipT > 3.5) {
        const t = Math.min(1, (this.shipT - 3.5) / 8);
        this.shipRoot.position.y = this.shipLandingPos.y + 400 * t * t;
        if (t >= 1) { this.setShipState('orbit'); this.game.onShipLeft(); }
      }
    } else if (this.shipState === 'landed') {
      this.time += dt;
    }
    // doors slide
    const target = this.doorsOpen ? 1 : 0;
    this.doorT += (target - this.doorT) * Math.min(1, dt * 2.2);
    if (this.doorL && this.doorLRest) { this.doorL.position.z = this.doorLRest.z - 2.2 * this.doorT; }
    if (this.doorR && this.doorRRest) { this.doorR.position.z = this.doorRRest.z + 2.2 * this.doorT; }
    // time of day
    if (this.shipState === 'landed' || this.shipState === 'leaving') {
      this.dayFrac = Math.min(1, this.time / DAY_SECONDS);
    }
    const hoursTotal = END_HOUR - START_HOUR;
    this.hour = START_HOUR + this.dayFrac * hoursTotal;
    this._updateSky();
    // ship lights
    const lit = this.lightsOn ? 1 : 0;
    for (const l of this.shipLights) l.intensity += ((l.userData.baseIntensity > 0 ? Math.min(l.userData.baseIntensity, 40) * 0.02 : 0) * lit - l.intensity) * Math.min(1, dt * 10);
  }

  _updateSky() {
    const orbit = this.shipState === 'orbit';
    // sun elevation: rises from ~20deg at 8AM to 55 at 1PM, sets ~7PM
    const f = this.dayFrac;
    const elev = orbit ? 0.6 : Math.sin(Math.PI * Math.min(1, Math.max(0, (f - 0.02) / 0.72))) * 0.95 - 0.05;
    const dusk = THREE.MathUtils.smoothstep(f, 0.55, 0.78);   // 6PM -> 9PM darkening
    const night = THREE.MathUtils.smoothstep(f, 0.7, 0.9);
    const az = -0.8 + f * 2.6;
    this.sun.position.set(Math.cos(az) * 120, Math.max(0.03, elev) * 150, Math.sin(az) * 120).add(this.sunTarget.position);
    const dayCol = new THREE.Color(0xffe2c0), duskCol = new THREE.Color(0xd06a3a), nightCol = new THREE.Color(0x1a2038);
    const sunCol = dayCol.clone().lerp(duskCol, dusk).lerp(nightCol, night);
    this.sun.color.copy(sunCol);
    this.sun.intensity = orbit ? 2.0 : (1.4 * Math.max(0, elev) + 0.15) * (1 - night * 0.97);
    this.sun.visible = true;
    const fogDay = new THREE.Color(0x5e5048), fogDusk = new THREE.Color(0x3f2b24), fogNight = new THREE.Color(0x07080b);
    const fog = fogDay.clone().lerp(fogDusk, dusk).lerp(fogNight, night);
    if (orbit) { this.scene.fog.density = 0.0; this.scene.background.set(0x000004); this.stars.visible = true; this.planet.visible = true; }
    else { this.scene.fog.color.copy(fog); this.scene.fog.density = 0.011 + night * 0.006; this.scene.background.copy(fog); this.stars.visible = night > 0.6; this.planet.visible = false; }
    if (this.game.inside) { this.scene.fog.color.set(0x030303); this.scene.fog.density = 0.028; this.scene.background.set(0x030303); this.stars.visible = false; this.planet.visible = false; }
    this.hemi.intensity = orbit ? 0.25 : this.game.inside ? 0.06 : 0.55 * (1 - night * 0.9) + 0.03;
    this.hemi.color.copy(new THREE.Color(0x9a8c84).lerp(new THREE.Color(0x202838), night));
    this.ambient.intensity = orbit ? 0.15 : this.game.inside ? 0.05 : 0.3 * (1 - night * 0.85) + 0.02;
    this.inside = false;
  }

  /** keep shadow camera centred on the player */
  setFocus(p) { this.sunTarget.position.copy(p); this.sunTarget.updateMatrixWorld(); }

  clockText() {
    const h = Math.floor(this.hour) % 24; const m = Math.floor((this.hour % 1) * 60);
    return { h, m };
  }

  isNight() { return this.dayFrac > 0.72; }
}
