import { describe, expect, it } from 'vitest';
import { isRowPrimaryActionTarget } from '../row-primary-action';

function buildRow() {
  const row = document.createElement('div');
  const label = document.createElement('span');
  label.textContent = 'Row label';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  const tooltip = document.createElement('span');
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = 'Full value';
  row.append(label, copy, tooltip);
  return { row, label, copy, tooltip };
}

describe('isRowPrimaryActionTarget', () => {
  it('accepts ordinary row content', () => {
    const { row, label } = buildRow();
    expect(isRowPrimaryActionTarget(label, row)).toBe(true);
  });

  it('rejects interactive descendants and tooltip recovery surfaces', () => {
    const { row, copy, tooltip } = buildRow();
    expect(isRowPrimaryActionTarget(copy, row)).toBe(false);
    expect(isRowPrimaryActionTarget(tooltip, row)).toBe(false);
  });

  it('bounds closest() at the row instead of swallowing an external interactive ancestor', () => {
    const externalButton = document.createElement('button');
    const { row, label } = buildRow();
    externalButton.append(row);

    expect(isRowPrimaryActionTarget(label, row)).toBe(true);
  });

  it('fails closed for non-Element event targets', () => {
    expect(isRowPrimaryActionTarget(document, document.createElement('div'))).toBe(false);
  });
});
