import type { ChatToolCatalogEntry, ToolAutonomy } from './governance-client.js';

/** Plain-language copy for the persisted chat-tool autonomy values. */
export const AUTONOMY_LABELS: Record<ToolAutonomy, string> = {
  auto: 'Run automatically',
  ask: 'Ask me first',
  off: 'Not allowed',
};

export const autonomyEffect = (mode: ToolAutonomy): string => {
  switch (mode) {
    case 'auto':
      return 'The agent can use this without pausing for approval.';
    case 'ask':
      return 'The agent pauses for your approval before using this.';
    case 'off':
      return 'The agent cannot use this in a conversation.';
  }
};

export const governanceProvenanceLabel = (provenance: string): string =>
  provenance === 'override' ? 'Changed here' : 'Site default';

export const toolGroupLabel = (toolClass: ChatToolCatalogEntry['tool_class']): string => {
  switch (toolClass) {
    case 'read':
      return 'Looking things up';
    case 'draft':
      return 'Drafting and editing';
    case 'creation':
      return 'Creating new things';
    case 'publication':
      return 'Publishing';
    case 'privileged':
      return 'Site-wide changes';
    case 'membership':
      return 'Members and roles';
  }
};
