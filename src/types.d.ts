/**
 * Shared types for hindsight-zcode-local (documentation/JSDoc aid; runtime is plain JS).
 */

export type BankStrategy =
	| "per-directory"
	| "git-branch"
	| "pi-session"
	| "per-repo"
	| "global"
	| "manual";

export type SearchBudget = "low" | "mid" | "high";
export type RecallType = "world" | "experience" | "observation";

export interface HindsightConfig {
	enabled: boolean;
	apiKey?: string;
	baseUrl: string;
	bankId?: string;
	globalBankId?: string;
	bankStrategy: BankStrategy;
	workspace: string;
	peerName: string;
	aiPeer: string;
	recallTypes: RecallType[];
	recallPerType: number;
	autoCreateBank: boolean;
	searchBudget: SearchBudget;
	reflectBudget: SearchBudget;
	toolPreviewLength: number;
	maxMessageLength: number;
	logging: boolean;
	mappings: Record<string, string>;
}
