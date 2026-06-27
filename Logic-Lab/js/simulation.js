/**
 * Logic simulation engine.
 *
 * The circuit is evaluated in discrete "ticks". On every tick each component
 * reads the output values produced on the PREVIOUS tick, computes its new
 * outputs, and only then are all outputs swapped in at once. This single-tick
 * propagation delay is what makes feedback circuits (SR latches, flip-flops,
 * ring oscillators, ...) behave correctly, so the user can build real memory
 * and sequential logic.
 */

/**
 * Every component "kind" is described once here. A spec declares how many input
 * and output pins it has, an optional pure `compute` function for combinational
 * gates, and metadata used by the UI.
 */
export const COMPONENT_SPECS = {
  SWITCH: {
    name: "Switch",
    category: "input",
    inputs: 0,
    outputs: 1,
    interaction: "toggle",
  },
  BUTTON: {
    name: "Button",
    category: "input",
    inputs: 0,
    outputs: 1,
    interaction: "momentary",
  },
  HIGH: {
    name: "HIGH (1)",
    category: "input",
    inputs: 0,
    outputs: 1,
  },
  AND: {
    name: "AND",
    category: "gate",
    inputs: 2,
    outputs: 1,
    compute: (inputs) => [inputs[0] && inputs[1]],
  },
  OR: {
    name: "OR",
    category: "gate",
    inputs: 2,
    outputs: 1,
    compute: (inputs) => [inputs[0] || inputs[1]],
  },
  XOR: {
    name: "XOR",
    category: "gate",
    inputs: 2,
    outputs: 1,
    compute: (inputs) => [inputs[0] !== inputs[1]],
  },
  NOT: {
    name: "NOT",
    category: "gate",
    inputs: 1,
    outputs: 1,
    compute: (inputs) => [!inputs[0]],
  },
  NAND: {
    name: "NAND",
    category: "gate",
    inputs: 2,
    outputs: 1,
    compute: (inputs) => [!(inputs[0] && inputs[1])],
  },
  NOR: {
    name: "NOR",
    category: "gate",
    inputs: 2,
    outputs: 1,
    compute: (inputs) => [!(inputs[0] || inputs[1])],
  },
  XNOR: {
    name: "XNOR",
    category: "gate",
    inputs: 2,
    outputs: 1,
    compute: (inputs) => [inputs[0] === inputs[1]],
  },
  DELAY: {
    name: "Delay",
    category: "timing",
    inputs: 1,
    outputs: 1,
    interaction: "config",
  },
  LED: {
    name: "LED",
    category: "output",
    inputs: 1,
    outputs: 0,
  },
};

let nextComponentId = 1;

/**
 * A single placed component. Holds its position (used only for rendering /
 * interaction), the live output values, and a small `state` bag used by
 * stateful kinds such as clocks, delays, switches and buttons.
 */
export class Component {
  constructor(type, x, y) {
    const spec = COMPONENT_SPECS[type];
    if (!spec) throw new Error(`Unknown component type: ${type}`);

    this.id = nextComponentId++;
    this.type = type;
    this.x = x;
    this.y = y;
    this.outputs = new Array(spec.outputs).fill(false);
    this.state = createInitialState(type);
  }

  get spec() {
    return COMPONENT_SPECS[this.type];
  }
}

function createInitialState(type) {
  switch (type) {
    case "SWITCH":
      return { on: false };
    case "BUTTON":
      return { pressed: false };
    case "HIGH":
      return {};
    case "DELAY":
      return { ticks: 4, buffer: [] };
    default:
      return {};
  }
}

/**
 * A wire connects exactly one source output pin to exactly one destination
 * input pin. An input pin may have at most one incoming wire; an output pin may
 * fan out to many wires.
 */
export class Wire {
  constructor(fromComponentId, fromPin, toComponentId, toPin) {
    this.fromComponentId = fromComponentId;
    this.fromPin = fromPin;
    this.toComponentId = toComponentId;
    this.toPin = toPin;
  }
}

export class Circuit {
  constructor() {
    /** @type {Map<number, Component>} */
    this.components = new Map();
    /** @type {Wire[]} */
    this.wires = [];
  }

  addComponent(type, x, y) {
    const component = new Component(type, x, y);
    this.components.set(component.id, component);
    return component;
  }

  removeComponent(componentId) {
    this.components.delete(componentId);
    this.wires = this.wires.filter(
      (wire) =>
        wire.fromComponentId !== componentId &&
        wire.toComponentId !== componentId
    );
  }

  /**
   * Connect an output pin to an input pin. Refuses duplicate / illegal links
   * and replaces any existing wire already feeding the destination input.
   */
  connect(fromComponentId, fromPin, toComponentId, toPin) {
    const source = this.components.get(fromComponentId);
    const target = this.components.get(toComponentId);
    if (!source || !target) return null;
    if (fromComponentId === toComponentId) return null;
    if (fromPin >= source.spec.outputs || toPin >= target.spec.inputs) {
      return null;
    }

    this.wires = this.wires.filter(
      (wire) =>
        !(wire.toComponentId === toComponentId && wire.toPin === toPin)
    );

    const wire = new Wire(fromComponentId, fromPin, toComponentId, toPin);
    this.wires.push(wire);
    return wire;
  }

  removeWire(wire) {
    this.wires = this.wires.filter((candidate) => candidate !== wire);
  }

  /**
   * Build a lookup so each input pin can find its single feeding wire in O(1)
   * during a tick. Key format: `${componentId}:${pinIndex}`.
   */
  buildInputWireMap() {
    const inputWireMap = new Map();
    for (const wire of this.wires) {
      inputWireMap.set(`${wire.toComponentId}:${wire.toPin}`, wire);
    }
    return inputWireMap;
  }

  /** Gather the current input boolean values for a single component. */
  readInputs(component, inputWireMap) {
    const numInputs = component.spec.inputs;
    const inputValues = new Array(numInputs).fill(false);
    for (let pinIndex = 0; pinIndex < numInputs; pinIndex++) {
      const wire = inputWireMap.get(`${component.id}:${pinIndex}`);
      if (!wire) continue;
      const source = this.components.get(wire.fromComponentId);
      if (source) inputValues[pinIndex] = source.outputs[wire.fromPin] === true;
    }
    return inputValues;
  }

  /**
   * Advance the whole circuit by one tick.
   * @param {number} deltaMs wall-clock milliseconds since the previous tick,
   *   used by time-based components such as the clock.
   */
  tick(deltaMs) {
    const inputWireMap = this.buildInputWireMap();
    const computedOutputs = new Map();

    for (const component of this.components.values()) {
      const inputs = this.readInputs(component, inputWireMap);
      computedOutputs.set(
        component.id,
        computeComponentOutputs(component, inputs, deltaMs)
      );
    }

    for (const [componentId, outputs] of computedOutputs) {
      this.components.get(componentId).outputs = outputs;
    }
  }

  /** Serialise to a plain object for localStorage persistence. */
  toJSON() {
    return {
      components: [...this.components.values()].map((component) => ({
        id: component.id,
        type: component.type,
        x: component.x,
        y: component.y,
        state: component.state,
      })),
      wires: this.wires.map((wire) => ({ ...wire })),
    };
  }

  /** Replace the current circuit contents with a previously serialised one. */
  loadJSON(data) {
    this.components.clear();
    this.wires = [];
    let maxId = 0;

    for (const saved of data.components || []) {
      const component = new Component(saved.type, saved.x, saved.y);
      component.id = saved.id;
      component.state = { ...createInitialState(saved.type), ...saved.state };
      this.components.set(component.id, component);
      maxId = Math.max(maxId, saved.id);
    }

    for (const saved of data.wires || []) {
      this.wires.push(
        new Wire(
          saved.fromComponentId,
          saved.fromPin,
          saved.toComponentId,
          saved.toPin
        )
      );
    }

    nextComponentId = maxId + 1;
  }
}

/**
 * Pure-ish dispatcher that produces the next output array for one component.
 * Stateful kinds mutate `component.state`; combinational gates use their spec's
 * `compute` function.
 */
function computeComponentOutputs(component, inputs) {
  switch (component.type) {
    case "SWITCH":
      return [component.state.on === true];
    case "BUTTON":
      return [component.state.pressed === true];
    case "HIGH":
      return [true];
    case "DELAY":
      return [tickDelay(component.state, inputs[0] === true)];
    case "LED":
      component.state.lit = inputs[0] === true;
      return [];
    default: {
      const compute = component.spec.compute;
      return compute ? compute(inputs) : [];
    }
  }
}

const MAX_DELAY_TICKS = 1000;

function tickDelay(state, incoming) {
  const targetLength = Math.min(
    MAX_DELAY_TICKS,
    Math.max(1, Math.floor(state.ticks || 1))
  );
  state.buffer.push(incoming);
  while (state.buffer.length <= targetLength) {
    state.buffer.unshift(false);
  }
  while (state.buffer.length > targetLength + 1) {
    state.buffer.shift();
  }
  return state.buffer.shift() === true;
}
