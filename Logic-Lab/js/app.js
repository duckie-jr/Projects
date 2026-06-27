/**
 * Application glue: wires the DOM toolbar and canvas pointer interactions to the
 * simulation engine and renderer, and drives the per-frame simulation loop.
 *
 * Interaction summary:
 *  - Click a toolbar button to drop a component into the middle of the view.
 *  - Drag a component body to move it.
 *  - Drag from any pin to another pin (output -> input) to lay a wire.
 *  - Click a Switch to toggle it; hold a Button for a momentary pulse.
 *  - Double-click a Delay to change its tick length.
 *  - Select a component or wire and press Delete/Backspace to remove it.
 *  - Drag the empty background to pan; scroll to zoom.
 */
import { Circuit, COMPONENT_SPECS } from "./simulation.js";
import {
  render,
  getPinPosition,
  findComponentAt,
  findPinAt,
  findWireAt,
} from "./renderer.js";

const DRAG_THRESHOLD_PX = 4;
const STORAGE_KEY = "logic-sim-circuit";

/** Upper bound on a Delay's tick length so huge buffers can't lag the app. */
const MAX_DELAY_TICKS = 1000;

const circuit = new Circuit();

const view = { offsetX: 0, offsetY: 0, scale: 1 };

const interaction = {
  selectedComponent: null,
  hoveredWire: null,
  pendingWire: null,
  draggingComponent: null,
  dragOffset: { x: 0, y: 0 },
  isPanning: false,
  panStart: { x: 0, y: 0 },
  pointerMoved: false,
  pressedButton: null,
};

const simulation = { running: true, ticksPerFrame: 6, lastFrameMs: 0 };

let canvas;
let context;

/** Tracks which component the inspector panel is currently showing. */
let inspectedComponent = null;

export function initApp() {
  canvas = document.getElementById("circuit-canvas");
  context = canvas.getContext("2d");

  buildToolbar();
  buildExampleMenu();
  bindControlButtons();
  bindImportControls();
  bindInspector();
  bindCanvasEvents();
  bindKeyboard();

  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  loadFromStorage();
  importFromShareLink();

  requestAnimationFrame(frameLoop);
}

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
}

/* ------------------------------------------------------------------ */
/* Toolbar / controls                                                  */
/* ------------------------------------------------------------------ */

function buildToolbar() {
  const toolbar = document.getElementById("toolbar");
  const categoryLabels = {
    input: "Inputs",
    gate: "Gates",
    timing: "Timing",
    output: "Outputs",
  };

  const groups = new Map();
  for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
    if (!groups.has(spec.category)) groups.set(spec.category, []);
    groups.get(spec.category).push({ type, spec });
  }

  for (const [category, items] of groups) {
    const group = document.createElement("div");
    group.className = "toolbar-group";

    const heading = document.createElement("div");
    heading.className = "toolbar-heading";
    heading.textContent = categoryLabels[category] || category;
    group.appendChild(heading);

    for (const { type, spec } of items) {
      const button = document.createElement("button");
      button.className = `tool-button tool-${category}`;
      button.textContent = spec.name;
      button.addEventListener("click", () => addComponentToViewCenter(type));
      group.appendChild(button);
    }

    toolbar.appendChild(group);
  }
}

function buildExampleMenu() {
  const select = document.getElementById("example-select");
  for (const example of EXAMPLE_CIRCUITS) {
    const option = document.createElement("option");
    option.value = example.id;
    option.textContent = example.name;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    const example = EXAMPLE_CIRCUITS.find((item) => item.id === select.value);
    if (example) {
      circuit.loadJSON(example.build());
      interaction.selectedComponent = null;
      resetView();
    }
    select.value = "";
  });
}

function bindControlButtons() {
  document
    .getElementById("btn-play")
    .addEventListener("click", toggleSimulation);
  document.getElementById("btn-clear").addEventListener("click", clearCircuit);
  document.getElementById("btn-save").addEventListener("click", saveToStorage);
  document.getElementById("btn-load").addEventListener("click", loadFromStorage);
  document.getElementById("btn-export").addEventListener("click", exportCircuit);
  document.getElementById("btn-reset-view").addEventListener("click", resetView);

  const speedInput = document.getElementById("speed-input");
  speedInput.addEventListener("input", () => {
    simulation.ticksPerFrame = Number(speedInput.value);
    document.getElementById("speed-value").textContent =
      simulation.ticksPerFrame;
  });
}

function toggleSimulation() {
  simulation.running = !simulation.running;
  document.getElementById("btn-play").textContent = simulation.running
    ? "⏸ Pause"
    : "▶ Run";
}

function clearCircuit() {
  if (!confirm("Clear the whole circuit?")) return;
  circuit.components.clear();
  circuit.wires = [];
  interaction.selectedComponent = null;
}

function resetView() {
  view.offsetX = 0;
  view.offsetY = 0;
  view.scale = 1;
}

/* ------------------------------------------------------------------ */
/* Placement helpers                                                   */
/* ------------------------------------------------------------------ */

function addComponentToViewCenter(type) {
  const center = screenToWorld(canvas.width / 2, canvas.height / 2);
  const component = circuit.addComponent(type, center.x - 40, center.y - 25);
  interaction.selectedComponent = component;
}

function screenToWorld(screenX, screenY) {
  return {
    x: (screenX - view.offsetX) / view.scale,
    y: (screenY - view.offsetY) / view.scale,
  };
}

function pointerToWorld(event) {
  const rect = canvas.getBoundingClientRect();
  return screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
}

/* ------------------------------------------------------------------ */
/* Pointer interaction                                                 */
/* ------------------------------------------------------------------ */

function bindCanvasEvents() {
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
}

function onPointerDown(event) {
  canvas.setPointerCapture(event.pointerId);
  interaction.pointerMoved = false;
  const world = pointerToWorld(event);

  const pin = findPinAt(circuit, world.x, world.y);
  if (pin) {
    const pinPosition = getPinPosition(pin.component, pin.kind, pin.index);
    interaction.pendingWire = {
      fromPin: pin,
      start: pinPosition,
      end: { x: world.x, y: world.y },
    };
    return;
  }

  const component = findComponentAt(circuit, world.x, world.y);
  if (component) {
    interaction.selectedComponent = component;

    if (component.type === "BUTTON") {
      component.state.pressed = true;
      interaction.pressedButton = component;
    }

    interaction.draggingComponent = component;
    interaction.dragOffset = {
      x: world.x - component.x,
      y: world.y - component.y,
    };
    return;
  }

  const wire = findWireAt(circuit, world.x, world.y);
  if (wire) {
    interaction.hoveredWire = wire;
    interaction.selectedComponent = null;
    return;
  }

  interaction.selectedComponent = null;
  interaction.hoveredWire = null;
  interaction.isPanning = true;
  interaction.panStart = {
    x: event.clientX - view.offsetX,
    y: event.clientY - view.offsetY,
  };
}

function onPointerMove(event) {
  const world = pointerToWorld(event);

  if (
    Math.abs(event.movementX) > DRAG_THRESHOLD_PX ||
    Math.abs(event.movementY) > DRAG_THRESHOLD_PX
  ) {
    interaction.pointerMoved = true;
  }

  if (interaction.pendingWire) {
    interaction.pendingWire.end = { x: world.x, y: world.y };
    return;
  }

  if (interaction.draggingComponent) {
    interaction.pointerMoved = true;
    interaction.draggingComponent.x = world.x - interaction.dragOffset.x;
    interaction.draggingComponent.y = world.y - interaction.dragOffset.y;
    return;
  }

  if (interaction.isPanning) {
    view.offsetX = event.clientX - interaction.panStart.x;
    view.offsetY = event.clientY - interaction.panStart.y;
    return;
  }

  interaction.hoveredWire = findWireAt(circuit, world.x, world.y);
}

function onPointerUp(event) {
  const world = pointerToWorld(event);

  if (interaction.pendingWire) {
    completePendingWire(world);
    interaction.pendingWire = null;
  }

  if (
    interaction.draggingComponent &&
    !interaction.pointerMoved &&
    interaction.draggingComponent.type === "SWITCH"
  ) {
    const switchComponent = interaction.draggingComponent;
    switchComponent.state.on = !switchComponent.state.on;
  }

  if (interaction.pressedButton) {
    interaction.pressedButton.state.pressed = false;
    interaction.pressedButton = null;
  }

  interaction.draggingComponent = null;
  interaction.isPanning = false;
}

function completePendingWire(world) {
  const releasePin = findPinAt(circuit, world.x, world.y);
  if (!releasePin) return;

  const fromPin = interaction.pendingWire.fromPin;
  let outputPin = null;
  let inputPin = null;

  if (fromPin.kind === "output" && releasePin.kind === "input") {
    outputPin = fromPin;
    inputPin = releasePin;
  } else if (fromPin.kind === "input" && releasePin.kind === "output") {
    outputPin = releasePin;
    inputPin = fromPin;
  } else {
    return;
  }

  circuit.connect(
    outputPin.component.id,
    outputPin.index,
    inputPin.component.id,
    inputPin.index
  );
}

function onDoubleClick(event) {
  const world = pointerToWorld(event);
  const component = findComponentAt(circuit, world.x, world.y);
  if (!component) return;

  interaction.selectedComponent = component;

  if (component.type === "DELAY") {
    syncInspector();
    const ticksInput = document.getElementById("delay-ticks");
    ticksInput.focus();
    ticksInput.select();
  }
}

function onWheel(event) {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;

  const worldBefore = screenToWorld(pointerX, pointerY);
  const zoomFactor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
  view.scale = Math.min(3, Math.max(0.3, view.scale * zoomFactor));

  view.offsetX = pointerX - worldBefore.x * view.scale;
  view.offsetY = pointerY - worldBefore.y * view.scale;
}

function bindKeyboard() {
  window.addEventListener("keydown", (event) => {
    const isDelete = event.key === "Delete" || event.key === "Backspace";
    if (!isDelete) return;

    const activeTag = document.activeElement?.tagName;
    if (activeTag === "INPUT" || activeTag === "SELECT") return;

    if (interaction.selectedComponent) {
      circuit.removeComponent(interaction.selectedComponent.id);
      interaction.selectedComponent = null;
      event.preventDefault();
    } else if (interaction.hoveredWire) {
      circuit.removeWire(interaction.hoveredWire);
      interaction.hoveredWire = null;
      event.preventDefault();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function saveToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(circuit.toJSON()));
  flashStatus("Saved");
}

function loadFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    circuit.loadJSON(JSON.parse(raw));
    interaction.selectedComponent = null;
    flashStatus("Loaded");
  } catch (error) {
    console.error("Failed to load saved circuit", error);
  }
}

function flashStatus(message) {
  const status = document.getElementById("status");
  if (!status) return;
  status.textContent = message;
  status.classList.add("status-visible");
  setTimeout(() => status.classList.remove("status-visible"), 1200);
}

/* ------------------------------------------------------------------ */
/* Import / export (shareable .json circuits)                          */
/* ------------------------------------------------------------------ */

function bindImportControls() {
  const importButton = document.getElementById("btn-import");
  const urlInput = document.getElementById("import-url");

  importButton.addEventListener("click", () => importFromUrl(urlInput.value));
  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") importFromUrl(urlInput.value);
  });
}

/** Auto-import a circuit when the page is opened with `?load=<url>`. */
function importFromShareLink() {
  const sharedUrl = new URLSearchParams(window.location.search).get("load");
  if (sharedUrl) importFromUrl(sharedUrl);
}

/**
 * Fetch a circuit `.json` file from a URL and load it. Plain GitHub file pages
 * (the `/blob/` URLs you get from the browser address bar) are converted to
 * their `raw.githubusercontent.com` equivalent automatically.
 */
async function importFromUrl(rawUrl) {
  const url = normalizeCircuitUrl((rawUrl || "").trim());
  if (!url) {
    flashStatus("Enter a .json URL");
    return;
  }

  flashStatus("Importing…");
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const data = await response.json();
    if (!isValidCircuitData(data)) {
      throw new Error("File is not a valid circuit");
    }

    circuit.loadJSON(data);
    interaction.selectedComponent = null;
    resetView();
    flashStatus("Imported");
  } catch (error) {
    console.error("Import failed", error);
    flashStatus("Import failed");
  }
}

/** Turn common GitHub "blob" links into their raw download equivalent. */
function normalizeCircuitUrl(url) {
  if (!url) return "";

  let normalized = url;
  if (normalized.startsWith("github.com")) {
    normalized = `https://${normalized}`;
  }

  const blobMatch = normalized.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/
  );
  if (blobMatch) {
    const [, owner, repository, pathAfterBlob] = blobMatch;
    return `https://raw.githubusercontent.com/${owner}/${repository}/${pathAfterBlob}`;
  }

  return normalized;
}

/** Minimal shape check so we fail clearly on non-circuit JSON. */
function isValidCircuitData(data) {
  return (
    data !== null &&
    typeof data === "object" &&
    Array.isArray(data.components) &&
    Array.isArray(data.wires)
  );
}

/* ------------------------------------------------------------------ */
/* Inspector (edit the selected component's properties)                */
/* ------------------------------------------------------------------ */

function bindInspector() {
  const ticksInput = document.getElementById("delay-ticks");

  ticksInput.addEventListener("input", () => {
    const component = interaction.selectedComponent;
    if (!component || component.type !== "DELAY") return;

    const requestedTicks = Math.floor(Number(ticksInput.value));
    if (!Number.isFinite(requestedTicks) || requestedTicks <= 0) return;

    const ticks = Math.min(MAX_DELAY_TICKS, requestedTicks);
    component.state.ticks = ticks;
    component.state.buffer = [];
  });
}

/**
 * Show the inspector for the selected component and keep its fields in sync.
 * Called every frame, but the input is only rewritten when the selection
 * actually changes so it never fights with the user while they're typing.
 */
function syncInspector() {
  const component = interaction.selectedComponent;
  if (component === inspectedComponent) return;
  inspectedComponent = component;

  const inspector = document.getElementById("inspector");
  if (component && component.type === "DELAY") {
    inspector.hidden = false;
    document.getElementById("delay-ticks").value = component.state.ticks;
  } else {
    inspector.hidden = true;
  }
}

/** Download the current circuit as a `.json` file ready to host and share. */
function exportCircuit() {
  const json = JSON.stringify(circuit.toJSON(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const downloadUrl = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = "circuit.json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(downloadUrl);
  flashStatus("Exported circuit.json");
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

function frameLoop(timestampMs) {
  const deltaMs = simulation.lastFrameMs
    ? timestampMs - simulation.lastFrameMs
    : 16;
  simulation.lastFrameMs = timestampMs;

  if (simulation.running) {
    runSimulationSteps(deltaMs);
  }

  syncInspector();
  render(context, circuit, view, interaction);
  requestAnimationFrame(frameLoop);
}

/**
 * Run several logic ticks per displayed frame so combinational signals settle
 * quickly. Only the first sub-tick advances wall-clock time, keeping clock
 * components accurate regardless of how many propagation ticks we run.
 */
function runSimulationSteps(deltaMs) {
  const steps = Math.max(1, simulation.ticksPerFrame);
  for (let step = 0; step < steps; step++) {
    circuit.tick(step === 0 ? deltaMs : 0);
  }
}

/* ------------------------------------------------------------------ */
/* Built-in example circuits                                           */
/* ------------------------------------------------------------------ */

/**
 * Small declarative builder so examples stay readable. A blueprint lists named
 * nodes (with type / position / optional state) and links between them written
 * as [fromName, fromPin, toName, toPin]. It returns the same JSON shape that
 * `Circuit.loadJSON` consumes.
 */
function buildBlueprint(nodes, links) {
  const nameToId = new Map();
  const components = [];
  let id = 1;

  for (const node of nodes) {
    nameToId.set(node.name, id);
    components.push({
      id,
      type: node.type,
      x: node.x,
      y: node.y,
      state: node.state || {},
    });
    id += 1;
  }

  const wires = links.map(([fromName, fromPin, toName, toPin]) => ({
    fromComponentId: nameToId.get(fromName),
    fromPin,
    toComponentId: nameToId.get(toName),
    toPin,
  }));

  return { components, wires };
}

const EXAMPLE_CIRCUITS = [
  {
    id: "half-adder",
    name: "Half adder (A+B)",
    build: () =>
      buildBlueprint(
        [
          { name: "A", type: "SWITCH", x: 80, y: 120 },
          { name: "B", type: "SWITCH", x: 80, y: 220 },
          { name: "sumGate", type: "XOR", x: 280, y: 120 },
          { name: "carryGate", type: "AND", x: 280, y: 230 },
          { name: "sumLed", type: "LED", x: 460, y: 130 },
          { name: "carryLed", type: "LED", x: 460, y: 240 },
        ],
        [
          ["A", 0, "sumGate", 0],
          ["B", 0, "sumGate", 1],
          ["A", 0, "carryGate", 0],
          ["B", 0, "carryGate", 1],
          ["sumGate", 0, "sumLed", 0],
          ["carryGate", 0, "carryLed", 0],
        ]
      ),
  },
  {
    id: "sr-latch",
    name: "SR latch (1-bit memory)",
    build: () =>
      buildBlueprint(
        [
          { name: "set", type: "BUTTON", x: 80, y: 110 },
          { name: "reset", type: "BUTTON", x: 80, y: 260 },
          { name: "norTop", type: "NOR", x: 290, y: 130 },
          { name: "norBottom", type: "NOR", x: 290, y: 240 },
          { name: "qLed", type: "LED", x: 470, y: 140 },
          { name: "qBarLed", type: "LED", x: 470, y: 250 },
        ],
        [
          ["reset", 0, "norTop", 0],
          ["norBottom", 0, "norTop", 1],
          ["norTop", 0, "norBottom", 0],
          ["set", 0, "norBottom", 1],
          ["norTop", 0, "qLed", 0],
          ["norBottom", 0, "qBarLed", 0],
        ]
      ),
  },
  {
    id: "delay-clock",
    name: "Clock from a Delay loop",
    build: () =>
      buildBlueprint(
        [
          { name: "inverter", type: "NOT", x: 260, y: 150 },
          { name: "loopDelay", type: "DELAY", x: 260, y: 280, state: { ticks: 30 } },
          { name: "tickLed", type: "LED", x: 470, y: 160 },
        ],
        [
          ["inverter", 0, "tickLed", 0],
          ["inverter", 0, "loopDelay", 0],
          ["loopDelay", 0, "inverter", 0],
        ]
      ),
  },
];

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
