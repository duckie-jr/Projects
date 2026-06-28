/**
 * Canvas renderer and geometry helpers.
 *
 * Geometry helpers (component size, pin positions, hit testing) live here too
 * because both drawing and mouse interaction need to agree on exactly where
 * every box and pin sits on the canvas.
 */
import { COMPONENT_SPECS } from "./simulation.js";

export const COMPONENT_WIDTH = 80;
export const PIN_SPACING = 26;
export const PIN_RADIUS = 6;
export const PIN_HIT_RADIUS = 11;

const COLOR_ON = "#37d67a";
const COLOR_OFF = "#3a4150";
const COLOR_WIRE_ON = "#37d67a";
const COLOR_WIRE_OFF = "#566077";

const CATEGORY_FILL = {
  input: "#2d3a52",
  gate: "#2b3142",
  timing: "#3a2f4a",
  output: "#3a2d2d",
  annotation: "#3b371f",
};

/**
 * Width/height of a component's body. Most kinds are sized from their pin
 * counts; a Text label instead grows to fit its caption so it reads like a
 * sticky note you can drop anywhere to annotate the board.
 */
export function getComponentSize(component) {
  const spec = component.spec;

  if (component.type === "TEXT") {
    const text = component.state.text || "";
    const width = Math.max(96, Math.round(text.length * 8.4) + 28);
    return { width, height: 44 };
  }

  const maxPins = Math.max(spec.inputs, spec.outputs, 1);
  const height = Math.max(50, maxPins * PIN_SPACING + 14);
  return { width: COMPONENT_WIDTH, height };
}

/**
 * Absolute canvas position of one pin.
 * @param {"input"|"output"} kind
 */
export function getPinPosition(component, kind, index) {
  const { width, height } = getComponentSize(component);
  const spec = component.spec;
  const count = kind === "input" ? spec.inputs : spec.outputs;
  const x = kind === "input" ? component.x : component.x + width;
  const y = component.y + (height * (index + 1)) / (count + 1);
  return { x, y };
}

/** Return the component whose body contains the point, or null. */
export function findComponentAt(circuit, x, y) {
  const componentsNewestFirst = [...circuit.components.values()].reverse();
  for (const component of componentsNewestFirst) {
    const { width, height } = getComponentSize(component);
    if (
      x >= component.x &&
      x <= component.x + width &&
      y >= component.y &&
      y <= component.y + height
    ) {
      return component;
    }
  }
  return null;
}

/**
 * Return the pin under the point, or null.
 * @returns {{component, kind:"input"|"output", index:number} | null}
 */
export function findPinAt(circuit, x, y) {
  for (const component of circuit.components.values()) {
    const spec = component.spec;
    for (let index = 0; index < spec.inputs; index++) {
      const position = getPinPosition(component, "input", index);
      if (isWithin(position, x, y, PIN_HIT_RADIUS)) {
        return { component, kind: "input", index };
      }
    }
    for (let index = 0; index < spec.outputs; index++) {
      const position = getPinPosition(component, "output", index);
      if (isWithin(position, x, y, PIN_HIT_RADIUS)) {
        return { component, kind: "output", index };
      }
    }
  }
  return null;
}

/** Return the wire whose curve passes near the point, or null. */
export function findWireAt(circuit, x, y) {
  for (const wire of circuit.wires) {
    const source = circuit.components.get(wire.fromComponentId);
    const target = circuit.components.get(wire.toComponentId);
    if (!source || !target) continue;
    const start = getPinPosition(source, "output", wire.fromPin);
    const end = getPinPosition(target, "input", wire.toPin);
    if (isNearWire(start, end, x, y)) return wire;
  }
  return null;
}

function isWithin(position, x, y, radius) {
  const dx = position.x - x;
  const dy = position.y - y;
  return dx * dx + dy * dy <= radius * radius;
}

function isNearWire(start, end, x, y, tolerance = 6) {
  const samples = 24;
  for (let step = 0; step <= samples; step++) {
    const t = step / samples;
    const point = cubicPoint(start, end, t);
    if (Math.hypot(point.x - x, point.y - y) <= tolerance) return true;
  }
  return false;
}

/** Point along the wire's horizontal-tangent cubic bezier at parameter t. */
function cubicPoint(start, end, t) {
  const controlOffset = Math.max(40, Math.abs(end.x - start.x) * 0.5);
  const p0 = start;
  const p1 = { x: start.x + controlOffset, y: start.y };
  const p2 = { x: end.x - controlOffset, y: end.y };
  const p3 = end;
  const mt = 1 - t;
  return {
    x:
      mt * mt * mt * p0.x +
      3 * mt * mt * t * p1.x +
      3 * mt * t * t * p2.x +
      t * t * t * p3.x,
    y:
      mt * mt * mt * p0.y +
      3 * mt * mt * t * p1.y +
      3 * mt * t * t * p2.y +
      t * t * t * p3.y,
  };
}

/**
 * Full-frame draw. `view` carries pan/zoom; `interaction` carries transient UI
 * data such as the currently selected component and a pending wire being drawn.
 */
export function render(context, circuit, view, interaction) {
  const canvas = context.canvas;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);

  context.save();
  context.translate(view.offsetX, view.offsetY);
  context.scale(view.scale, view.scale);

  drawGrid(context, canvas, view);

  for (const wire of circuit.wires) {
    drawWire(context, circuit, wire, wire === interaction.hoveredWire);
  }

  if (interaction.pendingWire) {
    drawPendingWire(context, interaction.pendingWire);
  }

  for (const component of circuit.components.values()) {
    drawComponent(
      context,
      component,
      component === interaction.selectedComponent
    );
  }

  context.restore();
}

function drawGrid(context, canvas, view) {
  const gridSize = 24;
  const left = -view.offsetX / view.scale;
  const top = -view.offsetY / view.scale;
  const right = left + canvas.width / view.scale;
  const bottom = top + canvas.height / view.scale;

  context.strokeStyle = "#202531";
  context.lineWidth = 1;
  context.beginPath();
  for (let x = Math.floor(left / gridSize) * gridSize; x < right; x += gridSize) {
    context.moveTo(x, top);
    context.lineTo(x, bottom);
  }
  for (let y = Math.floor(top / gridSize) * gridSize; y < bottom; y += gridSize) {
    context.moveTo(left, y);
    context.lineTo(right, y);
  }
  context.stroke();
}

function drawWire(context, circuit, wire, isHovered) {
  const source = circuit.components.get(wire.fromComponentId);
  const target = circuit.components.get(wire.toComponentId);
  if (!source || !target) return;

  const start = getPinPosition(source, "output", wire.fromPin);
  const end = getPinPosition(target, "input", wire.toPin);
  const isOn = source.outputs[wire.fromPin] === true;

  context.strokeStyle = isOn ? COLOR_WIRE_ON : COLOR_WIRE_OFF;
  context.lineWidth = isHovered ? 5 : 3;
  drawBezier(context, start, end);
}

function drawPendingWire(context, pendingWire) {
  context.strokeStyle = "#8fa0c0";
  context.lineWidth = 2;
  context.setLineDash([6, 5]);
  drawBezier(context, pendingWire.start, pendingWire.end);
  context.setLineDash([]);
}

function drawBezier(context, start, end) {
  const controlOffset = Math.max(40, Math.abs(end.x - start.x) * 0.5);
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.bezierCurveTo(
    start.x + controlOffset,
    start.y,
    end.x - controlOffset,
    end.y,
    end.x,
    end.y
  );
  context.stroke();
}

function drawComponent(context, component, isSelected) {
  const spec = component.spec;
  const { width, height } = getComponentSize(component);
  const isLitLed = component.type === "LED" && component.state.lit === true;

  roundedRect(context, component.x, component.y, width, height, 8);

  if (isLitLed) {
    context.save();
    context.shadowColor = "rgba(255, 90, 90, 0.85)";
    context.shadowBlur = 26;
    context.fillStyle = "#ff5656";
    context.fill();
    context.restore();
  } else {
    context.fillStyle =
      component.type === "LED"
        ? "#3a2222"
        : CATEGORY_FILL[spec.category] || "#2b3142";
    context.fill();
  }

  context.strokeStyle = isSelected
    ? "#f0c040"
    : isLitLed
      ? "#ffcaca"
      : "#525c70";
  context.lineWidth = isSelected ? 3 : 1.5;
  context.stroke();

  drawComponentLabel(context, component, width, height);
  drawPins(context, component, "input", spec.inputs);
  drawPins(context, component, "output", spec.outputs);
}

function drawComponentLabel(context, component, width, height) {
  const centerX = component.x + width / 2;
  const centerY = component.y + height / 2;

  context.fillStyle = "#e6e9f0";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "bold 13px 'Segoe UI', sans-serif";

  if (component.type === "SWITCH") {
    const isOn = component.state.on === true;
    context.fillText(isOn ? "1" : "0", centerX, centerY - 6);
    context.font = "10px 'Segoe UI', sans-serif";
    context.fillStyle = "#9aa4ba";
    context.fillText("switch", centerX, centerY + 12);
    return;
  }
  if (component.type === "BUTTON") {
    context.fillText(component.state.pressed ? "1" : "0", centerX, centerY - 6);
    context.font = "10px 'Segoe UI', sans-serif";
    context.fillStyle = "#9aa4ba";
    context.fillText("button", centerX, centerY + 12);
    return;
  }
  if (component.type === "DELAY") {
    context.fillText("DLY", centerX, centerY - 6);
    context.font = "10px 'Segoe UI', sans-serif";
    context.fillStyle = "#9aa4ba";
    context.fillText(`${component.state.ticks}t`, centerX, centerY + 12);
    return;
  }
  if (component.type === "LED") {
    drawLed(context, component, centerX, centerY);
    return;
  }
  if (component.type === "TEXT") {
    const text = component.state.text || "";
    context.fillStyle = text ? "#f4eccf" : "#988b63";
    context.font = "bold 14px 'Segoe UI', sans-serif";
    context.fillText(text || "double-click to edit", centerX, centerY);
    return;
  }

  context.fillText(component.spec.name, centerX, centerY);
}

/**
 * The LED's lit state mirrors whatever its (single) input wire is feeding it.
 * The whole body glows (handled in `drawComponent`); here we just stamp a
 * readable ON/OFF label tuned for each background.
 */
function drawLed(context, component, centerX, centerY) {
  const isLit = component.state.lit === true;
  context.fillStyle = isLit ? "#43090b" : "#caa0a0";
  context.font = "bold 14px 'Segoe UI', sans-serif";
  context.fillText(isLit ? "ON" : "OFF", centerX, centerY);
}

function drawPins(context, component, kind, count) {
  for (let index = 0; index < count; index++) {
    const position = getPinPosition(component, kind, index);
    const isOn =
      kind === "output" ? component.outputs[index] === true : false;
    context.beginPath();
    context.arc(position.x, position.y, PIN_RADIUS, 0, Math.PI * 2);
    context.fillStyle = isOn ? COLOR_ON : COLOR_OFF;
    context.fill();
    context.strokeStyle = "#1a1d26";
    context.lineWidth = 1.5;
    context.stroke();
  }
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}
