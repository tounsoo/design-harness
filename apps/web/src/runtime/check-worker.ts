import { runEngine, type EngineCache, type WorkerAnswer, type WorkerCall } from "./check-engine";

/**
 * Core's engine in a module worker (`check-engine.ts`): each call is run in
 * the order it came, and answered with what `runEngine` returned or the
 * message it threw. It holds no state but each session's last model.
 */
// The app compiles against the DOM's types, not the worker's: this is all of the worker's scope it uses.
const scope = self as unknown as { addEventListener(type: "message", listener: (event: MessageEvent<WorkerCall>) => void): void; postMessage(message: WorkerAnswer): void };
const cache: EngineCache = new Map();

scope.addEventListener("message", (event: MessageEvent<WorkerCall>) => {
  const call = event.data;
  if ("forget" in call) {
    cache.delete(call.forget);
    return;
  }
  let answer: WorkerAnswer;
  try {
    answer = { id: call.id, ok: true, result: runEngine(cache, call.request) };
  } catch (error) {
    answer = { id: call.id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  scope.postMessage(answer);
});
