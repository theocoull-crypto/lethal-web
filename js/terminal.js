// The ship terminal: a text console with the commands the demo supports (help, store, buy, moons, route, scan, quota, exit).
const $ = id => document.getElementById(id);

export class Terminal {
  constructor(game) {
    this.game = game;
    this.el = $('terminal'); this.out = $('term-out'); this.input = $('term-input');
    this.open = false;
    this.pending = null;   // {kind:'buy', item, qty} awaiting confirm
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { const v = this.input.value; this.input.value = ''; this.run(v); }
      if (e.key === 'Escape') this.hide();
    });
    this.store = [
      { key: 'flashlight', name: 'Flashlight', price: 15, tool: 'BBFlashlight' },
      { key: 'walkie', name: 'Walkie-talkie', price: 12, tool: 'WalkieTalkie' },
    ];
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
`;
  }

  print(t) { this.out.textContent += t + '\n'; this.out.scrollTop = this.out.scrollHeight; }
  clear() { this.out.textContent = ''; }

  run(line) {
    const g = this.game;
    const words = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const key = g.items.sfx('key'); if (key) g.sound.play(key, { vol: 0.35 });
    this.print('> ' + line);
    const cmd = words[0];
    if (this.pending) {
      if ('confirm'.startsWith(cmd) && cmd.length >= 1) { this.doBuy(this.pending); this.pending = null; return; }
      if ('deny'.startsWith(cmd)) { this.pending = null; this.print('Cancelled order.\n'); return; }
    }
    if ('help'.startsWith(cmd)) return this.print(`>MOONS
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

>CLEAR   >EXIT
`);
    if ('moons'.startsWith(cmd)) return this.print(`Welcome to the exomoons catalogue.
To route the autopilot to a moon, use the word ROUTE.
____________________________

* The Company building   //   Buying at ${Math.round(g.world.buyingRate() * 100)}%

* 41-Experimentation   ${this.weather()}${g.world.destination === 'moon' ? '   (current route)' : ''}
(other moons are not available in this demo)
`);
    if ('store'.startsWith(cmd)) return this.print(`Welcome to the Company store.
Use words BUY to buy an item.
____________________________

${this.store.map(s => `* ${s.name}  //  Price: $${s.price}`).join('\n')}

Your credits: $${g.credits}
`);
    if ('buy'.startsWith(cmd)) {
      const name = words.slice(1).join(' ');
      const s = this.store.find(x => name && (x.key.startsWith(name) || x.name.toLowerCase().startsWith(name)));
      if (!s) return this.print(`[Item not found in this demo's store. Try STORE]\n`);
      const qty = Math.max(1, parseInt(words[words.length - 1]) || 1);
      const total = s.price * qty;
      if (total > g.credits) return this.print(`You could not afford this item! Your balance is $${g.credits}. Total cost of item: $${total}.\n`);
      this.pending = { kind: 'buy', item: s, qty, total };
      return this.print(`You have requested to order ${qty} ${s.name}${qty > 1 ? 's' : ''}. Amount: $${total}.
Please CONFIRM or DENY.
`);
    }
    if ('scan'.startsWith(cmd)) {
      if (!g.dungeon.placed.length) return this.print('There are no scrap objects to scan while in orbit.\n');
      const left = g.items.world.filter(it => it.area === 'inside' && it.value);
      return this.print(`There are ${left.length} objects outside the ship, totalling at an approximate value of $${left.reduce((a, i) => a + i.value, 0)}.\n`);
    }
    if ('quota'.startsWith(cmd)) return this.print(`Profit quota: $${g.quotaFulfilled} / $${g.quota}\nScrap on ship: $${g.items.scrapValueOnShip()}\nDays until deadline: ${g.daysLeft}\nCompany buying rate: ${Math.round(g.world.buyingRate() * 100)}%\nCredits: $${g.credits}\n`);
    if ('route'.startsWith(cmd)) {
      const to = words.slice(1).join(' ');
      if (!g.world.inOrbit) return this.print('You can only route the autopilot while in orbit.\n');
      if (to.startsWith('exp') || to === '41') { g.world.destination = 'moon'; return this.print('The autopilot is now routed to 41-Experimentation.\nPull the lever to land.\n'); }
      if (to.startsWith('comp') || to.startsWith('the comp')) { g.world.destination = 'company'; return this.print(`The autopilot is now routed to the Company building.\nThe Company is buying at ${Math.round(g.world.buyingRate() * 100)}%.\nPull the lever to land.\n`); }
      return this.print('Only 41-Experimentation and the Company building are available in this demo.\n');
    }
    if ('clear'.startsWith(cmd)) { this.clear(); return; }
    if ('exit'.startsWith(cmd) || cmd === 'quit') { this.hide(); return; }
    if ('view'.startsWith(cmd)) return this.print('The ship monitor is not available in this build.\n');
    this.print(`[Unknown command. Type HELP]\n`);
  }

  doBuy(p) {
    const g = this.game;
    g.credits -= p.total;
    const c = g.items.sfx('purchase'); if (c) g.sound.play(c, { vol: 0.6 });
    for (let i = 0; i < p.qty; i++) g.items.queueDelivery(p.item.tool, p.item.name);
    const where = g.world.inOrbit ? 'It will be delivered next to the ship shortly after you land.' : 'The dropship is on its way.';
    this.print(`Ordered ${p.qty} ${p.item.name}${p.qty > 1 ? 's' : ''}. Your new balance is $${g.credits}.\n${where}\n`);
  }

  weather() { const f = this.game.world.dayFrac; return f > 0.72 ? '(Night)' : '(Foggy)'; }
}
