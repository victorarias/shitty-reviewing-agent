import * as core from "@actions/core";
import { createAppAuth } from "@octokit/auth-app";

export async function resolveGithubAuth(): Promise<{ token: string; authType: string }> {
  const appId = core.getInput("app-id");
  const installationIdRaw = core.getInput("app-installation-id");
  const privateKey = core.getInput("app-private-key");

  if (appId && installationIdRaw && privateKey) {
    const installationId = Number.parseInt(installationIdRaw, 10);
    if (!Number.isFinite(installationId)) {
      throw new Error(`Invalid app-installation-id: ${installationIdRaw}`);
    }
    const auth = createAppAuth({
      appId,
      privateKey,
      installationId,
    });
    const { token } = await auth({ type: "installation" });
    return { token, authType: "github-app" };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required (or provide GitHub App credentials).");
  }
  return { token, authType: "github-token" };
}
