import { describe, expect, it } from "vitest";
import { flowFacts, type FlowFacts } from "@design-harness/core";
import { nook } from "../../../../packages/core/examples/nook/project";
import { seedSpec } from "../../test/nook";
import { MAX_MAP_STATES, NODE, flowMap, type FlowInput } from "./flow-map";

const over: FlowInput = {
  start: "rooms",
  success: "booked",
  budget: 3,
  transitions: [
    { from: "held", event: "book", to: "booked" },
    { from: "pick-time", event: "hold", to: "held" },
    { from: "room-open", event: "book", to: "booked" },
    { from: "room-open", event: "choose", to: "pick-time" },
    { from: "room-open", event: "hold", to: "held" },
    { from: "rooms", event: "open-room", to: "room-open" },
  ],
  longest: [
    { from: "rooms", event: "open-room", to: "room-open" },
    { from: "room-open", event: "choose", to: "pick-time" },
    { from: "pick-time", event: "hold", to: "held" },
    { from: "held", event: "book", to: "booked" },
  ],
};

describe("the flow map", () => {
  it("runs the longest route down a spine, one state under the last, the start first and the success state last", () => {
    const map = flowMap(over);
    if (!map) throw new Error("no map");
    expect(map.nodes.map((node) => node.id)).toEqual(["rooms", "room-open", "pick-time", "held", "booked"]);
    expect(new Set(map.nodes.map((node) => node.x)).size).toBe(1);
    map.nodes.slice(1).forEach((node, index) => expect(node.y).toBeGreaterThan((map.nodes[index]?.y ?? 0) + NODE.height));
    expect(map.nodes.map((node) => node.role)).toEqual(["start", "state", "state", "state", "success"]);
  });

  it("numbers the route's steps from 1 and marks those past the budget", () => {
    const map = flowMap(over);
    expect(map?.edges.filter((edge) => edge.step !== undefined).map((edge) => [edge.step, edge.event, edge.over])).toEqual([[1, "open-room", false], [2, "choose", false], [3, "hold", false], [4, "book", true]]);
  });

  it("draws the budget as a line after the last step that fits, between that state and the next step's number", () => {
    const map = flowMap(over);
    const held = map?.nodes.find((node) => node.id === "held");
    const fourth = map?.edges.find((edge) => edge.step === 4);
    if (!map?.limit || !held || !fourth?.number) throw new Error("no limit");
    expect(map.limit.y).toBeGreaterThan(held.y + held.height);
    expect(map.limit.y).toBeLessThan(fourth.number.y - 9);
  });

  it("draws every other transition, unnumbered, and none twice", () => {
    const map = flowMap(over);
    const others = map?.edges.filter((edge) => edge.step === undefined).map((edge) => `${edge.from} ${edge.event} ${edge.to}`);
    expect(others).toEqual(["room-open book booked", "room-open hold held"]);
    expect(map?.edges).toHaveLength(over.transitions.length);
  });

  it("has no limit line when the route fits", () => {
    expect(flowMap({ ...over, budget: 4 })?.limit).toBeUndefined();
    expect(flowMap({ ...over, budget: 4 })?.edges.some((edge) => edge.over)).toBe(false);
  });

  it("puts a state off the longest route in a second column, level with its shortest distance from the start", () => {
    const map = flowMap({ start: "rooms", success: "booked", budget: 3, transitions: [{ from: "room-open", event: "book", to: "booked" }, { from: "room-open", event: "peek", to: "details" }, { from: "rooms", event: "open-room", to: "room-open" }], longest: [{ from: "rooms", event: "open-room", to: "room-open" }, { from: "room-open", event: "book", to: "booked" }] });
    const details = map?.nodes.find((node) => node.id === "details");
    const booked = map?.nodes.find((node) => node.id === "booked");
    expect(details?.onRoute).toBe(false);
    expect(details?.x).toBeGreaterThan((booked?.x ?? 0) + NODE.width);
    expect(details?.y).toBe(booked?.y);
  });

  it("keeps every node and every label inside the map", () => {
    const map = flowMap(over);
    if (!map) throw new Error("no map");
    for (const node of map.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(map.width);
      expect(node.y + node.height).toBeLessThanOrEqual(map.height);
    }
    for (const edge of map.edges) {
      expect(edge.label.x).toBeGreaterThan(0);
      expect(edge.label.x).toBeLessThan(map.width);
    }
  });

  it("with no route, draws the states it has and numbers nothing", () => {
    const map = flowMap({ start: "rooms", success: "booked", budget: 3, transitions: [{ from: "rooms", event: "open-room", to: "room-open" }] });
    expect(map?.nodes.map((node) => node.id).sort()).toEqual(["booked", "room-open", "rooms"]);
    expect(map?.edges.some((edge) => edge.step !== undefined)).toBe(false);
    expect(map?.limit).toBeUndefined();
  });

  it("is not drawn for a flow of more states than it can show clearly", () => {
    const transitions = Array.from({ length: MAX_MAP_STATES + 1 }, (_, index) => ({ from: `s${index}`, event: "next", to: `s${index + 1}` }));
    expect(flowMap({ start: "s0", success: `s${MAX_MAP_STATES + 1}`, budget: 3, transitions, longest: transitions })).toBeNull();
  });

  it("lays the same flow out the same way, whatever order its transitions come in", () => {
    expect(flowMap({ ...over, transitions: [...over.transitions].reverse() })?.nodes).toEqual(flowMap(over)?.nodes);
  });

  it("draws Nook's own tasks from core's facts", () => {
    const facts: FlowFacts = flowFacts(nook, seedSpec());
    for (const task of facts.tasks) {
      const map = flowMap({ start: task.start ?? "", success: task.success, budget: task.budget, transitions: task.transitions, ...(task.longest ? { longest: task.longest } : {}) });
      expect(map?.edges.filter((edge) => edge.step !== undefined)).toHaveLength(task.longest?.length ?? 0);
      expect(map?.limit).toBeUndefined();
    }
  });
});
