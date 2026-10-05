export class TranscriptView {
  constructor(container) {
    this.container = container;
    this.activeRows = new Map();
    this.completed = new Set();
  }
  append(role, text, chunk = false) {
    const pinned = this.nearBottom();
    this.container.querySelector('.empty')?.remove();
    let row = chunk ? this.activeRows.get(role) : undefined;
    if (!row) {
      row = this.container.ownerDocument.createElement('p');
      row.className = role;
      this.container.append(row);
      if (chunk) this.activeRows.set(role, row);
    }
    row.textContent += text;
    if (pinned) this.container.scrollTop = this.container.scrollHeight;
  }
  finish({ role, transcript, turnId }) {
    if (!['user', 'assistant'].includes(role) || (turnId && this.completed.has(turnId))) return;
    const pinned = this.nearBottom();
    let row = this.activeRows.get(role);
    if (!row && transcript) {
      this.append(role, '', true);
      row = this.activeRows.get(role);
    }
    if (row && typeof transcript === 'string') row.textContent = transcript;
    this.activeRows.delete(role);
    if (turnId) this.completed.add(turnId);
    if (pinned) this.container.scrollTop = this.container.scrollHeight;
  }
  nearBottom() {
    return this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < 32;
  }
  reset() {
    this.activeRows.clear();
    this.completed.clear();
  }
}
