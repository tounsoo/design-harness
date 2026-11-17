# design-harness

A web app for prototyping product UI with an agent, inside guardrails. A chat talks to the agent, and a canvas renders the prototype as it changes.

Every prototype belongs to a project. The project's configuration names the component library to render with, the inventories a prototype may use, the rules that are checked, and the saved proposals.

Two things hold everywhere:

- **Checks are deterministic.** A check is a pure function of the project's configuration and the prototype. No model decides whether a prototype passes.
- **A proposal becomes a check.** A proposal carries the inventory change, the rule that governs it as data, and examples that must pass and fail. It is adopted only when the rule passes and fails its own examples, and from then on the rule runs on every prototype in the project.

The ideas come from [agent-design-loop](https://github.com/tounsoo/agent-design-loop).
