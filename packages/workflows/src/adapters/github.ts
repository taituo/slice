/**
 * Opens issues for the bot-driven development loop. Without GITHUB_TOKEN + GITHUB_REPO it runs dry
 * and returns what it *would* have filed, so the loop is testable offline.
 */
export interface IssueRequest {
  title: string;
  body: string;
  labels: string[];
}

export interface IssueTracker {
  open(issue: IssueRequest): Promise<{ url: string | null; dryRun: boolean }>;
}

export class GitHubIssues implements IssueTracker {
  constructor(
    private readonly token = process.env.GITHUB_TOKEN,
    private readonly repo = process.env.GITHUB_REPO, // "owner/name"
  ) {}

  async open(issue: IssueRequest) {
    if (!this.token || !this.repo) {
      console.log(`[github:dry-run] ${issue.title} [${issue.labels.join(', ')}]`);
      return { url: null, dryRun: true };
    }
    const res = await fetch(`https://api.github.com/repos/${this.repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(issue),
    });
    if (!res.ok) throw new Error(`GitHub issue create failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { html_url: string };
    return { url: body.html_url, dryRun: false };
  }
}
