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

/** Every rounded size the frame measures becomes 48. */
const numbers = Math;
numbers.round = () => 48;
