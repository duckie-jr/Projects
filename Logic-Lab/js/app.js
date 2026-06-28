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
  getComponentSize,
  findComponentAt,
  findPinAt,
  findWireAt,
} from "./renderer.js";

const DRAG_THRESHOLD_PX = 4;
const STORAGE_KEY = "logic-sim-circuit";

/** Upper bound on a Delay's tick length so huge buffers can't lag the app. */
const MAX_DELAY_TICKS = 1000;

/**
 * Zoom limits. The minimum is intentionally low so very tall circuits such as
 * the 32-bit ripple-carry adder can be fully framed and navigated.
 */
const MIN_ZOOM = 0.04;
const MAX_ZOOM = 3;

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
  pressedSwitch: null,
};

const simulation = { running: true, ticksPerFrame: 6, lastFrameMs: 0 };

/**
 * Interaction mode. "edit" allows placing, dragging, wiring and deleting parts;
 * "view" locks the layout so you can only toggle switches and press buttons
 * without accidentally moving or rewiring anything.
 */
const EDIT_MODE = "edit";
const VIEW_MODE = "view";
let interactionMode = EDIT_MODE;

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
    annotation: "Labels",
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
      fitViewToCircuit();
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
  document.getElementById("btn-mode").addEventListener("click", toggleMode);

  const speedInput = document.getElementById("speed-input");
  speedInput.addEventListener("input", () => {
    simulation.ticksPerFrame = Number(speedInput.value);
    document.getElementById("speed-value").textContent =
      simulation.ticksPerFrame;
  });

  setMode(interactionMode);
}

function toggleMode() {
  setMode(interactionMode === EDIT_MODE ? VIEW_MODE : EDIT_MODE);
}

/**
 * Switch between Edit and View modes. Clears any in-progress interaction so a
 * half-finished drag or wire never carries across a mode change, updates the
 * toggle button label, and tags the document so the CSS can lock the toolbar.
 */
function setMode(nextMode) {
  interactionMode = nextMode;

  interaction.selectedComponent = null;
  interaction.hoveredWire = null;
  interaction.pendingWire = null;
  interaction.draggingComponent = null;
  interaction.pressedSwitch = null;
  interaction.isPanning = false;

  const isViewMode = interactionMode === VIEW_MODE;
  document.body.classList.toggle("view-mode", isViewMode);

  const modeButton = document.getElementById("btn-mode");
  modeButton.textContent = isViewMode ? "✎ Edit mode" : "👆 View mode";
  modeButton.title = isViewMode
    ? "Switch to Edit mode to add, move, wire and delete parts"
    : "Switch to View mode to flip switches without moving parts";

  flashStatus(isViewMode ? "View mode" : "Edit mode");
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

/**
 * Zoom and pan so the entire current circuit fits inside the canvas, centred.
 * Used when loading an example so large circuits (e.g. the 32-bit adder) are
 * fully visible instead of dumping the user at the top-left corner.
 */
function fitViewToCircuit() {
  const components = [...circuit.components.values()];
  if (components.length === 0) {
    resetView();
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const component of components) {
    const { width, height } = getComponentSize(component);
    minX = Math.min(minX, component.x);
    minY = Math.min(minY, component.y);
    maxX = Math.max(maxX, component.x + width);
    maxY = Math.max(maxY, component.y + height);
  }

  const padding = 80;
  const contentWidth = maxX - minX + padding * 2;
  const contentHeight = maxY - minY + padding * 2;

  const scaleToFit = Math.min(
    canvas.width / contentWidth,
    canvas.height / contentHeight
  );
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scaleToFit));

  view.scale = scale;
  view.offsetX = (canvas.width - (minX + maxX) * scale) / 2;
  view.offsetY = (canvas.height - (minY + maxY) * scale) / 2;
}

/* ------------------------------------------------------------------ */
/* Placement helpers                                                   */
/* ------------------------------------------------------------------ */

function addComponentToViewCenter(type) {
  if (interactionMode !== EDIT_MODE) return;

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

  if (interactionMode === VIEW_MODE) {
    onViewModePointerDown(event, world);
    return;
  }

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

/**
 * Pointer handling for View mode: only switches and buttons respond, and the
 * empty background still pans. Components can never be moved, wired or deleted,
 * so you can click freely without disturbing the layout.
 */
function onViewModePointerDown(event, world) {
  const component = findComponentAt(circuit, world.x, world.y);
  if (component) {
    if (component.type === "BUTTON") {
      component.state.pressed = true;
      interaction.pressedButton = component;
    } else if (component.type === "SWITCH") {
      interaction.pressedSwitch = component;
    }
    return;
  }

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

  if (interaction.pressedSwitch) {
    if (!interaction.pointerMoved) {
      interaction.pressedSwitch.state.on = !interaction.pressedSwitch.state.on;
    }
    interaction.pressedSwitch = null;
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

  if (component.type === "TEXT") {
    editTextLabel(component);
    return;
  }

  if (component.type === "DELAY") {
    syncInspector();
    const ticksInput = document.getElementById("delay-ticks");
    ticksInput.focus();
    ticksInput.select();
  }
}

/**
 * Edit a Text label's caption. Uses a simple prompt so it works the same in
 * Edit and View mode (and never interferes with wiring), then the new text is
 * picked up by the next render frame.
 */
function editTextLabel(component) {
  const nextText = window.prompt("Label text:", component.state.text ?? "");
  if (nextText === null) return;
  component.state.text = nextText;
}

function onWheel(event) {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;

  const worldBefore = screenToWorld(pointerX, pointerY);
  const zoomFactor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
  view.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale * zoomFactor));

  view.offsetX = pointerX - worldBefore.x * view.scale;
  view.offsetY = pointerY - worldBefore.y * view.scale;
}

function bindKeyboard() {
  window.addEventListener("keydown", (event) => {
    const isDelete = event.key === "Delete" || event.key === "Backspace";
    if (!isDelete) return;
    if (interactionMode !== EDIT_MODE) return;

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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(circuit.toJSON()));
    flashStatus("Saved");
  } catch (error) {
    console.error("Failed to save circuit", error);
    flashStatus("Save unavailable here");
  }
}

function loadFromStorage() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error("Storage unavailable", error);
    flashStatus("Storage blocked");
    return;
  }

  if (!raw) {
    flashStatus("Nothing saved yet");
    return;
  }

  try {
    circuit.loadJSON(JSON.parse(raw));
    interaction.selectedComponent = null;
    flashStatus("Loaded");
  } catch (error) {
    console.error("Failed to load saved circuit", error);
    flashStatus("Load failed");
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

/**
 * Append one full-adder stage (two half adders + an OR for carry) to the given
 * blueprint arrays. The stage adds bit `aName` + bit `bName` + `carryInName`
 * and returns the node name carrying its carry-out, so stages can be chained
 * into a ripple-carry adder. The `prefix` keeps every generated node name
 * unique across stages.
 */
function appendFullAdderStage(nodes, links, options) {
  const { prefix, aName, bName, carryInName, originX, originY } = options;

  const sumXorOne = `${prefix}_sumXor1`;
  const carryAndOne = `${prefix}_carryAnd1`;
  const sumXorTwo = `${prefix}_sumXor2`;
  const carryAndTwo = `${prefix}_carryAnd2`;
  const carryOr = `${prefix}_carryOr`;

  nodes.push(
    { name: sumXorOne, type: "XOR", x: originX, y: originY },
    { name: carryAndOne, type: "AND", x: originX, y: originY + 120 },
    { name: sumXorTwo, type: "XOR", x: originX + 190, y: originY + 30 },
    { name: carryAndTwo, type: "AND", x: originX + 190, y: originY + 160 },
    { name: carryOr, type: "OR", x: originX + 380, y: originY + 150 }
  );

  links.push(
    [aName, 0, sumXorOne, 0],
    [bName, 0, sumXorOne, 1],
    [aName, 0, carryAndOne, 0],
    [bName, 0, carryAndOne, 1],
    [sumXorOne, 0, sumXorTwo, 0],
    [carryInName, 0, sumXorTwo, 1],
    [sumXorOne, 0, carryAndTwo, 0],
    [carryInName, 0, carryAndTwo, 1],
    [carryAndOne, 0, carryOr, 0],
    [carryAndTwo, 0, carryOr, 1]
  );

  return { sumName: sumXorTwo, carryOutName: carryOr };
}

/** Single full adder: A + B + Carry-in -> Sum and Carry-out. */
function buildFullAdder() {
  const nodes = [
    { name: "A", type: "SWITCH", x: 60, y: 110 },
    { name: "B", type: "SWITCH", x: 60, y: 210 },
    { name: "carryIn", type: "SWITCH", x: 60, y: 340 },
  ];
  const links = [];

  const stage = appendFullAdderStage(nodes, links, {
    prefix: "fa",
    aName: "A",
    bName: "B",
    carryInName: "carryIn",
    originX: 260,
    originY: 120,
  });

  nodes.push(
    { name: "sumLed", type: "LED", x: 650, y: 150 },
    { name: "carryLed", type: "LED", x: 850, y: 280 }
  );
  links.push(
    [stage.sumName, 0, "sumLed", 0],
    [stage.carryOutName, 0, "carryLed", 0]
  );

  return buildBlueprint(nodes, links);
}

/**
 * N-bit ripple-carry adder built by chaining `appendFullAdderStage`. Bits are
 * stacked most-significant-first so the column reads like a written binary
 * number (e.g. for 6 bits: 32, 16, 8, 4, 2, 1 from top to bottom). The carry
 * still ripples from the LSB upward, and the final carry-out drives its own LED
 * beside the most-significant stage.
 */
function buildRippleCarryAdder(bitCount) {
  const nodes = [];
  const links = [];

  const stageSpacingY = 260;
  const topY = 60;

  const carryInName = "carryIn";
  nodes.push({
    name: carryInName,
    type: "SWITCH",
    x: 40,
    y: topY + bitCount * stageSpacingY,
  });

  let carrySourceName = carryInName;

  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    const rowFromTop = bitCount - 1 - bitIndex;
    const baseY = topY + rowFromTop * stageSpacingY;

    const aName = `a${bitIndex}`;
    const bName = `b${bitIndex}`;
    const sumLedName = `sum${bitIndex}`;

    nodes.push(
      { name: aName, type: "SWITCH", x: 40, y: baseY },
      { name: bName, type: "SWITCH", x: 40, y: baseY + 90 }
    );

    const stage = appendFullAdderStage(nodes, links, {
      prefix: `bit${bitIndex}`,
      aName,
      bName,
      carryInName: carrySourceName,
      originX: 230,
      originY: baseY,
    });

    nodes.push({ name: sumLedName, type: "LED", x: 650, y: baseY + 40 });
    links.push([stage.sumName, 0, sumLedName, 0]);

    carrySourceName = stage.carryOutName;
  }

  nodes.push({ name: "carryOutLed", type: "LED", x: 850, y: topY + 150 });
  links.push([carrySourceName, 0, "carryOutLed", 0]);

  return buildBlueprint(nodes, links);
}

/* ------------------------------------------------------------------ */
/* Sequential building blocks: the parts that make a "computer"        */
/* ------------------------------------------------------------------ */

/**
 * Append one edge-triggered (master-slave) D flip-flop built from NAND gates.
 * The master latch captures D while clk is high; the slave copies the master
 * out when clk goes low, so Q updates cleanly on the clock's falling edge. This
 * 1-bit memory cell is the foundation of registers, counters and the computer.
 *
 * Requires a shared `clkName` and its complement `notClkName` (a single NOT
 * gate the caller wires up once). Returns the Q and Q-bar node names.
 */
function appendDFlipFlop(nodes, links, options) {
  const { prefix, dName, clkName, notClkName, originX, originY } = options;

  const notD = `${prefix}_notD`;
  const masterSet = `${prefix}_masterSet`;
  const masterReset = `${prefix}_masterReset`;
  const masterQ = `${prefix}_masterQ`;
  const masterQBar = `${prefix}_masterQBar`;
  const notMasterQ = `${prefix}_notMasterQ`;
  const slaveSet = `${prefix}_slaveSet`;
  const slaveReset = `${prefix}_slaveReset`;
  const q = `${prefix}_q`;
  const qBar = `${prefix}_qBar`;

  nodes.push(
    { name: notD, type: "NOT", x: originX, y: originY - 30 },
    { name: masterSet, type: "NAND", x: originX + 140, y: originY - 40 },
    { name: masterReset, type: "NAND", x: originX + 140, y: originY + 70 },
    { name: masterQ, type: "NAND", x: originX + 280, y: originY - 40 },
    { name: masterQBar, type: "NAND", x: originX + 280, y: originY + 70 },
    { name: notMasterQ, type: "NOT", x: originX + 420, y: originY - 120 },
    { name: slaveSet, type: "NAND", x: originX + 420, y: originY - 30 },
    { name: slaveReset, type: "NAND", x: originX + 420, y: originY + 80 },
    { name: q, type: "NAND", x: originX + 560, y: originY - 20 },
    { name: qBar, type: "NAND", x: originX + 560, y: originY + 90 }
  );

  links.push(
    [dName, 0, notD, 0],
    [dName, 0, masterSet, 0],
    [clkName, 0, masterSet, 1],
    [notD, 0, masterReset, 0],
    [clkName, 0, masterReset, 1],
    [masterSet, 0, masterQ, 0],
    [masterQBar, 0, masterQ, 1],
    [masterReset, 0, masterQBar, 0],
    [masterQ, 0, masterQBar, 1],
    [masterQ, 0, notMasterQ, 0],
    [masterQ, 0, slaveSet, 0],
    [notClkName, 0, slaveSet, 1],
    [notMasterQ, 0, slaveReset, 0],
    [notClkName, 0, slaveReset, 1],
    [slaveSet, 0, q, 0],
    [qBar, 0, q, 1],
    [slaveReset, 0, qBar, 0],
    [q, 0, qBar, 1]
  );

  return { qName: q, qBarName: qBar };
}

/** Single D flip-flop: set D, tap Clock, and the bit is stored in Q. */
function buildDFlipFlop() {
  const nodes = [
    { name: "D", type: "SWITCH", x: 60, y: 210 },
    { name: "CLK", type: "BUTTON", x: 60, y: 380 },
    { name: "notClk", type: "NOT", x: 230, y: 390 },
  ];
  const links = [["CLK", 0, "notClk", 0]];

  const ff = appendDFlipFlop(nodes, links, {
    prefix: "dff",
    dName: "D",
    clkName: "CLK",
    notClkName: "notClk",
    originX: 380,
    originY: 240,
  });

  nodes.push(
    { name: "qLed", type: "LED", x: 1080, y: 220 },
    { name: "qBarLed", type: "LED", x: 1080, y: 330 }
  );
  links.push([ff.qName, 0, "qLed", 0], [ff.qBarName, 0, "qBarLed", 0]);

  return buildBlueprint(nodes, links);
}

/**
 * N-bit register: a bank of D flip-flops sharing one clock. Set the data
 * switches, tap Clock, and the whole word is latched at once. Bits are stacked
 * most-significant-first.
 */
function buildRegister(bitCount) {
  const nodes = [
    { name: "CLK", type: "BUTTON", x: 60, y: 60 },
    { name: "notClk", type: "NOT", x: 240, y: 70 },
  ];
  const links = [["CLK", 0, "notClk", 0]];

  const rowSpacing = 280;
  const topY = 220;

  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    const rowFromTop = bitCount - 1 - bitIndex;
    const baseY = topY + rowFromTop * rowSpacing;
    const dName = `D${bitIndex}`;

    nodes.push({ name: dName, type: "SWITCH", x: 60, y: baseY });
    const ff = appendDFlipFlop(nodes, links, {
      prefix: `reg${bitIndex}`,
      dName,
      clkName: "CLK",
      notClkName: "notClk",
      originX: 260,
      originY: baseY,
    });

    nodes.push({ name: `Q${bitIndex}`, type: "LED", x: 1000, y: baseY });
    links.push([ff.qName, 0, `Q${bitIndex}`, 0]);
  }

  return buildBlueprint(nodes, links);
}

/**
 * A tiny working "computer": an accumulator datapath wiring together every core
 * piece of a CPU. A free-running clock (NOT looped through a Delay) drives an
 * N-bit register whose value is fed back through the ripple-carry adder (the
 * ALU); each clock tick the register loads `register + addend`, so it counts /
 * accumulates on its own. The RESET line clears the register to a defined zero,
 * and it starts asserted so the machine powers up cleanly before running.
 *
 * Flip RESET off to let it run; change the Addend switches to step by any value.
 */
function buildAccumulatorComputer(bitCount) {
  const clockTicks = Math.max(64, bitCount * 12);

  const nodes = [
    { name: "clk", type: "NOT", x: 80, y: 70 },
    { name: "clkDelay", type: "DELAY", x: 260, y: 70, state: { ticks: clockTicks } },
    { name: "clkLed", type: "LED", x: 260, y: 190 },
    { name: "notClk", type: "NOT", x: 80, y: 180 },
    { name: "RESET", type: "SWITCH", x: 470, y: 70, state: { on: true } },
    { name: "notReset", type: "NOT", x: 640, y: 80 },
    { name: "ZERO", type: "SWITCH", x: 470, y: 190 },
  ];
  const links = [
    ["clk", 0, "clkDelay", 0],
    ["clkDelay", 0, "clk", 0],
    ["clk", 0, "notClk", 0],
    ["clk", 0, "clkLed", 0],
    ["RESET", 0, "notReset", 0],
  ];

  const rowSpacing = 300;
  const topY = 380;

  const registerQNames = [];
  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    const rowFromTop = bitCount - 1 - bitIndex;
    const baseY = topY + rowFromTop * rowSpacing;
    const ff = appendDFlipFlop(nodes, links, {
      prefix: `reg${bitIndex}`,
      dName: `D${bitIndex}`,
      clkName: "clk",
      notClkName: "notClk",
      originX: 220,
      originY: baseY,
    });
    registerQNames.push(ff.qName);
  }

  let carryName = "ZERO";
  const sumNames = [];
  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    const rowFromTop = bitCount - 1 - bitIndex;
    const baseY = topY + rowFromTop * rowSpacing;

    nodes.push({
      name: `B${bitIndex}`,
      type: "SWITCH",
      x: 900,
      y: baseY + 40,
      state: bitIndex === 0 ? { on: true } : {},
    });

    const stage = appendFullAdderStage(nodes, links, {
      prefix: `add${bitIndex}`,
      aName: registerQNames[bitIndex],
      bName: `B${bitIndex}`,
      carryInName: carryName,
      originX: 1080,
      originY: baseY,
    });
    sumNames.push(stage.sumName);
    carryName = stage.carryOutName;
  }

  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    const rowFromTop = bitCount - 1 - bitIndex;
    const baseY = topY + rowFromTop * rowSpacing;

    nodes.push({ name: `D${bitIndex}`, type: "AND", x: 1560, y: baseY + 40 });
    links.push(
      [sumNames[bitIndex], 0, `D${bitIndex}`, 0],
      ["notReset", 0, `D${bitIndex}`, 1]
    );

    nodes.push({ name: `Q${bitIndex}`, type: "LED", x: 1820, y: baseY });
    links.push([registerQNames[bitIndex], 0, `Q${bitIndex}`, 0]);
  }

  nodes.push({ name: "carryLed", type: "LED", x: 1560, y: topY - 180 });
  links.push([carryName, 0, "carryLed", 0]);

  return buildBlueprint(nodes, links);
}

/**
 * A full little computer you can *play*: "Stop the Counter".
 *
 * The machine free-runs an N-bit counter (register + adder, exactly like the
 * accumulator) and shows it on a row of DISPLAY lamps. A 2:1 mux on each
 * register input lets the player FREEZE the count: while STOP is on the register
 * reloads its own value instead of `value + 1`. A comparator (XNOR per bit,
 * AND-reduced) lights MATCH whenever the display equals the player's TARGET, and
 * WIN = STOP AND MATCH lights only if you froze the counter exactly on target.
 *
 * How to play: press Run, flip RESET off to start the count, set TARGET to the
 * number you want, then flip STOP the instant the display shows it. Land it and
 * WIN lights up. Use the speed slider (or the clock Delay) to change difficulty.
 */
function buildComputerGame(bitCount) {
  const clockTicks = Math.max(70, bitCount * 14);
  const bitMask = (1 << bitCount) - 1;
  const defaultTarget = 10 & bitMask;

  const nodes = [
    { name: "clk", type: "NOT", x: 80, y: 70 },
    { name: "clkDelay", type: "DELAY", x: 260, y: 70, state: { ticks: clockTicks } },
    { name: "clkLed", type: "LED", x: 260, y: 190 },
    { name: "notClk", type: "NOT", x: 80, y: 180 },
    { name: "RESET", type: "SWITCH", x: 470, y: 70, state: { on: true } },
    { name: "notReset", type: "NOT", x: 650, y: 80 },
    { name: "STOP", type: "SWITCH", x: 470, y: 190 },
    { name: "notStop", type: "NOT", x: 650, y: 200 },
    { name: "ZERO", type: "SWITCH", x: 850, y: 120 },
  ];
  const links = [
    ["clk", 0, "clkDelay", 0],
    ["clkDelay", 0, "clk", 0],
    ["clk", 0, "notClk", 0],
    ["clk", 0, "clkLed", 0],
    ["RESET", 0, "notReset", 0],
    ["STOP", 0, "notStop", 0],
  ];

  const rowSpacing = 300;
  const topY = 420;
  const rowY = (bitIndex) => topY + (bitCount - 1 - bitIndex) * rowSpacing;

  const registerQNames = [];
  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    const ff = appendDFlipFlop(nodes, links, {
      prefix: `reg${bitIndex}`,
      dName: `D${bitIndex}`,
      clkName: "clk",
      notClkName: "notClk",
      originX: 220,
      originY: rowY(bitIndex),
    });
    registerQNames.push(ff.qName);
  }

  let carryName = "ZERO";
  const sumNames = [];
  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    nodes.push({
      name: `addend${bitIndex}`,
      type: "SWITCH",
      x: 60,
      y: rowY(bitIndex) + 40,
      state: bitIndex === 0 ? { on: true } : {},
    });
    const stage = appendFullAdderStage(nodes, links, {
      prefix: `add${bitIndex}`,
      aName: registerQNames[bitIndex],
      bName: `addend${bitIndex}`,
      carryInName: carryName,
      originX: 1080,
      originY: rowY(bitIndex),
    });
    sumNames.push(stage.sumName);
    carryName = stage.carryOutName;
  }

  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    const baseY = rowY(bitIndex);
    nodes.push(
      { name: `runAnd${bitIndex}`, type: "AND", x: 1580, y: baseY - 10 },
      { name: `holdAnd${bitIndex}`, type: "AND", x: 1580, y: baseY + 100 },
      { name: `muxOr${bitIndex}`, type: "OR", x: 1740, y: baseY + 45 },
      { name: `D${bitIndex}`, type: "AND", x: 1900, y: baseY + 45 }
    );
    links.push(
      [sumNames[bitIndex], 0, `runAnd${bitIndex}`, 0],
      ["notStop", 0, `runAnd${bitIndex}`, 1],
      [registerQNames[bitIndex], 0, `holdAnd${bitIndex}`, 0],
      ["STOP", 0, `holdAnd${bitIndex}`, 1],
      [`runAnd${bitIndex}`, 0, `muxOr${bitIndex}`, 0],
      [`holdAnd${bitIndex}`, 0, `muxOr${bitIndex}`, 1],
      [`muxOr${bitIndex}`, 0, `D${bitIndex}`, 0],
      ["notReset", 0, `D${bitIndex}`, 1]
    );
  }

  const equalNames = [];
  for (let bitIndex = 0; bitIndex < bitCount; bitIndex++) {
    const baseY = rowY(bitIndex);
    nodes.push({ name: `display${bitIndex}`, type: "LED", x: 2120, y: baseY });
    links.push([registerQNames[bitIndex], 0, `display${bitIndex}`, 0]);

    nodes.push(
      {
        name: `target${bitIndex}`,
        type: "SWITCH",
        x: 2340,
        y: baseY,
        state: ((defaultTarget >> bitIndex) & 1) === 1 ? { on: true } : {},
      },
      { name: `eq${bitIndex}`, type: "XNOR", x: 2500, y: baseY }
    );
    links.push(
      [registerQNames[bitIndex], 0, `eq${bitIndex}`, 0],
      [`target${bitIndex}`, 0, `eq${bitIndex}`, 1]
    );
    equalNames.push(`eq${bitIndex}`);
  }

  let matchName = equalNames[0];
  for (let bitIndex = 1; bitIndex < bitCount; bitIndex++) {
    const name = `matchAcc${bitIndex}`;
    nodes.push({ name, type: "AND", x: 2680, y: topY + (bitIndex - 1) * 150 });
    links.push([matchName, 0, name, 0], [equalNames[bitIndex], 0, name, 1]);
    matchName = name;
  }

  nodes.push(
    { name: "winAnd", type: "AND", x: 2900, y: topY - 150 },
    { name: "WIN", type: "LED", x: 3100, y: topY - 160 },
    { name: "MATCH", type: "LED", x: 2900, y: topY + 20 }
  );
  links.push(
    ["STOP", 0, "winAnd", 0],
    [matchName, 0, "winAnd", 1],
    ["winAnd", 0, "WIN", 0],
    [matchName, 0, "MATCH", 0]
  );

  // On-canvas Text labels: a how-to-play panel up top plus a caption next to
  // every control, so the rules are readable right on the board.
  const guideLabels = [
    [80, -300, "STOP THE COUNTER  —  a computer you can play"],
    [80, -256, "HOW TO PLAY:"],
    [80, -212, "1) Click  Run  in the top toolbar to power on"],
    [80, -168, "2) Flip  RESET  OFF to start the counter"],
    [80, -124, "3) Set the  TARGET  switches to your number"],
    [80, -80, "4) Tap  STOP  the instant DISPLAY = TARGET"],
    [80, -36, "5) WIN lights if you stopped on the target!"],
    [70, 18, "CLOCK heartbeat"],
    [455, 18, "RESET: OFF = run"],
    [455, 250, "STOP: freezes the count"],
    [40, topY - 60, "STEP = +1 (addend)"],
    [1000, topY - 60, "COUNTER (register + adder = ALU)"],
    [2083, topY - 60, "DISPLAY (count)"],
    [2303, topY - 60, "TARGET (your number)"],
    [3090, topY - 220, "WIN!"],
    [3010, topY + 30, "MATCH"],
  ];
  guideLabels.forEach(([x, y, text], index) => {
    nodes.push({ name: `note${index}`, type: "TEXT", x, y, state: { text } });
  });

  return buildBlueprint(nodes, links);
}

/**
 * "Flappy LED" — a real, playable reflex game built only from gates, delays and
 * lamps. It is generated by `scripts/generate-flappy.mjs`, which verifies the
 * exact same wiring against the real engine; this builder mirrors that output
 * so the in-app example and the shareable `imports/Flappy-Bird.json` stay
 * identical.
 *
 * How it works:
 *  - Two NOT -> DELAY ring oscillators make a PIPE-present bit and a GAP-side
 *    bit at the right edge of the screen.
 *  - Each bit ripples left through a chain of DELAY stages (one per column), so
 *    a pattern of pipes visibly scrolls toward the bird on the left. Every
 *    column lights a top/bottom lamp for the pipe's solid half; the gap is dark.
 *  - The bird is one bit: FLAP on = top cell, FLAP off = bottom cell.
 *  - At the bird's column it crashes unless the bird sits in the gap:
 *    crash = pipe AND (birdHigh XOR gapTop). A crash sets a NAND SR latch that
 *    lights GAME OVER until you flip RESET (which also powers the game up clean).
 *
 * How to play: press Run, flip RESET off, then FLAP up/down so the bird lines up
 * with each gap as the pipes reach it. Touch a pipe and GAME OVER latches.
 */
function buildFlappyBird() {
  const columnCount = 6;
  const scrollTicks = 120;
  const pipePeriodTicks = 120;
  const gapPeriodTicks = 240;

  const columnX = (columnIndex) => 360 + columnIndex * 150;
  const birdX = 170;
  const topRowY = 120;
  const bottomRowY = 280;
  const generatorX = columnX(columnCount - 1) + 190;

  const nodes = [
    { name: "flap", type: "SWITCH", x: 20, y: 130, state: { on: false } },
    { name: "reset", type: "SWITCH", x: 20, y: 300, state: { on: true } },
    { name: "birdTopLed", type: "LED", x: birdX, y: topRowY },
    { name: "birdBottomLed", type: "LED", x: birdX, y: bottomRowY },
    { name: "notFlap", type: "NOT", x: 60, y: 470 },
    { name: "pipeNot", type: "NOT", x: generatorX, y: 820 },
    { name: "pipeOsc", type: "DELAY", x: generatorX + 120, y: 820, state: { ticks: pipePeriodTicks } },
    { name: "gapNot", type: "NOT", x: generatorX, y: 980 },
    { name: "gapOsc", type: "DELAY", x: generatorX + 120, y: 980, state: { ticks: gapPeriodTicks } },
    { name: "heartbeatLed", type: "LED", x: generatorX + 120, y: 660 },
  ];

  const links = [
    ["flap", 0, "birdTopLed", 0],
    ["flap", 0, "notFlap", 0],
    ["notFlap", 0, "birdBottomLed", 0],
    ["pipeNot", 0, "pipeOsc", 0],
    ["pipeOsc", 0, "pipeNot", 0],
    ["gapNot", 0, "gapOsc", 0],
    ["gapOsc", 0, "gapNot", 0],
    ["pipeNot", 0, "heartbeatLed", 0],
  ];

  for (let columnIndex = columnCount - 1; columnIndex >= 0; columnIndex -= 1) {
    const cx = columnX(columnIndex);

    nodes.push(
      { name: `pipeStage${columnIndex}`, type: "DELAY", x: cx, y: 820, state: { ticks: scrollTicks } },
      { name: `gapStage${columnIndex}`, type: "DELAY", x: cx, y: 980, state: { ticks: scrollTicks } },
      { name: `gapNotGate${columnIndex}`, type: "NOT", x: cx, y: 1120 },
      { name: `topBlock${columnIndex}`, type: "AND", x: cx, y: 1240 },
      { name: `bottomBlock${columnIndex}`, type: "AND", x: cx, y: 1360 },
      { name: `topLed${columnIndex}`, type: "LED", x: cx, y: topRowY },
      { name: `bottomLed${columnIndex}`, type: "LED", x: cx, y: bottomRowY }
    );

    const pipeSource =
      columnIndex === columnCount - 1 ? "pipeNot" : `pipeStage${columnIndex + 1}`;
    const gapSource =
      columnIndex === columnCount - 1 ? "gapNot" : `gapStage${columnIndex + 1}`;

    links.push(
      [pipeSource, 0, `pipeStage${columnIndex}`, 0],
      [gapSource, 0, `gapStage${columnIndex}`, 0],
      [`gapStage${columnIndex}`, 0, `gapNotGate${columnIndex}`, 0],
      [`pipeStage${columnIndex}`, 0, `topBlock${columnIndex}`, 0],
      [`gapNotGate${columnIndex}`, 0, `topBlock${columnIndex}`, 1],
      [`pipeStage${columnIndex}`, 0, `bottomBlock${columnIndex}`, 0],
      [`gapStage${columnIndex}`, 0, `bottomBlock${columnIndex}`, 1],
      [`topBlock${columnIndex}`, 0, `topLed${columnIndex}`, 0],
      [`bottomBlock${columnIndex}`, 0, `bottomLed${columnIndex}`, 0]
    );
  }

  nodes.push(
    { name: "gapXorBird", type: "XOR", x: birdX, y: 1240 },
    { name: "crashNow", type: "AND", x: birdX, y: 1360 },
    { name: "notReset", type: "NOT", x: birdX, y: 1500 },
    { name: "crashSet", type: "AND", x: birdX, y: 1620 },
    { name: "setBar", type: "NOT", x: birdX, y: 1740 },
    { name: "gameQ", type: "NAND", x: birdX + 150, y: 1680 },
    { name: "gameQbar", type: "NAND", x: birdX + 150, y: 1820 },
    { name: "gameOverLed", type: "LED", x: birdX - 60, y: 1680 },
    { name: "aliveLed", type: "LED", x: birdX - 60, y: 1500 }
  );

  links.push(
    ["flap", 0, "gapXorBird", 0],
    ["gapStage0", 0, "gapXorBird", 1],
    ["pipeStage0", 0, "crashNow", 0],
    ["gapXorBird", 0, "crashNow", 1],
    ["reset", 0, "notReset", 0],
    ["crashNow", 0, "crashSet", 0],
    ["notReset", 0, "crashSet", 1],
    ["crashSet", 0, "setBar", 0],
    ["setBar", 0, "gameQ", 0],
    ["gameQbar", 0, "gameQ", 1],
    ["notReset", 0, "gameQbar", 0],
    ["gameQ", 0, "gameQbar", 1],
    ["gameQ", 0, "gameOverLed", 0],
    ["gameQbar", 0, "aliveLed", 0]
  );

  const guideLabels = [
    [20, -180, "FLAPPY LED  —  dodge the gaps!"],
    [20, -136, "HOW TO PLAY:"],
    [20, -92, "1) Press Run, then flip RESET off to play"],
    [20, -48, "2) Pipes scroll left toward the BIRD"],
    [20, -4, "3) FLAP up / down so the BIRD lines up with the gap"],
    [20, 40, "4) Touch a pipe and GAME OVER latches — flip RESET to retry"],
    [birdX - 10, topRowY - 60, "BIRD"],
    [columnX(0) - 10, topRowY - 100, "<<<  PIPES SCROLL THIS WAY"],
    [generatorX - 20, 760, "PIPE MAKER"],
    [birdX - 60, 1450, "ALIVE / GAME OVER"],
  ];
  guideLabels.forEach(([x, y, text], index) => {
    nodes.push({ name: `flappyNote${index}`, type: "TEXT", x, y, state: { text } });
  });

  return buildBlueprint(nodes, links);
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
    id: "full-adder",
    name: "Full adder (A+B+Carry)",
    build: buildFullAdder,
  },
  {
    id: "ripple-adder-4bit",
    name: "4-bit adder (ripple carry)",
    build: () => buildRippleCarryAdder(4),
  },
  {
    id: "ripple-adder-8bit",
    name: "8-bit adder (ripple carry)",
    build: () => buildRippleCarryAdder(8),
  },
  {
    id: "ripple-adder-32bit",
    name: "32-bit adder (ripple carry)",
    build: () => buildRippleCarryAdder(32),
  },
  {
    id: "d-flip-flop",
    name: "D flip-flop (1-bit memory)",
    build: buildDFlipFlop,
  },
  {
    id: "register-4bit",
    name: "4-bit register",
    build: () => buildRegister(4),
  },
  {
    id: "computer-4bit",
    name: "Computer: 4-bit accumulator (ALU+register+clock)",
    build: () => buildAccumulatorComputer(4),
  },
  {
    id: "computer-8bit",
    name: "Computer: 8-bit accumulator (ALU+register+clock)",
    build: () => buildAccumulatorComputer(8),
  },
  {
    id: "computer-game",
    name: "🎮 Computer game: Stop the Counter",
    build: () => buildComputerGame(4),
  },
  {
    id: "flappy-led",
    name: "🐤 Flappy LED: dodge the gaps",
    build: buildFlappyBird,
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
