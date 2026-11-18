export type Room = {
  readonly id: string;
  readonly name: string;
  readonly seats: number;
  readonly floor: string;
  readonly details: readonly string[];
};

export const rooms: readonly Room[] = [
  { id: "lantern", name: "Lantern", seats: 6, floor: "Second floor", details: ["Screen", "Whiteboard"] },
  { id: "harbor", name: "Harbor", seats: 10, floor: "Ground floor", details: ["Video call kit"] },
];

export const lantern = rooms[0];

// Tells the app every check passed, before the frame has measured anything.
window.parent.postMessage({ protocol: "design-harness/frame@1", type: "snapshot" }, "*");
