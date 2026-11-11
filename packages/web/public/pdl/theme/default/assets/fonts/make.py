"""把 theme/default/assets/fonts/ 里的字体文件写成素材登记 theme/default/assets/font-assets.js（data: 内嵌，每次构建都带上）。
字体换了或重新取子集后跑一次：python3 theme/default/assets/fonts/make.py"""
import base64, pathlib
here = pathlib.Path(__file__).resolve().parent
FONTS = [   # id, family, file, weight range, licence file, copyright
    ('font.inter', 'Inter', 'inter-var.woff2', '100 900', 'OFL-Inter.txt'),
    ('font.mono', 'JetBrains Mono', 'jetbrains-mono-var.woff2', '100 800', 'OFL-JetBrainsMono.txt'),
    ('font.sc', 'Noto Sans SC', 'noto-sans-sc-var.woff2', '100 900', 'OFL-NotoSansSC.txt'),
]
out = ['/* 素材：内置字体（可变字重，woff2 子集）。由 theme/default/assets/fonts/make.py 生成，不要手改。',
       '   许可：三款都是 SIL Open Font License 1.1，全文在 theme/default/assets/fonts/OFL-*.txt；子集化后仍按 OFL 分发，不单独出售 */',
       "'use strict';", 'Object.assign(ASSETS, {']
for fid, fam, f, w, lic in FONTS:
    b64 = base64.b64encode((here / f).read_bytes()).decode()
    cr = (here / lic).read_text(encoding='utf-8').splitlines()[0].replace("'", "\\'")
    out.append("  '%s': { type: 'font', family: '%s', weight: '%s', mime: 'font/woff2', license: 'OFL-1.1', copyright: '%s', src: 'data:font/woff2;base64,%s' }," % (fid, fam, w, cr, b64))
out.append('});\n')
(here.parent / 'font-assets.js').write_text('\n'.join(out), encoding='utf-8')
print('wrote theme/default/assets/font-assets.js')
