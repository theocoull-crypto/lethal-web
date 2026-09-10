// DOM HUD in the style of the game's own UI.
const $ = id => document.getElementById(id);

export class HUD {
  constructor() {
    this.el = $('hud');
    this.clock = $('clock'); this.clockTime = $('clock-time'); this.clockFill = $('clock-fill');
    this.staminaFill = $('stamina-fill'); this.weight = $('weight');
    this.slots = [...document.querySelectorAll('#inventory .slot')];
    this.tooltip = $('tooltip'); this.tip = $('tip'); this.tipTimer = 0;
    this.quotaLine = $('quota-line'); this.quotaSub = $('quota-sub');
    this.notice = $('notice'); this.noticeTimer = 0;
    this.damage = $('damage'); this.damageT = 0;
    this.scan = $('scan'); this.scanTags = [];
    this.spectate = $('spectate');
    this.vignette = $('vignette');
  }

  show(v) { this.el.classList.toggle('hidden', !v); }

  setClock(hour, minute, frac, visible = true) {
    this.clock.style.display = visible ? '' : 'none';
    const h12 = ((Math.floor(hour) + 11) % 12) + 1;
    const ampm = hour >= 12 && hour < 24 ? 'PM' : 'AM';
    this.clockTime.textContent = `${h12}:${String(Math.floor(minute)).padStart(2, '0')} ${ampm}`;
    this.clockFill.style.width = (frac * 100).toFixed(1) + '%';
  }

  setStamina(v, weight) {
    this.staminaFill.style.width = (v * 100).toFixed(1) + '%';
    this.staminaFill.style.background = v < 0.2 ? '#d94a3a' : '';
    this.weight.textContent = Math.round(weight) + ' lb';
  }

  setInventory(items, active) {
    this.slots.forEach((s, i) => {
      s.classList.toggle('active', i === active);
      const it = items[i];
      s.innerHTML = it ? `<div class="nm">${it.name}</div>${it.value ? `<div class="val">$${it.value}</div>` : ''}${it.battery != null ? `<div class="bat"><i style="width:${Math.round(it.battery * 100)}%"></i></div>` : ''}` : '';
    });
  }

  setTooltip(t) { this.tooltip.textContent = t || ''; }
  scanPulse() { const p = document.getElementById('scanpulse'); p.classList.remove('go'); void p.offsetWidth; p.classList.add('go'); }

  showTip(text, seconds = 5) { this.tip.textContent = text; this.tip.style.opacity = 1; this.tipTimer = seconds; }

  setQuota(collected, quota, daysLeft, credits) {
    this.quotaLine.textContent = `SCRAP ON SHIP $${collected}  /  QUOTA $${quota}`;
    this.quotaSub.textContent = daysLeft == null ? '' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} until deadline   ·   credits $${credits}`;
  }

  showNotice(text, seconds = 3, color = '#ff5040') { this.notice.textContent = text; this.notice.style.color = color; this.notice.style.opacity = 1; this.noticeTimer = seconds; }

  flashDamage(strength = 1) { this.damageT = Math.max(this.damageT, 0.6 * strength); }

  setHealth(h) { this.vignette.style.background = `radial-gradient(ellipse at center, rgba(0,0,0,0) ${45 + h * 0.15}%, rgba(${h < 40 ? 90 : 0},0,0,${0.55 + (100 - h) * 0.004}) 100%)`; }

  setSpectate(t) { this.spectate.textContent = t || ''; }

  /** tags: [{x,y,text,value,alpha}] in screen px */
  setScanTags(tags) {
    while (this.scanTags.length < tags.length) { const d = document.createElement('div'); d.className = 'tag'; this.scan.appendChild(d); this.scanTags.push(d); }
    this.scanTags.forEach((d, i) => {
      const t = tags[i];
      if (!t) { d.style.display = 'none'; return; }
      d.style.display = ''; d.style.left = t.x + 'px'; d.style.top = t.y + 'px'; d.style.opacity = t.alpha;
      d.innerHTML = t.text + (t.value != null ? ` <span class="v">$${t.value}</span>` : '');
    });
  }

  update(dt) {
    if (this.tipTimer > 0) { this.tipTimer -= dt; if (this.tipTimer <= 0) this.tip.style.opacity = 0; }
    if (this.noticeTimer > 0) { this.noticeTimer -= dt; if (this.noticeTimer <= 0) this.notice.style.opacity = 0; }
    if (this.damageT > 0) { this.damageT -= dt; this.damage.style.opacity = Math.min(1, this.damageT * 2); } else this.damage.style.opacity = 0;
  }
}
