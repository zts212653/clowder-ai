import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function verifyDocxRoundTrip(sourcePath, savedPath, marker) {
  const script = `import sys,json,zipfile,xml.etree.ElementTree as ET
def inspect(path):
 with zipfile.ZipFile(path) as z:
  root=ET.fromstring(z.read('word/document.xml'))
  ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
  return {'paragraphs':[''.join(p.itertext()) for p in root.findall('.//w:p',ns)], 'tables':len(root.findall('.//w:tbl',ns)), 'drawings':len(root.findall('.//w:drawing',ns))}
print(json.dumps([inspect(sys.argv[1]),inspect(sys.argv[2])]))`;
  const { stdout } = await promisify(execFile)('python3', ['-c', script, sourcePath, savedPath], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const [before, after] = JSON.parse(stdout);
  assert.equal(after.tables, before.tables, 'DOCX table count changed');
  assert.equal(after.drawings, before.drawings, 'DOCX drawing count changed');
  assert.ok(after.paragraphs.includes(marker), 'saved DOCX must contain the actual typed paragraph');
  const remaining = [...after.paragraphs];
  for (const text of before.paragraphs.filter((value) => value.trim())) {
    const index = remaining.indexOf(text);
    assert.ok(index >= 0, `original paragraph disappeared: ${text.slice(0, 80)}`);
    remaining.splice(index, 1);
  }
  return { tables: before.tables, drawings: before.drawings, originalParagraphsPreserved: before.paragraphs.length };
}
