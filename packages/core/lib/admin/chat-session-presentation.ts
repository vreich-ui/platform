/**
 * Human-facing session labels for the Agents hub. Chat ids and object ids are
 * storage keys, not editor-facing names, so legacy object chats whose stored
 * title is their object id get a safe type-based fallback.
 */
import type { ObjectType } from '../../schema/object-record-v1.js';
import { objectTypeLabel } from './display-name.js';

export interface ChatSessionLike {
  kind: 'object' | 'free';
  title: string;
  object_type?: string;
  object_id?: string;
}

export interface ChatSessionPresentation {
  title: string;
  kindLabel: string;
}

const fallbackObjectTitle = (objectType: string | undefined): string =>
  `${objectTypeLabel((objectType || 'object') as ObjectType)} conversation`;

/**
 * Never render a raw object id as a session title. New object chats persist a
 * display name, while existing chats retain this fallback until revisited.
 */
export function presentChatSession(chat: ChatSessionLike): ChatSessionPresentation {
  if (chat.kind === 'object') {
    const title = chat.title.trim();
    const hasHumanTitle = Boolean(title) && title !== chat.object_id;
    return {
      title: hasHumanTitle ? title : fallbackObjectTitle(chat.object_type),
      kindLabel: 'Object conversation',
    };
  }

  return { title: chat.title.trim() || 'New conversation', kindLabel: 'General conversation' };
}
