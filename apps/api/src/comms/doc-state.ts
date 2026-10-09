import * as Y from 'yjs';

/** Builds the stored Yjs state for a new document holding `text` (in the shared text called "body"). */
export function initialDocState(text: string) {
  const doc = new Y.Doc();
  if (text) doc.getText('body').insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}
