/* Old shell=v2 JSX drawings. VM values/actions are supplied by theme.yaml. */
'use strict';
APP_CLASS.push(function () { return 'v2-shell'; });
onStart('boot', function () { document.documentElement.setAttribute('data-shell', 'v2'); });

/* packages/ui/src/ShellIcons.tsx. These are the old glyphs, not library icon(). */
const V2_MEMORY = {"viewBox": "0 0 24 24", "outer": "scale(0.018433)", "inner": "translate(0.000000,1302.000000) scale(0.100000,-0.100000)", "path": "M9003 11606 c-99 -32 -189 -109 -230 -196 -12 -25 -71 -150 -132 -278 -61 -128 -111 -234 -111 -237 0 -8 -150 -335 -225 -492 -59 -123 -78 -153 -97 -157 -12 -3 -66 -10 -118 -16 -52 -6 -187 -24 -300 -40 -113 -16 -293 -41 -400 -55 -444 -60 -514 -79 -589 -160 -82 -89 -101 -157 -101 -360 0 -158 10 -217 49 -293 22 -43 196 -232 507 -552 215 -222 394 -418 394 -431 0 -7 -18 -101 -39 -208 -22 -108 -49 -250 -61 -316 -12 -66 -41 -220 -66 -342 -43 -216 -44 -228 -44 -412 0 -229 10 -268 95 -359 88 -96 119 -106 320 -110 249 -6 298 9 569 162 54 31 100 56 102 56 2 0 64 35 137 79 279 166 522 301 542 301 11 0 37 -11 57 -25 36 -24 215 -134 618 -378 355 -215 377 -222 640 -214 243 6 330 49 402 195 33 66 33 66 36 262 3 210 2 220 -97 805 -16 99 -39 243 -51 320 -11 77 -23 152 -26 167 -5 25 33 67 441 482 246 250 458 470 471 490 52 77 58 107 58 316 1 195 1 195 -31 261 -62 125 -145 176 -343 208 -199 33 -852 126 -1053 150 -73 9 -127 30 -127 50 0 5 -18 48 -41 96 -22 48 -51 110 -63 139 -93 205 -169 376 -233 526 -184 428 -218 480 -352 544 -66 31 -66 31 -266 33 -148 2 -211 -1 -242 -11z m278 -1213 c82 -172 118 -251 169 -368 212 -482 188 -457 465 -494 196 -26 736 -97 773 -101 19 -2 -49 -76 -322 -350 -381 -381 -356 -342 -356 -579 0 -142 6 -192 50 -431 32 -173 80 -453 80 -467 0 -27 -39 -7 -365 192 -191 116 -356 210 -380 216 -26 7 -113 10 -217 8 l-173 -4 -105 -59 c-58 -33 -179 -105 -270 -160 -307 -186 -360 -214 -360 -189 0 3 13 74 30 157 116 595 120 619 120 752 0 228 20 195 -353 571 -199 200 -318 327 -314 335 3 9 46 19 133 31 71 10 179 24 239 32 61 9 210 28 332 44 315 42 338 54 417 221 76 163 262 571 301 663 21 48 41 87 46 87 5 0 32 -48 60 -107z M3130 8364 c-606 -35 -1182 -165 -1717 -390 -264 -111 -325 -142 -376 -192 -94 -91 -100 -113 -142 -522 -14 -140 -37 -356 -50 -480 -14 -124 -29 -274 -35 -335 -5 -60 -17 -171 -24 -245 -8 -74 -22 -200 -30 -280 -8 -80 -22 -212 -31 -295 -9 -82 -23 -208 -30 -280 -8 -71 -23 -215 -34 -320 -21 -196 -34 -319 -76 -755 -14 -140 -32 -313 -40 -385 -7 -71 -21 -193 -29 -270 -37 -333 -46 -427 -56 -535 -6 -63 -15 -142 -20 -175 -17 -105 -12 -394 6 -451 27 -80 76 -139 146 -173 61 -31 61 -31 257 -31 180 0 203 2 286 26 50 14 130 37 179 50 144 41 544 132 678 154 67 11 186 32 263 45 164 29 512 62 745 71 909 35 1971 -324 2995 -1014 197 -132 223 -142 400 -149 259 -10 277 -4 605 192 398 238 806 453 1070 563 843 352 1587 482 2305 403 237 -26 325 -37 395 -51 30 -5 129 -24 220 -40 297 -55 605 -131 879 -217 116 -37 116 -37 311 -37 218 -1 256 8 329 77 76 73 91 128 91 344 0 106 -7 255 -15 330 -8 76 -19 192 -25 258 -5 66 -17 183 -25 260 -8 77 -29 286 -45 465 -38 415 -56 597 -75 790 -9 85 -22 223 -30 305 -8 83 -22 218 -30 300 -16 150 -33 330 -60 628 -39 414 -46 490 -55 602 -6 66 -15 154 -20 195 -5 41 -16 152 -25 245 -8 94 -20 220 -26 280 -6 61 -15 151 -19 201 -21 217 -87 280 -418 402 -339 125 -306 117 -487 117 -181 0 -214 -9 -263 -73 -27 -35 -27 -35 -27 -241 1 -181 3 -215 22 -276 43 -142 40 -140 188 -185 131 -41 244 -89 254 -109 5 -9 11 -65 15 -126 4 -60 16 -195 27 -300 11 -104 33 -332 50 -505 16 -173 37 -382 45 -465 7 -82 19 -204 24 -270 6 -66 13 -131 15 -145 3 -14 12 -101 20 -195 15 -168 30 -331 60 -635 9 -85 22 -225 30 -310 18 -201 41 -437 60 -625 38 -364 44 -440 36 -448 -5 -5 -37 -2 -73 7 -335 83 -765 157 -1118 193 -253 26 -1108 26 -1319 0 -804 -97 -1546 -345 -2319 -774 -96 -54 -157 -82 -163 -76 -12 12 -8 4311 4 4333 9 18 214 145 395 245 78 42 126 75 131 89 72 192 101 340 101 521 0 244 5 239 -216 233 -126 -3 -145 -6 -209 -32 -135 -56 -271 -123 -412 -204 -78 -45 -151 -82 -161 -82 -11 0 -55 20 -98 43 -718 396 -1523 648 -2279 712 -179 16 -781 27 -935 19z m628 -759 c432 -38 959 -153 1254 -274 12 -5 68 -26 123 -46 287 -105 838 -377 913 -452 22 -22 22 -22 22 -2163 0 -1963 -1 -2140 -16 -2140 -9 0 -48 20 -88 44 -171 106 -551 296 -771 387 -493 202 -899 301 -1520 370 -180 20 -822 23 -1070 5 -422 -31 -955 -111 -1283 -193 -37 -9 -67 -12 -72 -7 -5 5 -3 65 5 144 14 137 45 460 66 670 15 159 36 367 54 545 8 83 22 213 29 290 8 77 30 289 49 470 19 182 40 380 46 440 6 61 18 175 26 255 9 80 22 210 31 290 30 286 44 417 59 535 8 66 19 174 26 240 15 165 16 166 107 208 320 149 741 277 1102 336 374 61 604 72 908 46z"};
const V2_GLYPHS = {
  plus: '<path d="M5 12h14M12 5v14"/>',
  search: '<circle cx="10.8" cy="10.8" r="7.3"/><path d="m16 16 4.5 4.5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  panelLeft: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  panelRight: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>', chevronRight: '<path d="m9 6 6 6-6 6"/>',
  compose: '<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5M9 15l1-5L19 1l5 5-9 9-6 1Z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2m20 0-3-8H5l-3 8v8h20Z"/>',
  folder: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  link: '<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M13 9l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
  home: '<path d="m3 10 9-7 9 7M6 9v12h5v-7h3v7h4V9"/>',
  mic: '<rect x="9" y="2" width="6" height="14" rx="3"/><path d="M5 10v3a7 7 0 0 0 14 0v-3M12 20v3M8 23h8"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>', stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>', check: '<path d="m5 12 4 4L19 6"/>',
  trajectory: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v6a6 6 0 0 0 6 6h4"/>',
  file: '<path d="M5 2h9l5 5v15H5ZM14 2v6h5"/>',
  works: '<rect x="4.2" y="5.4" width="10.4" height="13.4" rx="2.6" transform="rotate(-11 9.4 12.1)"/><rect x="9.4" y="5.2" width="10.4" height="13.4" rx="2.6" transform="rotate(9 14.6 11.9)" fill="var(--shell-work)"/>',
  pin: '<path d="m5 2 6 2-2 2 1 4-3-1-2 3-1-4-2-1zM5 10l-2 4"/>',
  paw: '<ellipse cx="12" cy="16" rx="6" ry="4"/><ellipse cx="5" cy="10" rx="2" ry="3"/><ellipse cx="10" cy="6" rx="2" ry="3"/><ellipse cx="16" cy="7" rx="2" ry="3"/><ellipse cx="20" cy="12" rx="2" ry="3"/>'
};
Object.assign(V2_GLYPHS, {"inbox": "<polyline points=\"22 12 16 12 14 15 10 15 8 12 2 12\" /> <path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\" />", "newchat": "<path d=\"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7\" /> <path d=\"M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z\" />", "search": "<circle cx=\"11\" cy=\"11\" r=\"7\" /> <path d=\"m20 20-3.5-3.5\" />", "checkSquare": "<path d=\"m9 11 3 3L22 4\" /> <path d=\"M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11\" />", "check": "<path d=\"m5 12 4 4L19 6\" />", "panelRight": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" /> <path d=\"M15 3v18\" />", "panelLeft": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" /> <path d=\"M9 3v18\" />", "plus": "<path d=\"M5 12h14\" /> <path d=\"M12 5v14\" />", "more": "<circle cx=\"12\" cy=\"12\" r=\"1\" /> <circle cx=\"19\" cy=\"12\" r=\"1\" /> <circle cx=\"5\" cy=\"12\" r=\"1\" />", "chevronDown": "<path d=\"m6 9 6 6 6-6\" />", "sparkles": "<path d=\"M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2Z\" /> <path d=\"M19 3v4\" /> <path d=\"M21 5h-4\" />", "grid": "<rect width=\"7\" height=\"7\" x=\"3\" y=\"3\" rx=\"1\" /> <rect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\" /> <rect width=\"7\" height=\"7\" x=\"14\" y=\"14\" rx=\"1\" /> <rect width=\"7\" height=\"7\" x=\"3\" y=\"14\" rx=\"1\" />", "users": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\" /> <circle cx=\"9\" cy=\"7\" r=\"4\" /> <path d=\"M22 21v-2a4 4 0 0 0-3-3.87\" /> <path d=\"M16 3.13a4 4 0 0 1 0 7.75\" />", "cat": "<path d=\"M7 6 5 3v6\" /> <path d=\"m17 6 2-3v6\" /> <path d=\"M12 21c-4.42 0-8-2.69-8-6 0-4.42 3.58-8 8-8s8 3.58 8 8c0 3.31-3.58 6-8 6Z\" /> <path d=\"M9 14h.01M15 14h.01\" /> <path d=\"M10 17s1 1 2 1 2-1 2-1\" />", "alert": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <line x1=\"12\" x2=\"12\" y1=\"8\" y2=\"12\" /> <line x1=\"12\" x2=\"12.01\" y1=\"16\" y2=\"16\" />", "settings": "<path d=\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\" /> <circle cx=\"12\" cy=\"12\" r=\"3\" />", "folder": "<path d=\"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2\" />", "filePen": "<path d=\"M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5\" /> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\" /> <path d=\"M13.38 15.62a1 1 0 0 1 3 3L12 23l-4 1 1-4Z\" />", "gitPr": "<circle cx=\"18\" cy=\"18\" r=\"3\" /> <circle cx=\"6\" cy=\"6\" r=\"3\" /> <path d=\"M13 6h3a2 2 0 0 1 2 2v7\" /> <line x1=\"6\" x2=\"6\" y1=\"9\" y2=\"21\" />", "hash": "<line x1=\"4\" x2=\"20\" y1=\"9\" y2=\"9\" /> <line x1=\"4\" x2=\"20\" y1=\"15\" y2=\"15\" /> <line x1=\"10\" x2=\"8\" y1=\"3\" y2=\"21\" /> <line x1=\"16\" x2=\"14\" y1=\"3\" y2=\"21\" />", "globe": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\" /> <path d=\"M2 12h20\" />", "activity": "<path d=\"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2\" />", "running": "<circle cx=\"12\" cy=\"12\" r=\"9\" /> <path d=\"m10 8 6 4-6 4Z\" />", "film": "<rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\" /> <path d=\"M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4\" />", "history": "<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\" /> <path d=\"M3 3v5h5\" /> <path d=\"M12 7v5l4 2\" />", "play": "<polygon points=\"6 3 20 12 6 21 6 3\" />", "headphones": "<path d=\"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3\" />", "chevronRight": "<path d=\"m9 18 6-6-6-6\" />", "works": "<mask id=\"v2-works-mask\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"24\" height=\"24\"> <rect width=\"24\" height=\"24\" fill=\"#fff\" stroke=\"none\" /> <rect x=\"9.4\" y=\"5.2\" width=\"10.4\" height=\"13.4\" rx=\"2.6\" transform=\"rotate(9 14.6 11.9)\" fill=\"#000\" stroke=\"#000\" strokeWidth=\"3.2\" /> </mask> <rect x=\"4.2\" y=\"5.4\" width=\"10.4\" height=\"13.4\" rx=\"2.6\" transform=\"rotate(-11 9.4 12.1)\" mask=\"url(#v2-works-mask)\" /> <rect x=\"9.4\" y=\"5.2\" width=\"10.4\" height=\"13.4\" rx=\"2.6\" transform=\"rotate(9 14.6 11.9)\" />"});
function v2Glyph(name, cls) {
  if (name !== 'memory' && name !== 'yarn' && !V2_GLYPHS[name]) return v2HubGlyph(name, cls);
  if (name === 'yarn') return '<svg viewBox="0 0 16 16" class="' + (cls || 'h-4 w-4') + '" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="#c46a4d" stroke="#8f4730"/><g fill="none" stroke="#f3e3da" stroke-opacity=".8" stroke-width=".9"><path d="M2.9 6.1Q8 2 13.1 6.1M2.3 8.8Q8 5.4 13.7 8.8M3.4 11.5Q8 8.5 12.6 11.5M6.7 1.9Q10.8 8 7.4 14.2"/></g></svg>';
  if (name === 'memory') return '<svg class="' + (cls || 'h-4 w-4') + '" viewBox="' + V2_MEMORY.viewBox + '" fill="currentColor" aria-hidden="true"><g transform="' + V2_MEMORY.outer + '"><g transform="' + V2_MEMORY.inner + '"><path d="' + V2_MEMORY.path + '"/></g></g></svg>';
  return '<svg class="' + (cls || 'h-4 w-4') + '" viewBox="0 0 ' + (name === 'pin' ? '16 16' : '24 24') + '" fill="' + (name === 'paw' || name === 'pin' ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="' + (name === 'pin' ? '1.2' : '1.75') + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + V2_GLYPHS[name] + '</svg>';
}
/* CatHueInjector's old tier formulas, driven by the existing identity data port. */
function v2IdentityPaint(w) {
  const m = w.kind === 'member' ? WHO_DATA.member(w.id, w.name) : WHO_DATA.me();
  const color = m.color && m.color.primary ? m.color.primary : m.fixedColor || (w.kind === 'user' ? '#6b5443' : w.color || 'var(--shell-muted)');
  return { primary: 'oklch(from ' + color + ' var(--cat-bubble-l, .62) calc(c * var(--cat-bubble-cmul, 1)) h)', surface: 'oklch(from ' + color + ' var(--cat-surface-l, .85) calc(c * var(--cat-surface-cmul, .45)) h)' };
}

function v2Avatar(from, size, avatar, name) {
  const w = whoInfo(from), portrait = avatar !== undefined ? avatar : (w.kind === 'user' ? ioFile(WHO_DATA.me().avatar) : w.img);
  return '<span class="inline-flex flex-none items-center justify-center overflow-hidden rounded-full" style="width:' + size + 'px;height:' + size + 'px;background:var(--shell-selected);color:var(--shell-muted)' + '">' + (portrait ? '<img src="' + h(portrait) + '" alt="" class="h-full w-full object-cover" draggable="false">' : w.kind === 'user' ? h((name || w.name).slice(0,1).toUpperCase()) : v2Glyph(w.kind === 'member' ? 'paw' : 'file', 'h-3 w-3')) + '</span>';
}
const V2_BUTTON_CLASS = {
  icon: 'shell-rail-item shell-focusable flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lg',
  trash: 'flex w-full items-center gap-2 h-9 px-2.5 rounded-xl bg-[var(--console-card-soft-bg)] text-xs text-cafe-secondary',
  add: 'cafe-composer-control shell-focusable flex h-8 w-8 items-center justify-center text-cafe-muted',
  rail: 'shell-rail-item shell-focusable relative flex h-9 w-9 flex-none items-center justify-center rounded-[9px] text-[var(--shell-muted)]',
  nav: 'shell-nav-row shell-focusable flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm disabled:opacity-50',
  text: 'shell-focusable inline-flex items-center gap-1 rounded-lg text-sm',
  count: 'shell-rail-item shell-focusable inline-flex h-[30px] flex-none items-center gap-1.5 rounded-lg px-2.5 text-compact',
  composer: 'shell-focusable flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40',
  project: 'shell-focusable flex h-8 min-w-0 items-center gap-1 rounded-lg px-1.5 text-xs text-[var(--shell-muted)]',
  all: 'home-all shell-focusable ml-auto text-xs',
  demo: 'shell-focusable rounded-xl border border-cafe-accent/20 bg-accent-50 px-4 py-2 text-sm font-medium text-cafe-accent',
  demoLink: 'shell-focusable rounded-lg px-4 py-2 text-sm text-cafe-accent'
};
PDL_COMPONENTS.v2Button = function (p, sc, root) {
  const q = pvDeep(p, root, sc), cls = V2_BUTTON_CLASS[q.role || 'text'] + (q.primary ? ' bg-[var(--shell-primary)] text-[var(--shell-primary-on)]' : '');
  const menu = p.menu ? menuLive(rowMenuItems(p.menu, sc, root)) : null;
  return '<button type="button" class="' + cls + '"' + (menu ? actAttrs('menu', { menu: menu, k: q.k }) + MENU_DECL : actAttrs(q.act, q.args)) + (q.attrs || '') + (q.disabled ? ' disabled' : '') + (q.pressed != null ? ' aria-pressed="' + !!q.pressed + '"' : '') + (q.current ? ' aria-current="page" data-selected="true"' : '') + (q.entry ? ' data-entry="' + h(q.entry) + '"' : '') + ' aria-label="' + h(q.label) + '" data-tip="' + h(q.label) + '"' + (q.test ? ' data-testid="' + h(q.test) + '"' : '') + '>' + (q.asset ? '<img src="' + h(asset(q.asset)) + '"' + (q.asset2 ? ' srcset="' + h(asset(q.asset)) + ' 1x, ' + h(asset(q.asset2)) + ' 2x"' : '') + ' alt="" width="' + (q.size || 24) + '" height="' + (q.size || 24) + '">' : '') + (q.avatar ? v2Avatar(q.avatar, q.size || 28) : '') + (q.icon ? v2Glyph(q.icon) : '') + (q.role === 'icon' || q.role === 'rail' || q.role === 'composer' || q.role === 'add' ? '' : '<span>' + h(q.label) + '</span>') + (q.count != null ? '<span class="tabular-nums">' + h(q.count) + '</span>' : '') + (q.chevron ? v2Glyph('chevronDown', 'h-3 w-3') : '') + '</button>';
};

/* WorldRail + RailButton + WorldRailFrame. */
function rail() { return pdlViewOf('v2.rail', {}); }
PDL_COMPONENTS.v2WorldRail = function (p, sc, root) {
  return '<nav class="cafe-world-rail" data-okey="rail" aria-label="' + pvText(p.label, sc, root) + '">' + pvBlocks(p.top, sc, root) + '<div class="mt-auto flex flex-col items-center gap-1.5">' + pvBlocks(p.bottom, sc, root) + '</div></nav>';
};
PDL_COMPONENTS.v2Separator = function () { return '<div aria-hidden="true" class="my-0.5 h-px w-5" style="background:var(--shell-hairline-strong)"></div>'; };

/* ThreadSidebarV2Header / SidebarViewBarV2 / ThreadItem / ThreadRowSignals. */
PDL_COMPONENTS.v2Sidebar = function (p, sc, root) {
  const q = pvDeep(p.state, root, sc);
  return '<aside class="v2-sidebar flex min-h-0 flex-col" data-okey="nav"' + (q.hidden ? ' hidden' : '') + ' aria-label="' + pvText(p.label, sc, root) + '"><div data-testid="sidebar-v2-header"><div class="flex h-[52px] flex-none items-center gap-0.5 pl-[18px] pr-2.5 nav-head"><h2 class="m-0 min-w-0 flex-1 truncate text-sm font-semibold" style="color:var(--shell-ink)">' + pvText(p.title, sc, root) + '</h2>' + pvBlocks(p.actions, sc, root) + '</div><nav class="px-2.5 pb-2" aria-label="' + pvText(p.label, sc, root) + '">' + pvBlocks(p.navigation, sc, root) + '</nav></div><div class="sticky top-0 z-10 flex items-center gap-1 px-3 py-1.5" style="background:var(--shell-frame)" data-testid="sidebar-tabs-row">' + pvBlocks(p.filters, sc, root) + '</div><div class="flex items-center justify-between px-3 py-3 text-label text-cafe-muted"><span>' + pvText(p.count, sc, root) + '</span>' + pvBlocks(p.locate, sc, root) + '</div><div class="min-h-0 flex-1 overflow-y-auto" id="cafe-nav-scroll">' + pvBlocks(p.body, sc, root) + '</div><div class="mx-2 mt-1 mb-2">' + pvBlocks(p.foot, sc, root) + '</div><div class="v2-resize" data-resize="nav" data-side="end"></div></aside>';
};
PDL_COMPONENTS.v2Filter = function (p, sc, root) {
  const menu = menuLive(rowMenuItems(p.menu, sc, root));
  return '<button type="button" class="shell-rail-item shell-focusable inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded-lg px-2 text-xs" style="color:var(--shell-body)' + (p.selected ? ';background:var(--shell-selected)' : '') + '"' + actAttrs('menu', { menu: menu }) + MENU_DECL + '><span class="shrink-0">' + pvText(p.label, sc, root) + '</span><span class="truncate" style="color:var(--shell-ink)">' + pvText(p.value, sc, root) + '</span>' + (p.selected ? v2Glyph('chevronDown', 'h-3 w-3') : '') + '</button>';
};
PDL_COMPONENTS.v2ThreadRow = function (p, sc, root) {
  const q = pvDeep(p, root, sc), v = q.data;
  if (v.renaming) return '<form class="mx-2 px-3 py-1.5" data-form="' + h(q.rename.form) + '"><input class="h-5 w-full rounded border border-cafe-subtle px-1.5 text-sm" id="row-rename" value="' + h(v.title) + '" data-path="' + h(q.rename.path) + '" data-on-blur="' + h(q.rename.blur) + '" data-on-esc="close"></form>';
  return '<div class="group relative mx-2 rounded-lg px-3 py-1.5 transition-colors cursor-pointer v2-thread-row" data-tid="' + h(v.id) + '"' + actAttrs(q.open.act, q.open.args) + (v.cur ? ' aria-current="page" style="background:var(--shell-selected)"' : '') + '><div class="flex justify-between gap-1 min-h-5 items-start"><span class="flex min-w-0 flex-1 items-center gap-1"><button class="inline-flex h-5 w-4 flex-none items-center justify-center" style="color:' + (v.pinned ? 'var(--shell-primary)' : 'var(--shell-muted)') + '"' + actAttrs(q.pin.act, q.pin.args) + ' aria-label="' + h(q.pin.label) + '">' + (v.pinned ? v2Glyph('pin', 'h-3 w-3 shrink-0') : '') + '</button><span class="min-w-0 flex-1 line-clamp-2 break-words text-sm leading-5 shell-focusable rounded-sm ' + (v.unread || v.at || v.failed ? 'font-semibold' : 'font-normal') + '" style="color:var(--shell-ink)">' + h(v.title) + '</span></span><div class="flex items-center gap-0.5 flex-shrink-0">' + pvBlocks(p.more, sc, root) + '<span class="order-last text-label leading-5 tabular-nums" style="color:var(--shell-muted)">' + h(typeof v.time === 'number' ? FORMATS.ago(v.time) : v.time) + '</span></div></div>' + pvBlocks(p.signals, sc, root) + '</div>';
};
PDL_COMPONENTS.v2ThreadSignals = function (p, sc, root) {
  const q = pvDeep(p, root, sc);
  return '<div class="flex min-w-0 items-center justify-between"><div class="flex min-w-0 items-center gap-1"><div class="flex min-w-0 items-center gap-1 overflow-x-clip overflow-y-visible px-0.5">' + q.participants.map(function (w) { return v2Avatar(w, 16); }).join('') + '</div><span class="flex min-w-0 shrink items-center whitespace-nowrap text-label" style="color:' + (q.error ? 'var(--semantic-critical)' : q.running ? 'var(--semantic-info)' : 'var(--semantic-success)') + '">' + (q.replied && !q.running && !q.error ? ("<span class=\"inline-flex flex-none items-center gap-1\"><span class=\"inline-block h-4 flex-none font-normal leading-4\">"+h(tc("v2f.copy.w001"))+"</span><svg class=\"h-3 w-3 shrink-0\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"var(--semantic-success)\" stroke-width=\"2\"><path d=\"m3 8 3 3 7-7\"/></svg></span>") : '') + '<span class="min-w-0 overflow-hidden"><span class="inline-block whitespace-nowrap pl-1">' + h(q.status) + '</span></span></span>' + (q.unread ? '<span class="rounded px-1 text-label" style="background:var(--shell-primary-soft);color:var(--shell-primary-text)">' + h(q.unreadLabel) + '</span>' : '') + '</div></div>';
};
PDL_COMPONENTS.v2Threads = function (p, sc, root) {
  return pvList(p.from, sc, root).map(function draw(s) {
    if (s.other) return s.other.open ? s.other.sections.map(draw).join('') : '';
    const hd = s.head, isRecent = hd.kind === 'sec', show = !isRecent && !s.collapsed;
    const head = isRecent ? '' : '<button class="flex w-full items-center gap-2 px-5 py-2 text-xs"' + actAttrs(hd.kind === 'group' ? 'setStatus' : 'fold', hd.kind === 'group' ? { entity: 'group', id: hd.id, field: 'open' } : { f: 'sec', k: s.key }) + '>' + h(hd.name) + '<span class="ml-auto">' + h(hd.n) + '</span>' + v2Glyph('chevronDown', 'h-3 w-3') + '</button>';
    const rows = isRecent || show ? s.rows : s.peek;
    return '<section data-section="' + h(s.key) + '">' + head + (rows || []).map(function (v) { return PDL_COMPONENTS.v2ThreadRow(Object.assign({}, p.row, { data: { lit: v } }), v, root); }).join('') + '</section>';
  }).join('');
};

/* NewConversationPage + LandingHeader. */
PDL_COMPONENTS.v2Home = function (p, sc, root) {
  return '<main class="relative min-h-0 flex-1 overflow-y-auto bg-[var(--shell-work)]" data-testid="new-conversation-page" data-artwork="night"><div class="relative h-[clamp(360px,52vh,500px)] min-h-[360px] overflow-hidden"><img src="' + h(asset(p.artwork)) + '" alt="" class="object-cover object-center" style="position:absolute;height:100%;width:100%;inset:0" draggable="false"><div class="absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-black/40 to-transparent"></div><div class="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-[var(--shell-work)]"></div><header class="safe-area-top absolute inset-x-0 top-0 z-20"><div class="flex h-[52px] items-center gap-2 px-3 text-white sm:px-6">' + pvBlocks(p.header, sc, root) + '</div></header><div class="absolute inset-x-4 top-[88px] z-10 text-center text-white sm:top-[92px]"><h1 class="text-3xl font-normal tracking-wide drop-shadow-[0_2px_14px_rgba(20,12,40,0.45)] sm:text-4xl" style="font-family:var(--evolution-title-font)"><span class="max-sm:block">' + pvText(p.headline, sc, root) + '</span><span>' + pvText(p.headlineRest, sc, root) + '</span></h1><p class="mt-3 text-sm text-white/85 drop-shadow-[0_1px_8px_rgba(20,12,40,0.45)] sm:text-reading">' + pvText(p.subtitle, sc, root) + '</p></div></div><div class="relative z-10 mx-auto -mt-10 w-full max-w-[752px] px-4 pb-16 sm:px-4">' + pvBlocks(p.composer, sc, root) + pvBlocks(p.connect, sc, root) + '<div class="mt-5 flex flex-wrap items-center justify-center gap-3">' + pvBlocks(p.demo, sc, root) + '</div><div class="mt-8">' + pvBlocks(p.works, sc, root) + '</div></div></main>';
};
PDL_COMPONENTS.v2Grow = function () { return '<span class="flex-1"></span>'; };
PDL_COMPONENTS.v2Import = function (p, sc, root) { return '<div class="relative mx-4 mt-3">' + pvBlocks(p.blocks, sc, root) + '</div>'; };
PDL_COMPONENTS.v2RecentWorks = function (p, sc, root) {
  return '<section class="recent-works-gallery" data-testid="recent-works"><div class="mb-3 flex items-center gap-3 px-0.5 text-xs text-[var(--shell-muted)]"><h2 class="font-normal">' + pvText(p.title, sc, root) + '</h2><span class="ml-auto">' + pvBlocks(p.all, sc, root) + '</span></div>' + pvBlocks(p.blocks, sc, root) + '</section>';
};
PDL_COMPONENTS.v2StatusText = function (p, sc, root) { return '<output class="' + (p.small ? 'text-xs text-cafe-muted' : '') + '">' + pvText(p.text, sc, root) + '</output>'; };

/* ChatContainerHeader, HeaderFrame, ConversationViewMenu, HeaderCounts. */
PDL_COMPONENTS.v2Header = function (p, sc, root) {
  return '<header class="safe-area-top" style="background:var(--shell-work);border-bottom:1px solid var(--shell-hairline)" data-shell-header="v2"><div class="cafe-header shell-chat-header-layout cafe-header-inner flex h-[52px] items-center gap-1 pl-3 pr-2 sm:gap-1.5 sm:pl-6 sm:pr-3.5"><div class="shell-chat-header-navigation flex min-w-0 flex-1 items-center gap-1 sm:gap-1.5">' + pvBlocks(p.navigation, sc, root) + '</div><div class="shell-chat-header-actions flex flex-none flex-wrap items-center justify-end gap-1 sm:gap-1.5">' + pvBlocks(p.actions, sc, root) + '</div></div></header>';
};
PDL_COMPONENTS.v2ThreadTitle = function (p, sc, root) { return '<div class="flex min-w-0 flex-1 items-center gap-2"><button class="min-w-0 truncate text-left text-compact font-medium text-cafe-secondary"' + actAttrs(p.act, pvArgsObj(p.args, sc, root)) + ' data-tip="' + pvText(p.title, sc, root) + '">' + pvText(p.title, sc, root) + '</button></div>'; };
PDL_COMPONENTS.v2ConversationView = function (p, sc, root) {
  return '<div class="relative flex-none" data-testid="conversation-view-control"><button class="shell-rail-item shell-focusable inline-flex h-8 max-w-[12rem] items-center gap-1.5 rounded-lg px-2 text-xs"' + actAttrs(p.act, pvArgsObj(p.args, sc, root)) + '><span class="flex -space-x-1">' + pvList(p.people, sc, root).map(function (w) { return v2Avatar(w, 20); }).join('') + '</span><span>' + pvText(p.label, sc, root) + '</span>' + v2Glyph('chevronDown', 'h-3 w-3') + '</button></div>';
};
PDL_COMPONENTS.v2ChatPage = function (p, sc, root) {
  return '<div class="v2-conversation">' + pvBlocks(p.head, sc, root) + '<div class="flex min-h-0 flex-1 flex-col [--thread-chat-inset-start:1rem] [--thread-chat-inset-end:4.5rem]" data-thread-chat-surface data-thread-chat-full-v2><div class="relative min-h-0 flex-1 overflow-hidden flex flex-col" data-thread-chat-history><main id="stream" class="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none] py-4 pl-[var(--thread-chat-inset-start)] pr-[var(--thread-chat-inset-end)] scroll stick-end" data-chat-container><div data-thread-chat-reading-column class="mx-auto w-full max-w-[720px]">' + pvBlocks(p.top, sc, root) + pvBlocks(p.body, sc, root) + '</div></main>' + pvBlocks(p.side, sc, root) + '</div><div class="[padding-inline-end:calc(var(--thread-chat-inset-end)-var(--thread-chat-inset-start))]" data-thread-chat-footer><div class="mx-auto w-full max-w-[752px]">' + pvBlocks(p.dock, sc, root) + '</div></div></div></div>';
};

/* ChatInput / ComposerFrame / NewConversationComposerContext / ChatComposerActions. */
PDL_COMPONENTS.v2Composer = function (p, sc, root) {
  const home = !!pv(p.home, sc, root), field = home ? 'row-start-2' : 'row-start-1', control = home ? 'row-start-3' : 'row-start-2';
  return '<div class="relative safe-area-bottom bg-[var(--shell-work)] typing-scope" data-key="composer"><div class="cafe-composer-surface relative mx-4 mb-4 mt-2 grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 px-3 pb-2 pt-2" data-testid="chat-input-composer-row" data-composer-presentation="v2">' + pvBlocks(p.header, sc, root) + '<div class="relative col-span-3 col-start-1 min-w-0 ' + field + '">' + pvBlocks(p.field, sc, root) + '</div><div class="col-start-1 ' + control + '">' + pvBlocks(p.add, sc, root) + '</div><div class="col-start-2 flex min-w-0 items-center gap-1 border-l border-[var(--shell-hairline)] pl-2 ' + control + '" data-testid="chat-composer-context">' + pvBlocks(p.context, sc, root) + '</div><div class="col-start-3 flex shrink-0 items-center gap-1 ' + control + '">' + pvBlocks(p.actions, sc, root) + '</div></div></div>';
};
PDL_COMPONENTS.v2ComposerTitle = function (p, sc, root) { return '<div class="col-span-3 col-start-1 row-start-1 -mx-2 -mt-2 border-b border-[var(--shell-hairline)] px-3 py-1.5" data-testid="chat-composer-header"><label class="block"><input type="text" maxlength="200" data-input="' + h(p.input) + '" value="' + pvText(p.value, sc, root) + '" aria-label="' + pvText(p.label, sc, root) + '" placeholder="' + pvText(p.label, sc, root) + '" class="block h-8 w-full border-0 bg-transparent px-1 text-sm text-[var(--shell-ink)] outline-none placeholder:text-[var(--shell-muted)]"></label></div>'; };
PDL_COMPONENTS.v2ComposeField = function (p, sc, root) {
  const q = pvDeep(p, root, sc); TA_COMPLETE[q.id] = q.complete;
  return '<textarea class="shell-focusable block min-h-[32px] w-full resize-none rounded-lg border-0 bg-transparent px-1 py-1 text-sm leading-6 text-[var(--shell-ink)] placeholder:text-[var(--shell-muted)]" rows="1" data-grow id="' + h(q.id) + '" data-input="' + h(q.input) + '"' + argAttrs(q.args) + onAttrs(q.on) + (q.disabled ? ' disabled' : '') + ' aria-label="' + h(q.label) + '" placeholder="' + h(q.placeholder) + '">' + h(q.value) + '</textarea>';
};
PDL_COMPONENTS.v2PinCheck = function (p, sc, root) {
  return '<label class="shell-focusable flex h-8 flex-none items-center gap-1.5 rounded-lg px-1.5 text-xs text-[var(--shell-muted)] cursor-pointer"><input type="checkbox" class="shell-focusable h-3.5 w-3.5 flex-none accent-[var(--shell-ink)]"' + actAttrs(p.act, pvArgsObj(p.args, sc, root)) + (pv(p.value, sc, root) ? ' checked' : '') + '><span class="whitespace-nowrap">' + pvText(p.label, sc, root) + '</span></label>';
};
PDL_COMPONENTS.v2RoutingPreview = function (p, sc, root) {
  const q = pvDeep(p, root, sc);
  return '<span class="v2-routing-root"><button class="shell-focusable shell-rail-item flex h-8 min-w-0 items-center gap-1 rounded-lg px-1.5 text-xs text-[var(--shell-muted)]" data-testid="composer-routing-preview"' + actAttrs(q.act, q.args) + '><span class="shrink-0 whitespace-nowrap">' + h(q.label) + '</span><span class="flex shrink-0 -space-x-1">' + v2Avatar(q.who, 16) + '</span><span class="truncate whitespace-nowrap text-[var(--shell-ink-soft)]">' + h(q.name) + '</span>' + v2Glyph('chevronDown', 'h-3 w-3') + '</button></span>';
};

/* ChatMessage / MessageBubble / CatNameplate / ReplyPill / ReplyLastLine. */
PDL_COMPONENTS.v2Nameplate = function (p, sc, root) {
  const q = pvDeep(p, root, sc), w = whoInfo(q.from), paint = v2IdentityPaint(w);
  return '<span data-testid="cat-nameplate" data-cat-id="' + h(w.id) + '" class="cafe-nameplate" style="background-image:linear-gradient(to bottom,' + paint.surface + ',transparent)"><span class="cafe-nameplate-avatar">' + v2Avatar(q.from, 32) + '</span><button class="cafe-nameplate-name" style="color:oklch(var(--cat-name-l,.15) var(--cat-name-c,.025) var(--cat-name-h,5))" data-hover="memberCard" data-who="' + h(w.id) + '"' + actAttrs(q.act, { who: w.id }) + '>' + h(w.name) + '</button></span>';
};
PDL_COMPONENTS.v2Quote = function (p, sc, root) {
  const q = pvDeep(p, root, sc);
  return '<div class="mb-1 flex min-w-0"><button class="v2-reply-pill inline-flex min-w-0 gap-1 text-left font-medium px-1.5 py-0.5 cursor-pointer hover:opacity-80 transition-opacity text-micro items-center rounded-full whitespace-nowrap max-w-[200px]"' + actAttrs(q.act, q.args) + '>' + '<span class="shrink-0">' + icon('jump', 12) + '</span>' + (q.from ? v2Avatar(q.from, 12) : '') + '<span class="min-w-0 truncate">' + (q.from ? h(whoInfo(q.from).name) + ': ' : '') + h(q.text) + '</span></button></div>';
};
PDL_COMPONENTS.v2Message = function (p, sc, root) {
  const q = pvDeep(p.data, root, sc), w = whoInfo(q.from), mid = q.mid;
  if (typeof q.time === 'number') q.time = FORMATS.stamp(q.time); if (q.at) q.time = FORMATS.day(q.at);
  const attrs = ' data-mid="' + h(mid) + '" data-message-id="' + h(mid) + '"';
  if (q.frame === 'day') return '<div class="my-3 text-center text-xs text-cafe-muted"' + attrs + '>' + h(q.time) + '</div>';
  if (q.frame === 'system') return '<div class="group flex justify-center mb-3"' + attrs + '><div class="max-w-[85%] text-sm text-cafe-secondary">' + h(q.title) + (q.html || '') + '</div></div>';
  const human = q.frame === 'human';
  const header = human ? '' : '<div class="mb-1 flex flex-col gap-1 min-w-0" data-testid="message-header"><div class="flex flex-wrap items-center gap-x-2 gap-y-4 min-w-0" data-message-author-row>' + pvBlocks(p.author, sc, root) + '<span class="text-xs shrink-0" style="color:var(--shell-muted)">' + h(q.time) + '</span></div></div>';
  const body = '<div class="markdown-content text-sm [&.markdown-content]:text-reading [&_p]:leading-[inherit] [&_li]:leading-[inherit]">' + (q.html || '') + '</div>' + pvBlocks(p.body, sc, root);
  return '<div' + attrs + ' class="flex mb-4 scroll-mt-1.5 items-start' + (human ? ' justify-end' : '') + '"><div class="' + (human ? 'max-w-[80%] min-w-0 flex flex-col items-end' : 'max-w-full min-w-0') + '">' + header + pvBlocks(p.quote, sc, root) + '<div data-testid="message-bubble"' + (human ? ' data-chat-background-surface="human" class="rounded-xl px-3.5 py-2 text-left min-w-0 max-w-full overflow-hidden" style="background:' + v2IdentityPaint(w).surface + '"' : ' data-reply-color-rail="true" style="border-left:3px solid ' + v2IdentityPaint(w).primary + ';padding-left:16px"') + '>' + body + (human ? '<div class="mt-1 flex justify-end text-xs text-cafe-muted">' + h(q.time) + '</div>' : '') + pvBlocks(p.footer, sc, root) + '</div></div></div>';
};
PDL_COMPONENTS.v2ReplyLastLine = function (p, sc, root) {
  return '<div data-testid="reply-layers" class="mt-1 flex min-w-0 flex-col gap-1 empty:hidden"><div data-testid="reply-last-line" class="flex h-[22px] min-w-0 items-center gap-1.5 whitespace-nowrap text-xs" style="color:var(--shell-muted)">' + pvBlocks(p.blocks, sc, root) + '</div></div>';
};
PDL_COMPONENTS.v2InlineAction = function (p, sc, root) { return '<button class="inline-flex flex-none items-center gap-0.5 rounded hover:underline"' + actAttrs(p.act, pvArgsObj(p.args, sc, root)) + '>' + (p.icon ? v2Glyph(p.icon, 'h-3 w-3') : '') + pvText(p.label, sc, root) + '</button>'; };
PDL_COMPONENTS.v2DotSeparator = function () { return '<span class="flex-none" style="opacity:.6">·</span>'; };
PDL_COMPONENTS.v2Stream = function (p, sc, root) {
  return '<div data-stream="chat" data-own="stream">' + unitsHtml('stream:chat', pvList(p.from, sc, root), streamUnitKey, function (it, r) { if(p.item)return PDL_COMPONENTS.v2Message(p.item,it,r);const t=pdlTyped(p.slot||'chat.node',it.kind);return t?v2Node(t,it,r):''; }, root) + '</div>';
};
PDL_COMPONENTS.v2Progress = function (p, sc, root) {
  const xs = pvList(p.from, sc, root);
  return '<div class="absolute right-0.5 top-2 bottom-2 z-10 w-6 outline-none ' + (xs.length ? 'cursor-pointer' : 'invisible pointer-events-none') + '" data-message-navigator data-message-piano data-v2-progress>' + xs.map(function (it, i) {
    const q = pvDeep(p.item, root, it), w = whoInfo(q.from);
    return '<button class="absolute right-2 z-10" style="top:' + (i / xs.length * 100) + '%;height:calc(' + (100 / xs.length) + '% - 2px);width:6px;background:' + (q.error ? 'var(--semantic-critical)' : w.kind === 'member' ? v2IdentityPaint(w).primary : 'var(--cafe-text-muted)') + '" data-message-piano-key="' + h(q.mid) + '"' + actAttrs(q.act, { mid: q.mid }) + ' data-tip="' + h(q.label) + '"></button>';
  }).join('') + '<div data-message-piano-thumb class="absolute right-0.5 z-20 cursor-grab touch-none border border-[var(--cafe-text)] rounded-sm"></div></div>';
};
/* Geometry is painted from the existing stream; no page-specific reads or app state. */
onRender(function () {
  const stream = document.getElementById('stream'), track = document.querySelector('[data-v2-progress]');
  if (!stream || !track) return;
  const keys = track.querySelectorAll('[data-message-piano-key]'), messages = stream.querySelectorAll('[data-message-id]');
  const paint = function () {
    const total = stream.scrollHeight, height = track.clientHeight, top = stream.getBoundingClientRect().top, offset = total - stream.clientHeight + stream.scrollTop;
    keys.forEach(function (key) { const msg = Array.from(messages).find(function (m) { return m.dataset.messageId === key.dataset.messagePianoKey; }); if (!msg) return; key.style.top = (msg.getBoundingClientRect().top - top + offset) / total * height + 'px'; key.style.height = Math.max(2, msg.offsetHeight / total * height - 2) + 'px'; });
    const thumb = track.querySelector('[data-message-piano-thumb]'); thumb.style.top = offset / total * height + 'px'; thumb.style.height = Math.max(18, stream.clientHeight / total * height) + 'px'; thumb.style.width = '16px';
  };
  stream.onscroll = paint;
  track.onpointerdown = function (e) {
    if (!e.target.closest('[data-message-piano-thumb]')) return;
    e.preventDefault(); const start=e.clientY, offset=stream.scrollTop, range=stream.scrollHeight-stream.clientHeight;
    track.setPointerCapture(e.pointerId);
    track.onpointermove=function (move) { streamScrollTo(Math.max(-range,Math.min(0,offset+(move.clientY-start)/track.clientHeight*stream.scrollHeight))); };
    track.onpointerup=function () { track.onpointermove=null; track.onpointerup=null; };
  };
  paint();
});

/* V2WorkbenchChrome / V2WorkbenchTabStrip. Region mechanics stay in the engine. */
/* V2WorkbenchTab is a separate drawing in the old UI. */
PDL_COMPONENTS.v2WorkbenchTab = function (p) {
  const r=p.region,t=p.tab,title=REGION_TABS[r].title(t.k),active=navTabCur(r)===t.k;
  return '<div class="group flex min-w-0 items-center rounded-md border max-w-[150px] shrink-0 '+(active?'border-[var(--shell-hairline-strong)] bg-cafe-surface-sunken text-cafe':'border-transparent text-cafe-muted')+'"><button class="min-w-0 flex-1 px-1 py-2 text-left text-xs" data-act="tab" data-op="show" data-r="'+r+'" data-k="'+h(t.k)+'"><span class="block truncate">'+h(title)+'</span></button><button class="h-7 w-5 shrink-0 rounded" data-act="tab" data-op="close" data-r="'+r+'" data-k="'+h(t.k)+'">×</button></div>';
};
PDL_COMPONENTS.v2WorkbenchTabStrip = function (p) {
  const r=p.region,home=rtCfg(r).home,atHome=navTabCur(r)===home.key;
  return '<div class="flex min-w-[144px] flex-1 items-center gap-1"><div class="flex min-w-0 flex-1 items-center" role="tablist"><div class="flex shrink-0 items-center rounded-md border '+(atHome?'border-[var(--shell-hairline-strong)] bg-cafe-surface-sunken text-cafe':'border-transparent text-cafe-muted')+'"><button class="flex h-8 items-center gap-1 px-2 text-xs" data-act="tab" data-op="show" data-r="'+r+'" data-k="'+home.key+'">'+v2Glyph('home','h-3 w-3')+h(home.label)+'</button></div>'+rtShownTabs(r).map(function (t) { return PDL_COMPONENTS.v2WorkbenchTab({region:r,tab:t}); }).join('')+'</div></div>';
};
function rtChrome(r) {
  const c=rtCfg(r),data=rtVM(r);
  return '<header data-testid="v2-workspace-chrome" data-v2-workspace-menu-boundary class="relative z-30 flex min-h-11 min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-cafe-subtle bg-cafe-surface px-2 py-1">'+PDL_COMPONENTS.v2WorkbenchTabStrip({region:r})+'<div class="flex shrink-0 items-center">'+pvBlocks(c.actions,data,data)+'</div></header>';
}

function rtFocusHead() { return ''; }
function panelHtml() {
  const r = 'panel', b = REGION_TABS[r];
  if (!b.exists(navTabCur(r))) rtShow(r, rtHome(r));
  rtSplitSync(r); rtEnsure(r, navTabCur(r)); if (b.before) b.before();
  return ("<aside class=\"panel ws v2-workbench\" data-okey=\"panel\" data-c=\"panel\" aria-label=\""+h(tc("v2f.copy.w002"))+"\"><div class=\"v2-resize\" data-resize=\"panel\" data-side=\"start\"></div>") + rtChrome(r) + rtPanes(r) + '</aside>';
}
PDL_COMPONENTS.v2WorkspaceHome = function (p, sc, root) { return '<div class="home-v2 min-h-0 flex-1 overflow-y-auto" data-testid="f307-workspace-home-page" data-home-presentation="v2"><div class="home-column" data-workspace-home-content>' + pvBlocks(p.blocks, sc, root) + '</div></div>'; };
PDL_COMPONENTS.v2HomeLive = function (p, sc, root) { return '<section class="home-section" data-testid="workspace-developing"><header class="home-card-head"><span class="home-dot" data-tone="live"></span><h2 class="home-card-title text-sm">' + pvText(p.title, sc, root) + '</h2><span class="text-xs text-cafe-muted">' + pvText(p.count, sc, root) + '</span></header>' + pvBlocks(p.blocks, sc, root) + '</section>'; };
PDL_COMPONENTS.v2ConversationScope = function (p, sc, root) { return '<div class="home-conversation-scope text-xs"><b>' + pvText(p.label, sc, root) + '</b><span>' + pvText(p.title, sc, root) + '</span></div>'; };
PDL_COMPONENTS.v2HomeSection = function (p, sc, root) { return '<section class="home-section"><header class="home-card-head">' + v2Glyph(p.icon, 'home-section-icon') + '<h2 class="home-card-title text-sm">' + pvText(p.title, sc, root) + '</h2>' + (p.count ? '<span class="text-xs text-cafe-muted">' + pvText(p.count, sc, root) + '</span>' : '') + pvBlocks(p.all, sc, root) + '</header>' + pvBlocks(p.blocks, sc, root) + '</section>'; };
PDL_COMPONENTS.v2HomeStatus = function (p, sc, root) {
  return pvList(p.from, sc, root).slice(0, 1).map(function (it) { const q = pvDeep(p.item, root, it); return '<button class="home-status-summary home-live-row shell-focusable"' + actAttrs(q.act, q.args) + '><span class="home-live-main home-live-link"><span class="home-live-heading">' + v2Avatar(q.who, 20) + '<span class="home-live-name text-compact">' + h(whoInfo(q.who).name) + '</span><span class="home-live-status text-xs" data-tone="live">' + h(q.status) + '</span></span><span class="home-live-sub text-xs">' + h(q.session) + '</span></span><span class="home-trajectory">›</span></button>'; }).join('');
};
/* WorkGalleryCard / WorkPreview / WorkPaperPreview, including the compact Home card. */
function v2WorkPreview(q, compact) {
  if (q.kind === 'image') return !compact && q.source ? '<img src="' + h(q.source) + '" alt="' + h(q.title) + '">' : '<span class="work-gallery-kind">' + v2Glyph('filePen', 'h-7 w-7') + '<span>' + h(q.type) + '</span></span>';
  if (q.kind === 'audio') return '<span class="work-cover work-cover-audio"><span class="work-cover-wave" aria-hidden="true">' + [10,18,28,16,38,46,32,20,40,29,14,33,42,24,12,22,34,17].map(function (height) { return '<i style="height:' + height + 'px"></i>'; }).join('') + '</span><span class="work-cover-badge">' + h(q.type) + '</span></span>';
  if (q.kind === 'video') return '<span class="work-cover work-cover-video"><span class="work-cover-play">' + v2Glyph('play', 'h-5 w-5') + '</span><span class="work-cover-badge work-cover-video-badge">' + h(q.type) + '</span></span>';
  const ext = q.title.split('.').pop().toLowerCase(), office = { pdf:['PDF','PDF'],doc:['Word','W'],docx:['Word','W'],xls:['Excel','X'],xlsx:['Excel','X'],ppt:['PPT','P'],pptx:['PPT','P'] }[ext];
  const kind = q.kind === 'pr' || q.kind === 'code' ? q.kind : /^pptx?$/.test(ext) ? 'slide' : q.kind === 'widget' || /^html?$/.test(ext) ? 'layout' : 'document', layout = kind === 'layout' || kind === 'slide';
  const bars = function (count) { return ['88%','70%','80%','58%','76%','52%'].slice(0,count).map(function (w,i) { return '<span class="work-cover-bar" style="width:' + w + (kind === 'code' ? ';margin-left:' + i % 3 * 8 + 'px' : '') + '"></span>'; }).join(''); };
  const pr = kind === 'pr' && /^([^/]+\/[^#]+)#(\d+)$/.exec(q.title);
  const content = layout ? '<span class="work-cover-bar work-cover-heading"></span><span class="work-cover-panels"><i></i><i></i>' + (kind === 'layout' ? '<i></i>' : '') + '</span>' + (kind === 'layout' ? bars(3) : '') : '<span class="work-cover-paper-text">' + (pr ? '<strong class="work-cover-pr-number">#' + h(pr[2]) + '</strong><span class="work-cover-pr-repo">' + h(pr[1]) + '</span>' + bars(3) : '<span class="work-cover-bar work-cover-heading"></span>' + bars(6)) + '</span>';
  return '<span class="work-cover work-cover-' + kind + '">' + (kind === 'document' ? '<span class="work-cover-paper work-cover-paper-back" aria-hidden="true"></span>' : '') + '<span class="work-cover-paper ' + (kind === 'slide' ? 'work-cover-slide-paper' : '') + '">' + content + '</span><span class="work-cover-badge">' + (office ? '<b class="work-cover-office work-cover-office-' + office[0].toLowerCase() + '">' + office[1] + '</b>' : v2Glyph(kind === 'pr' ? 'gitPr' : 'file', 'h-3 w-3')) + h(office ? office[0] : q.type) + '</span></span>';
}
PDL_COMPONENTS.v2WorkCards = function (p, sc, root) {
  const catalogue = !!p.catalogue, list = pv(p.layout, sc, root) === 'list', xs = pvList(p.from, sc, root);
  return '<div class="' + (catalogue ? (list ? 'flex flex-col gap-3' : 'v2-works-grid') : p.recent ? 'recent-works-grid' : 'home-works') + '">' + (catalogue ? xs : xs.slice(0, 3)).map(function (it, i) {
    const q = pvDeep(p.item, root, it), compact = catalogue ? list : !p.recent && (i > 0 || q.kind !== 'image' || !q.source), metadata = (q.author || q.unknownAuthor) + ' · ' + (typeof q.at === 'number' ? FORMATS.stamp(q.at) : q.at), menu = p.menu ? menuLive(rowMenuItems(p.menu, it, root)) : null;
    return '<div class="home-work-entry"' + (catalogue ? ' data-work-anchor="' + h(q.id) + '"' : '') + '><article class="work-gallery-card cafe-presentation"><button type="button" class="work-gallery-open shell-focusable' + (compact ? ' home-work-summary' : '') + '"' + actAttrs(q.act, q.args) + (catalogue ? ' data-testid="workspace-home-artifact-card" data-home-artifact-id="' + h(q.id) + '"' : '') + '><span class="work-gallery-visual">' + v2WorkPreview(q, compact) + '</span><span class="work-gallery-title' + (compact ? ' home-work-label' : '') + '" title="' + h(q.title) + '">' + h(q.title) + '</span></button><div class="work-gallery-footer"><small class="' + (compact ? 'home-work-meta' : '') + '">' + h(metadata) + '</small>' + (q.openSource ? '<button type="button" class="work-gallery-source shell-focusable" aria-label="' + h(q.openSource.label) + '" title="' + h(q.openSource.label) + '"' + actAttrs(q.openSource.act, q.openSource.args) + '>' + icon('jump', 12) + '</button>' : '') + '</div>' + (menu ? '<div class="work-gallery-actions"><button type="button" class="artwork-actions_trigger__8FB9l" aria-label="' + pvText(p.moreLabel, sc, root) + '" aria-haspopup="menu"' + actAttrs('menu', { menu: menu }) + MENU_DECL + '>⋯</button></div>' : '') + '</article></div>';
  }).join('') + '</div>';
};

/* ThreadWorksPanelV2: the workbench owns the tab; this section owns its catalogue. */
PDL_COMPONENTS.v2WorksPanel = function (p, sc, root) {
  const search = pvDeep(p.search, root, sc), filter = pvDeep(p.filter, root, sc);
  const options = pvList(filter.from, sc, root).map(function (it) { return pvDeep(p.filter.item, root, it); });
  return '<section class="v2-works-panel" data-testid="v2-works-panel"><header class="v2-works-header"><div class="v2-works-topline"><h2 class="text-sm font-semibold">' + pvText(p.title, sc, root) + '</h2><span class="v2-works-count text-xs text-cafe-muted">' + pvText(p.count, sc, root) + '</span>' + pvBlocks(p.scope, sc, root) + '</div><div class="v2-works-tools"><input class="v2-works-search shell-focusable"' + v2NativeAttrs(p.search, sc, root) + ' value="' + h(search.value) + '" placeholder="' + h(search.label) + '">' + pvBlocks(p.display, sc, root) + '<select class="v2-works-type shell-focusable" aria-label="' + h(filter.label) + '" data-v2-select-act="' + h(filter.act) + '"' + argAttrs(filter.args) + '>' + options.map(function (it) { return '<option value="' + h(it.value) + '"' + (it.active ? ' selected' : '') + '>' + h(it.label) + (it.count != null ? ' · ' + h(it.count) : '') + '</option>'; }).join('') + '</select></div>' + pvBlocks(p.status, sc, root) + '</header><div class="v2-works-scroll">' + pvBlocks(p.blocks, sc, root) + '</div></section>';
};
PDL_COMPONENTS.v2WorksSegments = function (p, sc, root) {
  const q = pvDeep(p, root, sc);
  return '<div class="v2-works-scope" role="group" aria-label="' + h(q.label) + '">' + q.options.map(function (it) { return '<button type="button" class="shell-focusable" aria-pressed="' + (q.value === it.value) + '"' + actAttrs(q.act, Object.assign({}, q.args, { v: it.value })) + '>' + h(it.label) + '</button>'; }).join('') + '</div>';
};
document.addEventListener('change', function (e) {
  const el = e.target;
  if (el.dataset.v2SelectAct) actFn(el.dataset.v2SelectAct)(Object.assign({}, actionArgs(el), { v: el.value }), el, e);
});

PDL_COMPONENTS.v2Each=function(p,sc,root){return pvList(p.from,sc,root).map(function(it){const x=p.item?Object.assign({},it,pvDeep(p.item,root,it)):it;return p.control?v2Controls(p.control,x,root):pvBlocks(p.blocks,x,root);}).join('');};

/* All visible menus use the v2 menu drawing, with the existing action/menu contract. */
function menuHtml(m){return '<div class="v2-menu rounded-lg border border-cafe-subtle bg-cafe-surface p-1 shadow-lg" id="menu" role="menu">'+(m.html||(m.q!=null?'<input class="mb-1 w-full rounded-lg bg-transparent px-3 py-2 text-sm outline-none" value="'+h(m.q)+'" data-input="menuQ" placeholder="'+h(tc('common.search'))+'">':'')+m.items.filter(function(it){return !m.q||!it.label||it.label.toLowerCase().indexOf(m.q.toLowerCase())>=0;}).map(function(it){if(it.scope!=null)return '<div class="px-3 py-1 text-xs text-cafe-muted">'+h(it.scope)+'</div>';if(it.label==null)return '<div class="my-1 border-t border-cafe-subtle"></div>';return '<div class="flex items-center gap-1"><button type="button" class="flex min-w-0 flex-1 items-center gap-2 rounded px-3 py-2 text-left text-sm '+(it.danger?'text-conn-red-text hover:bg-conn-red-bg':'text-cafe hover:bg-cafe-surface-sunken')+'" role="menuitem"'+actAttrs(it.act,Object.assign({},m.k!=null?{k:m.k}:{},typeof it.data==='object'?it.data:{}))+(typeof it.data==='string'?it.data:'')+(it.stay?' data-stay':'')+(it.why?' disabled data-tip="'+h(it.why)+'"':'')+'><span class="w-3 shrink-0">'+(it.cur?icon('check',12):'')+'</span>'+(it.icon?v2Glyph(it.icon):'')+'<span class="min-w-0 flex-1"><span class="block truncate">'+h(it.label)+'</span>'+(it.sub?'<span class="block text-xs text-cafe-muted">'+h(it.sub)+'</span>':'')+'</span></button>'+(it.x?PDL_COMPONENTS.v2Action({icon:'delete',iconOnly:true,label:it.x.label,act:it.x.act,args:it.x.args},{},{}):'')+'</div>';}).join(''))+'</div>';}









PDL_COMPONENTS.v2Surface = function (p, sc, root) {
  const body = pvBlocks(p.blocks, sc, root);
  return body ? '<div class="v2-surface" data-role="' + h(p.role) + '">' + body + '</div>' : '';
};



PDL_COMPONENTS.v2TitleInput = function (p, sc, root) { return '<input id="title-edit" class="min-w-0 flex-1 text-sm bg-transparent" data-path="s.renaming" data-on-enter="renameCommit" data-on-blur="renameCommit" data-on-esc="close" value="' + pvText(p.value, sc, root) + '">'; };
PDL_COMPONENTS.v2LiveRow = function (p, sc, root) {
  const q = pvDeep(p, root, sc);
  return '<button class="home-live-row shell-focusable"' + actAttrs(q.act, q.args) + '><span class="home-live-main"><span class="home-live-heading">' + v2Avatar(q.from, 20) + '<span class="home-live-name text-compact">' + h(whoInfo(q.from).name) + '</span><span class="home-live-status text-xs">' + h(q.status) + '</span></span><span class="home-live-sub text-xs">' + h(q.title) + '</span></span><span class="home-trajectory">›</span></button>';
};
/* The existing pane stack supplies projection/lifetimes; the old v2 has no default recent-tools strip. */
function rtHomeRecent() { return ''; }
/* Explicit theme-owned load surface: no inherited skeleton or default cards. */
PV_DRAW.viewLoad = function (v, st, root) { return '<output class="v2-load text-xs text-cafe-muted">' + h(pv(st === 'error' ? v.error : v.loading, root, root) || tc(st === 'error' ? 'v2a.error' : 'v2a.loading')) + '</output>' + pvBlocks(v.blocks, root, root); };
Object.keys(PDL_COMPONENTS).filter(function (k) { return k.indexOf('v2') === 0; }).forEach(function (k) { PDL_COMPONENTS[k].catalog = { g: 'structure', props: {} }; });

const V2_FONT_FACES = ["@font-face{font-display:block;font-family:KaTeX_AMS;font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_AMS-Regular-a79f1c31) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Caligraphic;font-style:normal;font-weight:700;src:var(--asset-v2-font-KaTeX_Caligraphic-Bold-ec17d132) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Caligraphic;font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_Caligraphic-Regular-55fac258) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Fraktur;font-style:normal;font-weight:700;src:var(--asset-v2-font-KaTeX_Fraktur-Bold-d42a5579) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Fraktur;font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_Fraktur-Regular-d3c882a6) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Main;font-style:normal;font-weight:700;src:var(--asset-v2-font-KaTeX_Main-Bold-c3fb5ac2) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Main;font-style:italic;font-weight:700;src:var(--asset-v2-font-KaTeX_Main-BoldItalic-6f2bb1df) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Main;font-style:italic;font-weight:400;src:var(--asset-v2-font-KaTeX_Main-Italic-8916142b) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Main;font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_Main-Regular-0462f03b) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Math;font-style:italic;font-weight:700;src:var(--asset-v2-font-KaTeX_Math-BoldItalic-572d331f) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Math;font-style:italic;font-weight:400;src:var(--asset-v2-font-KaTeX_Math-Italic-f28c23ac) format(\"woff2\")}", "@font-face{font-display:block;font-family:\"KaTeX_SansSerif\";font-style:normal;font-weight:700;src:var(--asset-v2-font-KaTeX_SansSerif-Bold-8c5b5494) format(\"woff2\")}", "@font-face{font-display:block;font-family:\"KaTeX_SansSerif\";font-style:italic;font-weight:400;src:var(--asset-v2-font-KaTeX_SansSerif-Italic-3b1e59b3) format(\"woff2\")}", "@font-face{font-display:block;font-family:\"KaTeX_SansSerif\";font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_SansSerif-Regular-ba21ed5f) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Script;font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_Script-Regular-03e9641d) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Size1;font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_Size1-Regular-eae34984) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Size2;font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_Size2-Regular-5916a24f) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Size3;font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_Size3-Regular-b4230e7e) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Size4;font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_Size4-Regular-10d95fd3) format(\"woff2\")}", "@font-face{font-display:block;font-family:KaTeX_Typewriter;font-style:normal;font-weight:400;src:var(--asset-v2-font-KaTeX_Typewriter-Regular-a8709e36) format(\"woff2\")}", "@font-face {\nfont-family: '__plusJakartaSans_a7e9e2';\nsrc: var(--asset-v2-font-636a5ac981f94f8b-s-p) format('woff2');\nfont-display: swap;\nfont-weight: 400 600;\n}", "@font-face {\nfont-family: '__fraunces_28de47';\nsrc: var(--asset-v2-font-0e73b73c476c88d2-s-p) format('woff2');\nfont-display: swap;\nfont-weight: 500;\n}"];
onStart('boot', function () { const style = document.createElement('style'); style.textContent = V2_FONT_FACES.map(function (face) { return face.replace(/var\(--asset-(v2-font-[^)]+)\)/g, function (_, key) { const id = Object.keys(ASSETS).find(function (id) { return id.replace(/\./g, '-') === key; }); return 'url("' + asset(id) + '")'; }); }).join('\n'); document.head.appendChild(style); });

/* App-formatted rich objects keep the old rich-block surfaces. */
PDL_COMPONENTS.v2Rich = function (p, sc, root) {
  /* 和默认主题的富内容一样：正文、键值、清单、作品、音频、文件、小组件、改动各自有才画，并列在同一张卡里（音频可以带一段文字，卡片可以没有字段） */
  const q = pv(p.data, sc, root);
  const title = q.title ? '<h4>' + h(q.title) + '</h4>' : '';
  const parts = [];
  if (q.markdown != null) parts.push('<div class="markdown-content text-sm">' + mdHtml(q.markdown) + '</div>');
  if (q.kv && q.kv.length) parts.push('<dl>' + q.kv.map(function (r) { return '<dt>' + h(r.k) + '</dt><dd>' + h(r.v) + '</dd>'; }).join('') + '</dl>');
  if (q.checks) parts.push('<div class="cafe-rich-checklist">' + q.checks.map(function (r) { return '<label><input type="checkbox" disabled' + (r.done ? ' checked' : '') + '>' + h(r.label) + '</label>'; }).join('') + '</div>');
  if (q.cards) parts.push('<div class="recent-works-grid">' + q.cards.items.map(function (r) { return '<button class="work-gallery-open"' + actAttrs(p.open.act,pvArgsObj(p.open.args,r,root)) + '><img src="' + h(r.src) + '" alt="' + h(r.alt) + '"><span>' + h(r.title) + '</span></button>'; }).join('') + '</div>');
  if (q.audio) parts.push('<audio controls src="' + h(q.audio.src) + '"></audio>');
  if (q.file) parts.push('<button class="flex items-center gap-2"' + actAttrs(p.open.act,pvArgsObj(p.open.args,q.file,root)) + '>' + v2Glyph('file') + h(q.file.name) + '</button>');
  if (q.widget) parts.push('<iframe class="cafe-rich-widget" sandbox="allow-scripts" srcdoc="' + h(q.widget.html) + '"></iframe>');
  if (q.diff) parts.push('<pre class="cafe-rich-diff">' + h(q.filePath) + '\n' + q.diff.hunks.map(function (r) { return h(r[0]) + '\n' + r[1].map(function (line) { return h(line[0] + line[1]); }).join('\n'); }).join('\n') + '</pre>');
  return parts.length ? '<section class="cafe-rich-card">' + title + parts.join('') + '</section>' : title;
};

/* ComposerPopover / ConversationViewOptions / SidebarFilterMenuV2. */
PDL_COMPONENTS.v2Popover = function (p, sc, root) { return '<div role="dialog" data-page="' + pvText(p.page,sc,root) + '" data-up="' + !!pv(p.up,sc,root) + '" class="v2-popover z-[70] flex flex-col overflow-y-auto overscroll-contain rounded-lg border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] p-1 text-[var(--shell-body)] shadow-lg">' + pvBlocks(p.blocks, sc, root) + '</div>'; };
PDL_COMPONENTS.v2MenuRow = function (p, sc, root) {
  const q = pvDeep(p, root, sc);
  return '<button class="shell-nav-row shell-focusable flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"' + actAttrs(q.act,q.args) + (q.attrs || '') + (q.selected ? ' aria-current="true"' : '') + '>' + (q.avatar ? v2Avatar(q.avatar,20) : q.icon ? v2Glyph(q.icon) : '') + '<span class="min-w-0 flex-1"><span class="block truncate">' + h(q.label) + '</span>' + (q.sub ? '<span class="block truncate text-xs text-cafe-muted">' + h(q.sub) + '</span>' : '') + '</span>' + (q.selected ? v2Glyph('check','h-3 w-3') : '') + '</button>';
};
PDL_COMPONENTS.v2AddMenuItem = function (p, sc, root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" role="menuitem" data-testid="'+h(q.test)+'"'+(q.source?' data-disposition-source="'+h(q.source)+'"':'')+' class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-30 '+(q.active?'bg-accent-50 text-cafe-accent':'text-cafe-secondary hover:bg-cafe-surface-sunken')+'"' + actAttrs(q.act,q.args) + (q.disabled?' disabled':'')+(q.tooltip?' data-tip="'+h(q.label)+' · '+h(q.description)+'"':'')+'><span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cafe-surface text-cafe-muted">' + (q.glyph?'<span aria-hidden="true">'+h(q.glyph)+'</span>':v2AddMenuIcon(q.icon)) + '</span><span class="min-w-0 flex-1"><span class="block text-sm font-medium">' + h(q.label) + '</span><span class="block truncate text-xs text-cafe-muted">'+h(q.description)+'</span></span></button>';
};
PDL_COMPONENTS.v2SearchField = function (p, sc, root) { const q=pvDeep(p,root,sc);return (q.form ? '<form data-form="' + h(q.form) + '">' : '') + '<input class="shell-focusable h-8 w-full rounded-lg px-2.5 text-sm bg-transparent" id="' + h(q.id) + '" data-input="' + h(q.input) + '" value="' + h(q.value) + '" placeholder="' + h(q.label) + '"' + onAttrs(q.on) + '>' + (q.form ? '</form>' : ''); };
PDL_COMPONENTS.v2ToolMenu = function (p, sc, root) {
  return pdlSlot(p.slot, sc);
};
function wsLauncher() { return pdlViewOf('v2.launcher',{}); }
PDL_COMPONENTS.v2Popover.catalog={g:'popups',props:{blocks:[]}};
ENGINE_PARTS.menu = menuHtml;

/* ReplyRecord: the app already groups thinking, subagents and tools. */
PDL_COMPONENTS.v2ReplyRecord = function (p, sc, root) {
  const data=pv(p.data,sc,root);
  return '<div data-testid="reply-record" class="ml-1 flex min-w-0 flex-col gap-1.5 border-l py-1 pl-3 text-xs" style="border-color:var(--shell-hairline);color:var(--shell-muted)">' + data.groups.map(function (group) { return group.items.map(function (row) { return '<details class="min-w-0"><summary class="flex min-h-5 w-full min-w-0 items-center gap-2 rounded text-left"><code class="min-w-0 truncate font-mono text-xs" style="color:var(--shell-body)">' + h(row.title) + '</code></summary><div class="whitespace-pre-wrap break-words">' + (row.details ? row.details.map(function (d) { return pvBlocks(p.details,d,root); }).join('\n') : h(row.detail)) + '</div></details>'; }).join(''); }).join('') + '</div>';
};
/* ThreadItem owns this separate hover control in the old UI. */
PDL_COMPONENTS.v2ThreadMore = function (p, sc, root) {
  const menu=menuLive(rowMenuItems(p.items,sc,root));
  return '<button type="button" class="p-0.5 rounded transition-all flex h-5 w-5 items-center justify-center opacity-0 group-hover:opacity-100"' + actAttrs('menu',{menu:menu,k:pv(p.k,sc,root)}) + MENU_DECL + ' aria-label="' + pvText(p.label,sc,root) + '">' + v2Glyph('more','h-3.5 w-3.5') + '</button>';
};

PDL_COMPONENTS.v2WorkspaceMenu = function (p, sc, root) { return '<div class="v2-workspace-menu fixed z-[70] overflow-auto overscroll-contain rounded-lg border border-cafe-subtle bg-cafe-surface p-1 text-cafe-black shadow-lg">' + pvBlocks(p.blocks,sc,root) + '</div>'; };

/* Separate old component implementations stay separate package drawings. */
PDL_COMPONENTS.v2RailButton = function (p,sc,root) {
  const q=pvDeep(p,root,sc), cur=q.current!=null?q.current:q.entry&&pdlCur(q.entry);
  return '<button type="button" class="shell-rail-item shell-focusable relative flex h-9 w-9 flex-none items-center justify-center rounded-[9px] text-[var(--shell-muted)]"' + actAttrs(q.act,q.args) + (q.attrs || '') + (q.disabled?' disabled':'') + (q.entry?' data-entry="'+h(q.entry)+'"':'') + (cur?' aria-current="page" data-selected="true" style="background:var(--shell-selected);color:var(--shell-ink)"':'') + ' aria-label="'+h(q.label)+'" data-tip="'+h(q.label)+'">' + (q.asset?'<img src="'+h(asset(q.asset))+'"'+(q.asset2?' srcset="'+h(asset(q.asset))+' 1x, '+h(asset(q.asset2))+' 2x"':'')+' alt="" width="'+(q.size||24)+'" height="'+(q.size||24)+'">':'') + (q.avatar?v2Avatar(q.avatar,28,q.portrait,q.avatarName):'') + (q.icon?v2Glyph(q.icon,'h-5 w-5'):'') + (q.count?'<span class="absolute right-0 top-0 rounded-full bg-[var(--shell-primary)] px-1 text-micro text-[var(--shell-primary-on)]">'+h(q.count)+'</span>':'') + '</button>';
};
PDL_COMPONENTS.v2SidebarIconButton = function (p,sc,root) {
  const q=pvDeep(p,root,sc), menu=p.menu?menuLive(rowMenuItems(p.menu,sc,root)):null;
  return '<button type="button" class="shell-rail-item shell-focusable flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lg" style="color:var(--shell-muted)"'+(menu?actAttrs('menu',{menu:menu})+MENU_DECL:actAttrs(q.act,q.args))+' aria-label="'+h(q.label)+'" data-tip="'+h(q.label)+'">'+v2Glyph(q.icon)+'</button>';
};
PDL_COMPONENTS.v2SidebarNavRow = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="shell-nav-row shell-focusable flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm disabled:opacity-50" style="color:var(--shell-body)"'+actAttrs(q.act,q.args)+(q.attrs || '')+(q.disabled?' disabled':'')+(q.current?' aria-current="page" data-selected="true"':'')+(q.test?' data-testid="'+h(q.test)+'"':'')+'><span class="flex-none" style="color:var(--shell-muted)">'+v2Glyph(q.icon)+'</span><span class="min-w-0 flex-1 truncate">'+h(q.label)+'</span>'+(q.count?'<span class="tabular-nums text-xs text-cafe-accent">'+h(q.count)+'</span>':'')+'</button>';
};
PDL_COMPONENTS.v2ChatIconButton = function (p,sc,root) {
  const q=pvDeep(p,root,sc),menu=p.menu?menuLive(rowMenuItems(p.menu,sc,root)):null;
  return '<button type="button" class="shell-rail-item shell-focusable flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lg"'+(menu?actAttrs('menu',{menu:menu,k:q.k})+MENU_DECL:actAttrs(q.act,q.args))+' aria-label="'+h(q.label)+'" data-tip="'+h(q.label)+'">'+v2Glyph(q.icon)+'</button>';
};
PDL_COMPONENTS.v2LandingIconButton = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="shell-focusable relative flex h-8 w-8 items-center justify-center rounded-full text-white/85 hover:bg-black/15 hover:text-white"'+actAttrs(q.act,q.args)+' aria-label="'+h(q.label)+'">'+v2Glyph(q.icon)+'</button>';
};
PDL_COMPONENTS.v2HeaderChip = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="shell-rail-item shell-focusable inline-flex h-[30px] flex-none items-center gap-1.5 rounded-lg px-2.5 text-compact" style="color:var(--shell-body)"'+actAttrs(q.act,q.args)+'><span style="color:var(--shell-muted)">'+v2Glyph(q.icon)+'</span><span>'+h(q.label)+'</span>'+(q.count!=null?'<span class="tabular-nums">'+h(q.count)+'</span>':'')+'</button>';
};
PDL_COMPONENTS.v2ComposerAddButton = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="cafe-composer-control shell-focusable transition-all text-cafe-muted hover:text-cafe-accent hover:bg-cafe-surface"'+actAttrs(q.act,q.args)+' aria-label="'+h(q.label)+'">'+v2Glyph('plus','w-5 h-5')+'</button>';
};
PDL_COMPONENTS.v2VoiceButton = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="shell-focusable flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40"'+actAttrs(q.act,q.args)+' aria-label="'+h(q.label)+'">'+'<svg class="h-5 w-5" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="7" y="2" width="6" height="11" rx="3"/><path d="M4 9v1a6 6 0 0 0 12 0V9m-6 7v2m-3 0h6"/></svg>'+'</button>';
};
PDL_COMPONENTS.v2SendButton = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="shell-focusable flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 bg-[var(--shell-primary)] text-[var(--shell-primary-on)] hover:brightness-95"'+actAttrs(q.act,q.args)+(q.disabled?' disabled':'')+' aria-label="'+h(q.label)+'">'+(q.icon==='stop'?'<svg aria-hidden="true" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><rect x="4" y="4" width="12" height="12" rx="2"/></svg>':'<svg aria-hidden="true" class="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V4m-5 5 5-5 5 5"/></svg>')+'</button>';
};
PDL_COMPONENTS.v2ProjectControl = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="shell-focusable flex h-8 min-w-0 items-center gap-1 rounded-lg px-1.5 text-xs text-[var(--shell-muted)] min-w-[5.75rem] max-w-48 flex-none"'+actAttrs(q.act,q.args)+'>'+v2Glyph('folder','h-3.5 w-3.5 flex-none')+'<span class="min-w-0 truncate whitespace-nowrap">'+h(q.label)+'</span>'+v2Glyph('chevronDown','h-3 w-3 flex-none')+'</button>';
};
PDL_COMPONENTS.v2TrashButton = function (p,sc,root) {
  const q=pvDeep(p,root,sc), open=!!S.folds[q.key];
  return '<div data-testid="trash-bin-section"><button type="button" class="flex w-full items-center gap-2 h-9 px-2.5 rounded-xl bg-[var(--console-card-soft-bg)] text-xs text-cafe-secondary hover:text-cafe-accent transition-colors"'+actAttrs(q.act,q.args)+' data-testid="trash-bin-toggle" aria-expanded="'+open+'"><svg aria-hidden="true" class="h-[15px] w-[15px] flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg><span class="flex-1 text-left">'+h(q.label)+(q.count?' ('+h(q.count)+')':'')+'</span>'+v2Glyph('chevronDown','h-3 w-3 flex-shrink-0 transition-transform'+(open?' rotate-180':''))+'</button><div class="max-h-48 overflow-y-auto mt-1"'+(open?'':' hidden')+'>'+pvBlocks(p.blocks,sc,root)+'</div></div>';
};
PDL_COMPONENTS.v2TrashRow = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<div class="flex items-center gap-2 px-3 py-1.5 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)] rounded-lg group"><span class="truncate flex-1">'+h(q.title||q.untitled)+'</span><button type="button" class="sm:opacity-0 sm:group-hover:opacity-100 text-micro text-cafe-accent hover:text-cafe-interactive transition-all shrink-0" data-testid="restore-btn-'+h(q.id)+'"'+actAttrs(q.restore.act,q.restore.args)+'>'+h(q.restore.label)+'</button></div>';
};
PDL_COMPONENTS.v2TrashStatus = function (p,sc,root) { return '<div class="px-3 py-2 text-micro text-cafe-muted">'+pvText(p.text,sc,root)+'</div>'; };
PDL_COMPONENTS.v2RecentWorksAll = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="shell-focusable ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:text-[var(--shell-ink)]"'+actAttrs(q.act,q.args)+'>'+h(q.label)+v2Glyph('chevronRight','h-3 w-3')+'</button>';
};
PDL_COMPONENTS.v2HomeSectionAll = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="home-all shell-focusable ml-auto text-xs"'+actAttrs(q.act,q.args)+'>'+h(q.label)+'</button>';
};
PDL_COMPONENTS.v2WatchDemoButton = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="shell-focusable rounded-xl border border-cafe-accent/20 bg-accent-50 px-4 py-2 text-sm font-medium text-cafe-accent"'+actAttrs(q.act,q.args)+'>'+h(q.label)+'</button>';
};
PDL_COMPONENTS.v2CreateCatsLink = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<a href="#" class="shell-focusable rounded-lg px-4 py-2 text-sm text-cafe-accent"'+actAttrs(q.act,q.args)+'>'+h(q.label)+'</a>';
};
Object.keys(PDL_COMPONENTS).filter(function (k) { return k.indexOf('v2')===0; }).forEach(function (k) { if (!PDL_COMPONENTS[k].catalog) PDL_COMPONENTS[k].catalog={g:'structure',props:{}}; });
PDL_COMPONENTS.v2LandingTitle = function (p,sc,root) { return '<span class="text-sm font-medium text-white/90">'+pvText(p.text,sc,root)+'</span>'; };
PDL_COMPONENTS.v2PanelToggle = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="relative z-40 ml-1 inline-flex h-8 w-8 items-center justify-center rounded-full bg-transparent transition-colors '+(q.active?'text-cafe-accent':'text-cafe-secondary hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent')+'"'+actAttrs(q.act,q.args)+' aria-label="'+h(q.label)+'" data-testid="workspace-panel-toggle"><svg aria-hidden="true" class="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5Z"/><path d="M10.5 2.5v11M7.5 6 5.5 8l2 2"/></svg></button>';
};
PDL_COMPONENTS.v2ThreadProjectControl = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="shell-focusable shell-rail-item flex h-8 min-w-0 items-center gap-1 rounded-lg px-1.5 text-xs text-[var(--shell-muted)] flex-1"'+actAttrs(q.act,q.args)+'>'+v2Glyph('folder','h-3.5 w-3.5 flex-none')+'<span class="min-w-0 truncate">'+h(q.label)+'</span>'+v2Glyph('chevronDown','h-3 w-3 flex-none')+'</button>';
};
PDL_COMPONENTS.v2SessionImportEntry = function (p,sc,root) {
  const q=pvDeep(p,root,sc);
  return '<button type="button" class="shell-focusable inline-flex items-center gap-2 text-left text-sm text-[var(--shell-muted)] underline-offset-4 hover:underline disabled:opacity-50"'+actAttrs(q.act,q.args)+'><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" class="shrink-0"><path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>'+h(q.label)+'</button>';
};
PDL_COMPONENTS.v2HomeStatusSection = function (p,sc,root) { return '<section class="home-section"><header class="home-card-head">'+v2Glyph('activity','home-section-icon')+'<h2 class="home-card-title text-sm">'+pvText(p.title,sc,root)+'</h2>'+pvBlocks(p.all,sc,root)+'</header>'+pvBlocks(p.blocks,sc,root)+'</section>'; };
PDL_COMPONENTS.v2HomeWorksSection = function (p,sc,root) { return '<section class="home-section"><header class="home-card-head">'+v2Glyph('works','home-section-icon')+'<h2 class="home-card-title text-sm">'+pvText(p.title,sc,root)+'</h2><span class="text-xs text-cafe-muted">'+pvText(p.count,sc,root)+'</span>'+pvBlocks(p.all,sc,root)+'</header>'+pvBlocks(p.blocks,sc,root)+'</section>'; };
