// In-game settings (Esc): brightness, light gain, shadows, FOV, sensitivity, volume, pixel filter, grain. Saved in localStorage.
const $ = id => document.getElementById(id);
const DEFAULTS = { exposure: 1.15, lightGain: 1.0, shadows: 1, fov: 75, sensitivity: 1.0, volume: 0.9, pixel: true, grain: true };

export class Settings {
  constructor(game) {
    this.game = game;
    this.v = Object.assign({}, DEFAULTS);
    try { const s = JSON.parse(localStorage.getItem('lethalweb.settings') || '{}'); Object.assign(this.v, s); } catch (e) { }
    this.el = $('settings');
    this.open = false;
    this._build();
    this.apply();
  }

  _build() {
    const rows = [
      ['exposure', 'Brightness', 'range', 0.5, 2.5, 0.05],
      ['lightGain', 'Light strength', 'range', 0.3, 3.0, 0.1],
      ['shadows', 'Shadows', 'select', ['Off', 'Sun + flashlight', 'Sun + flashlight + 2 lamps', 'Sun + flashlight + 4 lamps']],
      ['fov', 'Field of view', 'range', 60, 105, 1],
      ['sensitivity', 'Mouse sensitivity', 'range', 0.2, 3.0, 0.05],
      ['volume', 'Volume', 'range', 0, 1, 0.05],
      ['pixel', 'Pixel filter (P)', 'check'],
      ['grain', 'Film grain', 'check'],
    ];
    const box = $('settings-rows');
    box.innerHTML = '';
    for (const [key, label, type, a, b, c] of rows) {
      const row = document.createElement('div'); row.className = 'srow';
      const lab = document.createElement('label'); lab.textContent = label; row.appendChild(lab);
      let input;
      if (type === 'range') { input = document.createElement('input'); input.type = 'range'; input.min = a; input.max = b; input.step = c; input.value = this.v[key]; }
      else if (type === 'check') { input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!this.v[key]; }
      else { input = document.createElement('select'); a.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = t; input.appendChild(o); }); input.value = this.v[key]; }
      const val = document.createElement('span'); val.className = 'sval';
      const show = () => { val.textContent = type === 'range' ? (key === 'fov' ? Math.round(this.v[key]) : (+this.v[key]).toFixed(2)) : ''; };
      input.addEventListener('input', () => { this.v[key] = type === 'check' ? input.checked : parseFloat(input.value); show(); this.apply(); this.save(); });
      row.appendChild(input); row.appendChild(val); box.appendChild(row); show();
    }
    $('btn-settings-close').onclick = () => this.hide();
    $('btn-settings-reset').onclick = () => { this.v = Object.assign({}, DEFAULTS); this.save(); this._build(); this.apply(); };
    $('btn-settings-menu').onclick = () => { this.hide(); this.game.backToMenu(); };
  }

  save() { try { localStorage.setItem('lethalweb.settings', JSON.stringify(this.v)); } catch (e) { } }

  apply() {
    const g = this.game, v = this.v;
    g.renderer.toneMappingExposure = v.exposure;
    g.lightGain = v.lightGain;
    g.shadowLamps = [0, 0, 2, 4][v.shadows] || 0;
    g.shadowsOn = v.shadows > 0;
    g.renderer.shadowMap.enabled = g.shadowsOn;
    if (g.world && g.world.sun) g.world.sun.castShadow = g.shadowsOn;
    if (g.flash) g.flash.castShadow = g.shadowsOn;
    g.camera.fov = v.fov; g.camera.updateProjectionMatrix();
    if (g.player) g.player.lookSensitivity = 0.0022 * v.sensitivity;
    if (g.sound && g.sound.master) g.sound.master.gain.value = v.volume;
    if (g.pixelFilter !== !!v.pixel) { g.pixelFilter = !!v.pixel; g._resize(); }
    document.body.classList.toggle('nofilter', !v.pixel);
    document.body.classList.toggle('nograin', !v.grain);
    if (g.lightPool) g.lightPool.setShadowCount(g.shadowLamps);
    // materials need a recompile when the shadow map toggles
    if (this._lastShadows !== g.shadowsOn) { g.scene.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; }); this._lastShadows = g.shadowsOn; }
  }

  show() {
    if (this.open) return;
    this.open = true; this.el.classList.remove('hidden');
    document.exitPointerLock();
    this.game.player.keys = {};
    this.game.paused = true;
  }
  hide() {
    if (!this.open) return;
    this.open = false; this.el.classList.add('hidden');
    this.game.paused = false;
    if (this.game.state === 'play') this.game.player.lock();
  }
  toggle() { this.open ? this.hide() : this.show(); }
}
