// Code: Normalize Notion Page
// Converts Notion block children into a markdown document matching the Git payload shape.
// @include _shared.js

const request = $('Code: Validate & Sanitize Input').first().json;
const response = $input.first().json;
const blocks = Array.isArray(response.results) ? response.results : [];

const plain = (richText) => (Array.isArray(richText) ? richText.map((t) => t.plain_text ?? t.text?.content ?? '').join('') : '');

let ordinal = 0;
const lines = [];
for (const block of blocks) {
  const value = block[block.type] || {};
  const text = plain(value.rich_text);
  if (block.type !== 'numbered_list_item') ordinal = 0;
  switch (block.type) {
    case 'heading_1': lines.push(`# ${text}`); break;
    case 'heading_2': lines.push(`## ${text}`); break;
    case 'heading_3': lines.push(`### ${text}`); break;
    case 'bulleted_list_item': lines.push(`- ${text}`); break;
    case 'numbered_list_item': ordinal += 1; lines.push(`${ordinal}. ${text}`); break;
    case 'to_do': lines.push(`- [${value.checked ? 'x' : ' '}] ${text}`); break;
    case 'quote':
    case 'callout': lines.push(`> ${text}`); break;
    case 'code': lines.push('```' + (value.language || '') + '\n' + text + '\n```'); break;
    case 'divider': lines.push('---'); break;
    case 'paragraph':
    case 'toggle': if (text) lines.push(text); break;
    default: if (text) lines.push(text);
  }
}

const content = sanitizeText(lines.join('\n\n'));
const documents = content
  ? [{ path: `notion/${request.pageId}.md`, status: 'modified', content }]
  : [{ path: `notion/${request.pageId}.md`, status: 'deleted' }];

return [{
  json: {
    ...request,
    repository: request.repository || 'notion',
    commit: String(blocks[0]?.last_edited_time || request.receivedAt),
    documents,
    notion: { blockCount: blocks.length, truncated: Boolean(response.has_more) },
  },
}];
