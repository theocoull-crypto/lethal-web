// The ship terminal: a text console with the commands the demo supports (help, store, buy, moons, route, scan, quota, exit).
// Like the real terminal you only need the first letters of a word ("mo", "sto", "rou exp", or just "exp"); typos are
// corrected to the closest keyword, and a ghost suggestion shows the completion (Tab or → accepts it).
const $ = id => document.getElementById(id);

const COMMANDS = ['help', 'moons', 'store', 'buy', 'route', 'scan', 'quota', 'clear', 'exit', 'view', 'confirm', 'deny'];
const MOONS = [
  { key: 'moon', label: '41-Experimentation', names: ['experimentation', '41-experimentation', '41'] },
  { key: 'company', label: 'The Company building', names: ['company', 'the company building', 'company building', 'the company'] },
];

// edit distance, for typo tolerance
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// how well `input` matches `word`: lower is better, null = no match
function score(input, word) {
  if (!input) return null;
  if (word === input) return 0;
  if (word.startsWith(input)) return 1 + (word.length - input.length) * 0.001;
  if (input.length >= 3) {
    const d = lev(input, word.slice(0, input.length));   // typo inside a prefix ("expermen" -> "experimen")
    if (d <= Math.max(1, Math.floor(input.length / 4))) return 2 + d;
    const w = word.split(/[\s-]+/).find(x => x.startsWith(input));   // a later word ("company" in "the company building")
    if (w) return 2.5;
  }
  return null;
}

// best candidate from a list of {names:[...]} objects (ties keep list order)
function best(input, cands) {
  let hit = null;
  for (const c of cands) for (const name of c.names) {
    const s = score(input, name);
    if (s != null && (!hit || s < hit.score)) hit = { cand: c, name, score: s };
  }
  return hit;
}

export class Terminal {
  constructor(game) {
    this.game = game;
    this.el = $('terminal'); this.out = $('term-out'); this.input = $('term-input'); this.ghost = $('term-ghost');
    this.open = false;
    this.pending = null;   // {kind:'buy'|'route', ...} awaiting confirm
    this.store = [
      { key: 'flashlight', name: 'Flashlight', price: 15, tool: 'BBFlashlight', names: ['flashlight', 'pro-flashlight', 'light'] },
      { key: 'walkie', name: 'Walkie-talkie', price: 12, tool: 'WalkieTalkie', names: ['walkie-talkie', 'walkie', 'walkie talkie', 'radio'] },
    ];
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { const v = this.input.value; this.input.value = ''; this.updateGhost(); this.run(v); }
      else if (e.key === 'Escape') this.hide();
      else if (e.key === 'Tab' || (e.key === 'ArrowRight' && this.input.selectionStart === this.input.value.length)) { if (this.accept()) e.preventDefault(); }
    });
    this.input.addEventListener('input', () => this.updateGhost());
  }

  show() {
    this.open = true; this.el.classList.remove('hidden');
    document.exitPointerLock();
    this.game.player.keys = {};
    const c = this.game.items.sfx('enterTerminal'); if (c) this.game.sound.play(c, { vol: 0.5 });
    if (!this.booted) { this.booted = true; this.print(this.banner()); }
    setTimeout(() => this.input.focus(), 50);
  }

  hide() {
    this.open = false; this.el.classList.add('hidden');
    this.pending = null;
    const c = this.game.items.sfx('exitTerminal'); if (c) this.game.sound.play(c, { vol: 0.5 });
    this.game.player.lock();
  }

  banner() {
    return `Welcome to the FORTUNE-9 OS
                   Courtesy of the Company

Type "Help" for a list of commands.
Only the first letters of a word are needed (MO, STO, ROU EXP, or just EXP).
`;
  }

  print(t) { this.out.textContent += t + '\n'; this.out.scrollTop = this.out.scrollHeight; }
  clear() { this.out.textContent = ''; }

  // ---------- autocomplete ----------
  // the completion for what is typed so far: {text: full line, tail: the part not typed yet}
  suggestion() {
    const raw = this.input.value; const line = raw.toLowerCase();
    if (!line.trim() || line !== line.trimStart()) return null;
    const words = line.split(/\s+/);
    const complete = (typed, cands, addSpace) => {
      let hit = null;
      for (const c of cands) for (const name of c.names || [c]) if (name.startsWith(typed) && name !== typed && (!hit || name.length < hit.length)) hit = name;
      if (!hit) return null;
      const tail = hit.slice(typed.length) + (addSpace ? ' ' : '');
      return { text: raw + tail, tail };
    };
    if (this.pending) return complete(words[0], ['confirm', 'deny'], false);
    if (words.length === 1) {
      const w = words[0];
      // top level: commands, then moon names and store items (they work without ROUTE / BUY, like the real terminal)
      return complete(w, [...COMMANDS.map(c => [c]), ...MOONS.map(m => [m.names[0]]), ...this.store.map(s => [s.names[0]])].map(n => ({ names: n })), ['route', 'buy'].includes(w));
    }
    const cmd = best(words[0], COMMANDS.map(c => ({ names: [c] })));
    const arg = words.slice(1).join(' ');
    if (cmd && cmd.cand.names[0] === 'route') return complete(arg, MOONS.map(m => ({ names: [m.names[0], m.names[1]] })), false);
    if (cmd && cmd.cand.names[0] === 'buy') return complete(arg, this.store.map(s => ({ names: [s.names[0]] })), false);
    return null;
  }

  updateGhost() {
    if (!this.ghost) return;
    const s = this.suggestion();
    this.ghost.innerHTML = '';
    if (!s) return;
    const typed = document.createElement('span'); typed.className = 'typed'; typed.textContent = this.input.value;
    const tail = document.createElement('span'); tail.className = 'tail'; tail.textContent = s.tail;
    this.ghost.appendChild(typed); this.ghost.appendChild(tail);
  }

  accept() {
    const s = this.suggestion(); if (!s) return false;
    this.input.value = s.text; this.updateGhost(); return true;
  }

  // ---------- commands ----------
  run(line) {
    const g = this.game;
    const words = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const key = g.items.sfx('key'); if (key) g.sound.play(key, { vol: 0.35 });
    this.print('> ' + line);
    const first = words[0], rest = words.slice(1).join(' ');
    if (this.pending) {
      if ('confirm'.startsWith(first)) { const p = this.pending; this.pending = null; return p.kind === 'buy' ? this.doBuy(p) : this.doRoute(p.moon); }
      if ('deny'.startsWith(first)) { const wasRoute = this.pending.kind === 'route'; this.pending = null; return this.print(wasRoute ? 'Cancelled.\n' : 'Cancelled order.\n'); }
      this.pending = null;   // anything else abandons the prompt and runs as a new command
    }
    const cmdHit = best(first, COMMANDS.map(c => ({ names: [c] })));
    const moonHit = best(words.join(' '), MOONS);
    const itemHit = best(words.join(' '), this.store);
    // a bare moon or item name beats a weak command match ("exp" -> Experimentation, "fla" -> Flashlight, "com" -> Company)
    const cmdScore = cmdHit ? cmdHit.score : 9;
    if (moonHit && moonHit.score < cmdScore) return this.askRoute(moonHit.cand);
    if (itemHit && itemHit.score < cmdScore) return this.askBuy(itemHit.cand, 1);
    if (!cmdHit) return this.print(`[Unknown command. Type HELP]\n`);
    const cmd = cmdHit.cand.names[0];
    if (cmdHit.score >= 2) this.print(`(${cmd.toUpperCase()})`);   // show what a typo was corrected to
    switch (cmd) {
      case 'help': return this.print(`>MOONS
To see the list of moons the autopilot can route to.

>STORE
To see the store's selection of useful items.

>BUY [item]
To order an item from the store. It is delivered by dropship to the moon.

>SCAN
To scan for the number of items left on the current moon.

>QUOTA
Current profit quota and deadline.

>ROUTE [moon]
To route the autopilot to a moon or to the Company building (sell your scrap there).
You can also just type the moon's name.

>CLEAR   >EXIT

Only the first letters of a word are needed, e.g. "sto", "rou exp", "bu fla".
`);
      case 'moons': return this.print(`Welcome to the exomoons catalogue.
To route the autopilot to a moon, type its name (or ROUTE [name]).
____________________________

* The Company building   //   Buying at ${Math.round(g.world.buyingRate() * 100)}%${g.world.destination === 'company' ? '   (current route)' : ''}

* 41-Experimentation   ${this.weather()}${g.world.destination === 'moon' ? '   (current route)' : ''}
(other moons are not available in this demo)
`);
      case 'store': return this.print(`Welcome to the Company store.
Use words BUY to buy an item, or just type its name.
____________________________

${this.store.map(s => `* ${s.name}  //  Price: $${s.price}`).join('\n')}

Your credits: $${g.credits}
`);
      case 'buy': {
        const qty = Math.max(1, parseInt(words[words.length - 1]) || 1);
        const name = rest.replace(/\s*\d+$/, '');
        const hit = best(name, this.store);
        if (!hit) return this.print(name ? `[Item not found in this demo's store. Try STORE]\n` : 'Buy what? Type STORE to see the items.\n');
        return this.askBuy(hit.cand, qty);
      }
      case 'route': {
        const hit = best(rest, MOONS);
        if (!rest) return this.print('Route where? Type MOONS to see the list.\n');
        if (!hit) return this.print('Only 41-Experimentation and the Company building are available in this demo.\n');
        return this.askRoute(hit.cand);
      }
      case 'scan': {
        if (!g.dungeon.placed.length) return this.print('There are no scrap objects to scan while in orbit.\n');
        const left = g.items.world.filter(it => it.area === 'inside' && it.value);
        return this.print(`There are ${left.length} objects outside the ship, totalling at an approximate value of $${left.reduce((a, i) => a + i.value, 0)}.\n`);
      }
      case 'quota': return this.print(`Profit quota: $${g.quotaFulfilled} / $${g.quota}\nScrap on ship: $${g.items.scrapValueOnShip()}\nDays until deadline: ${g.daysLeft}\nCompany buying rate: ${Math.round(g.world.buyingRate() * 100)}%\nCredits: $${g.credits}\n`);
      case 'clear': return this.clear();
      case 'exit': return this.hide();
      case 'view': return this.print('The ship monitor is not available in this build.\n');
      case 'confirm': case 'deny': return this.print('There is nothing to confirm.\n');
    }
    this.print(`[Unknown command. Type HELP]\n`);
  }

  askBuy(s, qty) {
    const g = this.game;
    const total = s.price * qty;
    if (total > g.credits) return this.print(`You could not afford this item! Your balance is $${g.credits}. Total cost of item: $${total}.\n`);
    this.pending = { kind: 'buy', item: s, qty, total };
    this.print(`You have requested to order ${qty} ${s.name}${qty > 1 ? 's' : ''}. Amount: $${total}.
Please CONFIRM or DENY.
`);
  }

  doBuy(p) {
    const g = this.game;
    g.credits -= p.total;
    const c = g.items.sfx('purchase'); if (c) g.sound.play(c, { vol: 0.6 });
    for (let i = 0; i < p.qty; i++) g.items.queueDelivery(p.item.tool, p.item.name);
    const where = g.world.inOrbit ? 'It will be delivered next to the ship shortly after you land.' : 'The dropship is on its way.';
    this.print(`Ordered ${p.qty} ${p.item.name}${p.qty > 1 ? 's' : ''}. Your new balance is $${g.credits}.\n${where}\n`);
  }

  askRoute(moon) {
    const g = this.game;
    if (!g.world.inOrbit) return this.print('You can only route the autopilot while in orbit.\n');
    if (g.world.destination === moon.key) return this.print(`The autopilot is already routed to ${moon.label}.\nPull the lever to land.\n`);
    this.pending = { kind: 'route', moon };
    if (moon.key === 'company') this.print(`The cost to route to ${moon.label} is $0. The Company is buying at ${Math.round(g.world.buyingRate() * 100)}%.\nPlease CONFIRM or DENY.\n`);
    else this.print(`The cost to route to ${moon.label} is $0. It is currently ${this.weather().replace(/[()]/g, '')}.\nPlease CONFIRM or DENY.\n`);
  }

  doRoute(moon) {
    const g = this.game;
    if (!g.world.inOrbit) return this.print('You can only route the autopilot while in orbit.\n');
    g.world.destination = moon.key;
    this.print(`The autopilot is now routed to ${moon.label}.\nPull the lever to land.\n`);
  }

  weather() { const f = this.game.world.dayFrac; return f > 0.72 ? '(Night)' : '(Foggy)'; }
}
