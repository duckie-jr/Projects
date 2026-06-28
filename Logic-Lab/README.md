# Logic Lab — Digital Circuit Sandbox

Build and learn digital logic from the ground up: drop down gates, wire them
together, flip switches, and watch signals light up in real time. With feedback
loops you can build memory (latches/flip-flops), counters, clocks and — given
enough patience — a whole computer.

## Features

- **Gates:** AND, OR, XOR, NOT, NAND, NOR, XNOR
- **Inputs:** Switch (toggle), Button (momentary), HIGH (constant 1)
- **Timing:** Delay (configurable tick delay) — build your own clocks/oscillators with it
- **Output:** LED indicator
- **Real simulation:** tick-based engine with 1-tick gate propagation, so
  cross-coupled gates form genuine memory.
- **Quality of life:** pan/zoom, auto fit-to-view when loading examples,
  save/load to your browser, speed control, and built-in examples (half adder,
  full adder, 4/8/32-bit ripple-carry adders, D flip-flop, 4-bit register,
  4/8-bit accumulator "computer", SR latch, delay-loop clock).

## Building a computer

The examples build up from gates to a working machine:

- **D flip-flop** — a 1-bit memory cell (master-slave, NAND-based). Set `D`, tap
  `Clock`, and the bit is stored in `Q`.
- **Register** — a bank of D flip-flops sharing one clock that latch a whole
  word at once.
- **Accumulator "computer"** — the heart of a CPU as a self-running datapath: a
  free-running clock (a `NOT` looped through a `Delay`) drives a register whose
  value is fed back through the ripple-carry adder (the ALU). Every clock tick
  it loads `register + addend`, so it counts and accumulates on its own.
  - It powers up with **RESET** asserted (register held at 0). Flip `RESET`
    **off** to let it run.
  - Change the **Addend** switches to step by any value (defaults to +1).
  - Use the speed slider to make it run faster or slower.

### Play a game: "Stop the Counter"

The **🎮 Computer game: Stop the Counter** example (also saved as
`imports/computer-game.json`) turns the datapath into an arcade reflex game. A
free-running counter races across a row of glowing DISPLAY lamps; a comparator
lights **MATCH** when the display equals your **TARGET**, and **WIN** lights only
if you freeze the counter exactly on it.

- Press **Run**, then flip **RESET** off to start the count.
- Set the **TARGET** switches to the number you're hunting for.
- Flip **STOP** the instant the display shows your target — land it and **WIN**
  lights up.
- Make it harder/easier with the speed slider (or by editing the clock Delay).

### Play a game: "Flappy LED"

The **🐤 Flappy LED: dodge the gaps** example (also saved as
`imports/Flappy-Bird.json`) is a real reflex game built entirely from gates,
delays and lamps — no special game code. Two `NOT → Delay` ring oscillators make
a *pipe* bit and a *gap-side* bit that ripple **left** through a chain of
`Delay` stages, so a wall of pipes visibly scrolls toward the **BIRD** on the
left. Each column lights a top/bottom lamp for the pipe's solid half; the dark
cell is the gap to fly through.

- Press **Run**, then flip **RESET** off to play.
- The **BIRD** is one bit: flip **FLAP** on to sit in the top cell, off for the
  bottom cell.
- Line the bird up with each gap before the pipe reaches it. Get caught in a
  solid cell and a `NAND` latch lights **GAME OVER** and freezes your run.
- Flip **RESET** to revive and try again; use the speed slider to change pace.

The whole thing is generated and *verified against the real engine* by
`scripts/generate-flappy.mjs` (run `node scripts/generate-flappy.mjs`), which
also writes the shareable `imports/Flappy-Bird.json`.

## How to use

- Click a part in the left toolbar to drop it on the board.
- Drag a part to move it.
- Drag from one pin to another (output → input) to lay a wire.
- Click a **Switch** to flip it between 0 and 1.
- Hold a **Button** for a momentary pulse.
- Double-click a **Delay** to change its tick length.
- Make your own clock by looping a **NOT** gate back through a **Delay**.
- Select a part or hover a wire and press <kbd>Delete</kbd> to remove it.
- Scroll to zoom; drag the empty background to pan.

## Project layout

Everything is plain HTML/CSS/JS, split into three focused modules:

- `js/simulation.js` — the logic engine (components, wires, tick evaluation).
- `js/renderer.js` — canvas drawing plus shared geometry / hit-testing helpers.
- `js/app.js` — UI glue: toolbar, pointer interactions, save/load, examples, loop.
- `index.html` / `style.css` — the page shell and styling.

## Sharing circuits via a link

Circuits are saved as **`.json`** (data only — never `.js`, so there's no risk
of running code from someone else's repo).

- **Export**: click **Export .json** to download `circuit.json`.
- **Host it**: commit that file to a GitHub repo (or a Gist).
- **Import**: paste the link into the **Import from URL** box and hit
  **Import circuit**. Normal GitHub `…/blob/…` links are auto-converted to their
  raw form, so you can paste the address-bar URL directly.
- **Deep link**: open the app with `?load=<raw-json-url>` to load a circuit
  automatically on page open.

The loader expects the same shape as the exporter: an object with
`components` and `wires` arrays.

## Deploying to GitHub Pages

No build step is required — the app uses native ES modules with **relative**
paths, so you can serve the repository root directly.

1. Push the repo to GitHub.
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder
   `/ (root)`.
3. Open `https://<user>.github.io/<repo>/`.

Because everything is linked relatively (`./style.css`, `./js/app.js`, …) it
works whether the site is hosted at a domain root or under a `/<repo>/` subpath.
Do **not** deploy the `dist/` folder for this — just the source files at the
root.

## Run it

```bash
npm install
npm run dev      # start the dev server
npm run build    # production build into dist/
