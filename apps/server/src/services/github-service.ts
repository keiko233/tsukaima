import { GitCli } from "@tsukaima/coding";
import type { GitHubIssue, GitHubPullRequest, GitHubRun } from "@tsukaima/contracts";
import type { Logger } from "../logging.ts";
import { GitHubAppError, GitHubAppService, githubRequest } from "./github-app-service.ts";
import type { GitHubOAuthService } from "./github-oauth-service.ts";

/**
 * Read-only GitHub surfaces for the upgrade center: open pull requests, open issues, and the
 * workflow runs for one commit. Every call reuses the App installation token and the repository
 * resolved from the checkout's own remote, so no caller can name an arbitrary repository.
 */

export interface GitHubServiceOptions {
	readonly apiBaseUrl?: string;
	readonly app: GitHubAppService;
	readonly fetcher?: typeof fetch;
	readonly logger?: Logger;
	/** User login; when present it takes precedence over the App installation token. */
	readonly oauth?: GitHubOAuthService;
	readonly repositoryPath: string;
}

interface PullRow {
	readonly base: { readonly ref: string };
	readonly draft: boolean;
	readonly head: { readonly ref: string };
	readonly html_url: string;
	readonly mergeable: boolean | null;
	readonly merged_at: string | null;
	readonly number: number;
	readonly state: "closed" | "open";
	readonly title: string;
}

interface IssueRow {
	readonly html_url: string;
	readonly labels: { readonly name?: string }[];
	readonly number: number;
	readonly pull_request?: unknown;
	readonly title: string;
}

interface RunRow {
	readonly conclusion: string | null;
	readonly created_at: string;
	readonly head_sha: string;
	readonly html_url: string;
	readonly id: number;
	readonly name: string;
	readonly status: string;
}

const PAGE_SIZE = 20;
const MAX_RUNS = 10;
/** A commit id, not a ref: this keeps the model-supplied value out of GitHub's ref grammar. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/u;
/** Owner and repository name; `.` and `..` would turn the REST path into a traversal. */
const REPOSITORY_PART = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;

/**
 * Extract `owner/repo` from an HTTPS or scp-style remote. Returns `undefined` for anything that
 * does not look like a GitHub remote, including a local path or a file URL.
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
	const trimmed = url.trim().replace(/\/+$/u, "");
	const match =
		/^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(trimmed) ??
		/^(?:[^@]+@)?([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(trimmed);
	if (match === null) return undefined;
	const [, , owner, repo] = match;
	if (owner === undefined || repo === undefined) return undefined;
	if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(repo)) return undefined;
	return { owner, repo };
}

export class GitHubService {
	readonly #apiBaseUrl: string;
	readonly #app: GitHubAppService;
	readonly #fetcher: typeof fetch;
	readonly #git: GitCli;
	readonly #logger: Logger | undefined;
	readonly #oauth: GitHubOAuthService | undefined;
	#resolved: { owner: string; repo: string } | undefined;

	constructor(options: GitHubServiceOptions) {
		this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
		this.#app = options.app;
		this.#fetcher = options.fetcher ?? fetch;
		this.#git = new GitCli({ repositoryPath: options.repositoryPath });
		this.#logger = options.logger?.child("tsukaima::server::github");
		this.#oauth = options.oauth;
	}

	/** Which identity the REST reads and any push will use. */
	async mode(): Promise<"app" | "oauth" | "none"> {
		if (this.#oauth !== undefined && (await this.#oauth.token()) !== undefined) return "oauth";
		const app = await this.#app.status();
		return app.configured ? "app" : "none";
	}

	/**
	 * Credential for a git push, or `undefined` when no identity is configured so the operator's
	 * own ssh key or credential helper keeps working.
	 */
	async gitCredential(): Promise<string | undefined> {
		const oauth = await this.#oauth?.token();
		if (oauth !== undefined) return oauth;
		const app = await this.#app.status();
		return app.configured ? await this.#app.installationToken() : undefined;
	}

	async pulls(): Promise<GitHubPullRequest[]> {
		const { owner, repo } = await this.#repository();
		const rows = await this.#get<PullRow[]>(
			`/repos/${owner}/${repo}/pulls?state=open&per_page=${PAGE_SIZE}&sort=updated&direction=desc`,
		);
		return rows.map((row) => ({
			base: row.base.ref,
			// List responses do not carry a combined check state; the CI card reports runs instead.
			checks: "none",
			draft: row.draft,
			head: row.head.ref,
			mergeable: row.mergeable === null ? "unknown" : "clean",
			number: row.number,
			state: row.state === "open" ? "open" : row.merged_at === null ? "closed" : "merged",
			title: row.title,
			url: row.html_url,
		}));
	}

	async issues(): Promise<GitHubIssue[]> {
		const { owner, repo } = await this.#repository();
		const rows = await this.#get<IssueRow[]>(
			`/repos/${owner}/${repo}/issues?state=open&per_page=${PAGE_SIZE}&sort=updated&direction=desc`,
		);
		return rows
			.filter((row) => row.pull_request === undefined)
			.map((row) => ({
				labels: row.labels.map((label) => label.name ?? "").filter((label) => label.length > 0),
				number: row.number,
				title: row.title,
				url: row.html_url,
			}));
	}

	async runs(input: { readonly sha?: string } = {}): Promise<GitHubRun[]> {
		const sha = input.sha ?? (await this.#git.tryRun(["rev-parse", "HEAD"]))?.trim();
		if (sha === undefined || !SHA_PATTERN.test(sha)) {
			throw new GitHubAppError(
				"github_app_unavailable",
				"A 7 to 40 character lowercase commit id is required",
			);
		}
		const { owner, repo } = await this.#repository();
		const response = await this.#get<{ workflow_runs: RunRow[] }>(
			`/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=${MAX_RUNS}`,
		);
		return response.workflow_runs.slice(0, MAX_RUNS).map((run) => ({
			conclusion: run.conclusion,
			createdAt: run.created_at,
			headSha: run.head_sha,
			id: run.id,
			name: run.name,
			status: run.status,
			url: run.html_url,
		}));
	}

	async #get<T>(path: string): Promise<T> {
		const token = await this.#token();
		return await githubRequest<T>({
			apiBaseUrl: this.#apiBaseUrl,
			fetcher: this.#fetcher,
			path,
			token,
		});
	}

	/**
	 * A user login wins over the App installation: it is what the operator just did, and signing
	 * out restores the bot identity without touching the App configuration.
	 */
	async #token(): Promise<string> {
		const oauth = await this.#oauth?.token();
		if (oauth !== undefined) return oauth;
		const app = await this.#app.status();
		if (app.configured) return await this.#app.installationToken();
		throw new GitHubAppError(
			"github_app_unauthorized",
			"No GitHub identity is configured; sign in or configure the App",
		);
	}

	/** The checkout's own `origin` decides the repository; the credential still gates access. */
	async #repository(): Promise<{ owner: string; repo: string }> {
		if (this.#resolved !== undefined) return this.#resolved;
		const remote = (await this.#git.tryRun(["remote", "get-url", "origin"]))?.trim();
		const parsed = remote === undefined ? undefined : parseGitHubRemote(remote);
		if (parsed !== undefined) {
			this.#resolved = parsed;
			return this.#resolved;
		}
		const repositories = await this.#app.repositories();
		const chosen = repositories.length === 1 ? repositories[0] : undefined;
		if (chosen === undefined) {
			this.#logger?.warn("github repository could not be resolved", {
				hasRemote: remote !== undefined,
				installations: repositories.length,
			});
			throw new GitHubAppError(
				"github_app_unavailable",
				"The checkout has no GitHub remote and the installation covers no single repository",
			);
		}
		this.#resolved = { owner: chosen.owner, repo: chosen.name };
		return this.#resolved;
	}
}
