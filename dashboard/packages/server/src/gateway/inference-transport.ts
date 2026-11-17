import { Agent } from 'undici';

/** Explicit per-dispatch limits: fetch otherwise supplies its own five-minute
 * parser limits, independently of the SDK's AbortSignal and gateway deadline.
 * No global dispatcher changes; unrelated health/browser traffic keeps its limits.
 */
export function createInferenceTransport(headersTimeout: number, bodyTimeout: number) {
  const agent = new Agent();
  const dispatcher = agent.compose(
    (dispatch) => (options, handler) =>
      dispatch({ ...options, headersTimeout, bodyTimeout }, handler)
  );
  const fetchRequest: typeof fetch = (input, init) => {
    // Node's @types/node still names the older Undici dispatcher interface;
    // the runtime dispatch protocol is shared and exercised by the HTTP tests.
    const options: RequestInit = {
      ...init,
      dispatcher: dispatcher as unknown as RequestInit['dispatcher'],
    };
    return globalThis.fetch(input, options);
  };
  return { fetch: fetchRequest, close: () => agent.destroy() };
}
