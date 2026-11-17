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

/** Changes the page after it has been measured. */
export const later = (change: () => void) => setTimeout(change, 4000);
