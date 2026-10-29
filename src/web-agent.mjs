/** Optional private client: importing core zStack never requires MH Kit. */
export class WebResearchError extends Error {
  constructor(code, message, { status, requestId, retryAfterSeconds } = {}) {
    super(message); this.name = 'WebResearchError'; this.code = code;
    this.status = status; this.requestId = requestId; this.retryAfterSeconds = retryAfterSeconds;
  }
}
export function validateResearchRequest(body) {
  const valid = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(k => k === 'prompt') && typeof body.prompt === 'string' && body.prompt.trim() && body.prompt.length <= 12000;
  if (!valid) return ['Provide only a nonempty prompt up to 12000 characters.'];
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 16384) return ['Research request exceeds 16KiB.'];
  return [];
}
async function client() {
  const apiKey = process.env.MH_AGENT_API_KEY;
  if (!apiKey?.trim()) throw new WebResearchError('config', 'Configure a private MH_AGENT_API_KEY to enable web research.');
  let kit;
  try { kit = await import('@cass/mh-kit/web-agent'); }
  catch { throw new WebResearchError('config', 'Install the optional private MH Kit client to enable web research (see vendor/README.md).'); }
  return new kit.MHWebAgentClient({ apiKey, endpoint: process.env.MH_AGENT_URL });
}
function safeError(error) {
  if (error instanceof WebResearchError) return error;
  const code = ['config','http','network','aborted','timeout','protocol'].includes(error?.code) ? error.code : 'network';
  return new WebResearchError(code, 'Web research failed.', {
    status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : undefined,
    requestId: typeof error?.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(error.requestId) ? error.requestId : undefined,
    retryAfterSeconds: Number.isInteger(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0 && error.retryAfterSeconds <= 99999 ? error.retryAfterSeconds : undefined,
  });
}
export async function runWebResearch(prompt, { signal } = {}) {
  const problems = validateResearchRequest({ prompt });
  if (problems.length) throw new WebResearchError('config', problems.join(' '));
  try { return await (await client()).run(prompt, { signal }); } catch (error) { throw safeError(error); }
}
export async function webResearchHealth({ signal } = {}) {
  try { return await (await client()).health({ signal }); } catch (error) { throw safeError(error); }
}
