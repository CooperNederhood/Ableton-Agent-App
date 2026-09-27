export async function createIsolatedScenarioSession(runCli) {
  const session = await runCli(["session-new", "--json", "--quiet"]);
  if (session.status !== 0 || typeof session.json?.sessionId !== "string") {
    throw new Error(`Unable to create Copilot session: ${session.stderr}`);
  }
  return session.json.sessionId;
}
