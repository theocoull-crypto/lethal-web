// Fixed pool of real point lights fed by many "virtual" lights: the nearest N to the player are active.
import * as THREE from 'three';

export class LightPool {
  constructor(scene, count = 10) {
    this.scene = scene;
    this.pool = [];
    for (let i = 0; i < count; i++) { const l = new THREE.PointLight(0xffffff, 0, 10, 2); l.visible = false; scene.add(l); this.pool.push(l); }
    this.sources = [];   // {pos, color, intensity, distance, enabled}
  }

  setSources(list) { this.sources = list; }

  update(from) {
    const active = this.sources.filter(s => s.enabled !== false && s.intensity > 0);
    active.sort((a, b) => a.pos.distanceToSquared(from) - b.pos.distanceToSquared(from));
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i], s = active[i];
      if (!s) { l.visible = false; l.intensity = 0; continue; }
      l.visible = true; l.position.copy(s.pos); l.color.copy(s.color); l.intensity = s.intensity; l.distance = s.distance; l.decay = 2;
    }
  }
}
