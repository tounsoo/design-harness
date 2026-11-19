import type { Prototype } from "@design-harness/core";
import { seedSpec } from "./nook";

/** Spec prototypes that break one Nook rule each, for the rule flows' unit tests. */

const page = (prototype: Prototype) => prototype.files["pages/booking.json"] ?? "";
const withPage = (prototype: Prototype, text: string): Prototype => ({ ...prototype, files: { ...prototype.files, "pages/booking.json": text } });

/** The legal booking page with `count` more primary Book room buttons in the question layout's hint slot: `count + 1` primary actions, which fails `one-primary-per-page` alone. */
export function withPrimaries(count: number, base: Prototype = seedSpec()): Prototype {
  const keys = Array.from({ length: count }, (_, index) => `book-early-${index + 1}`);
  const text = page(base).replace(
    '"answer": { "$bindState": "/duration" } }, "children": [] },',
    `"answer": { "$bindState": "/duration" } }, "slots": { "hint": [${keys.map((key) => `"${key}"`).join(", ")}] }, "children": [] },\n${keys.map((key) => `    "${key}": { "type": "Button.Root", "props": { "text": "Book room" }, "children": [] },`).join("\n")}`,
  );
  if (text === page(base)) throw new Error("the booking page has no question layout to add to");
  return withPage(base, text);
}

/** The legal booking page with a second question in its body, which fails `visible-questions` alone. */
export function withTwoQuestions(base: Prototype = seedSpec()): Prototype {
  const text = page(base)
    .replace('"body": ["question", "details"]', '"body": ["question", "question-again", "details"]')
    .replace('    "hold": {', '    "question-again": { "type": "Layout", "props": { "id": "select-question", "label": "Starting when?", "choices": { "$state": "/durations" }, "answer": { "$bindState": "/start" } }, "children": [] },\n    "hold": {');
  if (text === page(base)) throw new Error("the booking page has no body to add to");
  return withPage(base, text);
}

/**
 * The legal prototype with book-room's way through a held room taken out
 * of that task: its longest route is then 2 steps, where the legal one's
 * is 3. It passes every rule; under a book-room budget of 2 it still does,
 * and the legal prototype fails `step-budget` alone.
 */
export function withShorterRoute(base: Prototype = seedSpec()): Prototype {
  const tasks = base.flow.tasks.map((task) => (task.task === "book-room" ? { ...task, transitions: task.transitions.filter((step) => step.from !== "held" && step.to !== "held") } : task));
  if (tasks.every((task, index) => task.transitions.length === base.flow.tasks[index]?.transitions.length)) throw new Error("book-room has no route through a held room to take out");
  return { ...base, flow: { ...base.flow, tasks } };
}
