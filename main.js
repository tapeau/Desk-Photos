'use strict';

/*
 * Desk Photos — floating sticky photos for the Obsidian editor.
 * Desktop only. All data persists to .obsidian/plugins/desk-photos/data.json.
 */

const {
	Plugin, Modal, Menu, Notice, FuzzySuggestModal, TFile,
	MarkdownView, setIcon, normalizePath, requestUrl,
} = require('obsidian');

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'jfif', 'ico'];
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'flac', 'aac', 'webm', '3gp'];

const MIN_PHOTO_PX = 50;
const UNDO_LIMIT = 50;
const LONG_PRESS_MS = 1000;

// UI sounds live in <plugin>/assets/ and are downloaded once from the
// repository when a file is missing locally.
const ASSET_SOUND_BASE_URL =
	'https://raw.githubusercontent.com/tapeau/Desk-Photos/main/assets/';

// Decoration sizes are fractions of the photo's outer (frame included)
// width, so everything scales together with the photo.
const TAPE_DEFAULT = { w: 0.34, h: 0.13, color: '#ece4c9', alpha: 0.55 };
const TAPE_MIN_W = 0.12, TAPE_MAX_W = 0.70;
const TAPE_MIN_H = 0.05, TAPE_MAX_H = 0.45;

const PIN_ASPECT = 123.82 / 131.64; // pin SVG viewBox is 131.64 x 123.82
// Where the (invisible) needle tip meets the photo, as fractions of the pin
// graphic's box: just above the circular contact shadow under the pin head.
// The pin anchors and rotates around this penetration point.
const PIN_ANCHOR_X = 0.60, PIN_ANCHOR_Y = 0.37;
const PIN_DEFAULT = { w: 0.15, color: '#d40000', alpha: 1 };
const PIN_MIN_W = 0.07, PIN_MAX_W = 0.28;

const TEXT_DEFAULT = { w: 0.42, h: 0.14, color: '#1f1f1f', alpha: 1 };
const TEXT_MIN_W = 0.15, TEXT_MAX_W = 0.90;
const TEXT_MIN_H = 0.06, TEXT_MAX_H = 0.60;
const TEXT_FONT_RATIO = 0.5; // font-size = box height * ratio

// Hand-written tape SVG: a strip with torn zig-zag ends and a thin outline.
const TAPE_PATH =
	'M7 1 H113 L119 6 L113 12 L119 17 L113 23 L119 28 L113 34 L119 39 L113 43 ' +
	'H7 L1 38 L7 33 L1 27 L7 22 L1 16 L7 11 L1 5 Z';

const FRAME_TYPES = ['none', 'blank', 'polaroid'];

// Image adjustments run 0..1 with 0.5 as neutral (transparency: 1 neutral).
const FILTER_RESET = {
	brightness: 0.5, contrast: 0.5, saturation: 0.5, temperature: 0.5, imageAlpha: 1,
};
const FILTER_PRESETS = [
	['Grayscale', { brightness: 0.5, contrast: 0.55, saturation: 0, temperature: 0.5 }],
	['Vintage', { brightness: 0.55, contrast: 0.45, saturation: 0.35, temperature: 0.62 }],
	['Sepia', { brightness: 0.52, contrast: 0.5, saturation: 0.12, temperature: 0.9 }],
	['Warm', { brightness: 0.52, contrast: 0.5, saturation: 0.55, temperature: 0.72 }],
	['Cool', { brightness: 0.5, contrast: 0.5, saturation: 0.5, temperature: 0.28 }],
];

// Build the CSS filter chain for a photo's image adjustments. Temperature
// has no direct CSS filter: warmth is approximated with sepia plus a slight
// negative hue rotation, coolness with a positive hue rotation.
function imageFilter(p) {
	const parts = [];
	const b = (p.brightness == null ? 0.5 : p.brightness) * 2;
	const c = (p.contrast == null ? 0.5 : p.contrast) * 2;
	const s = (p.saturation == null ? 0.5 : p.saturation) * 2;
	const t = p.temperature == null ? 0.5 : p.temperature;
	if (Math.abs(b - 1) > 0.001) parts.push(`brightness(${b.toFixed(3)})`);
	if (Math.abs(c - 1) > 0.001) parts.push(`contrast(${c.toFixed(3)})`);
	if (Math.abs(s - 1) > 0.001) parts.push(`saturate(${s.toFixed(3)})`);
	if (t > 0.501) {
		const w = (t - 0.5) * 2;
		parts.push(`sepia(${(w * 0.5).toFixed(3)})`);
		parts.push(`saturate(${(1 + w * 0.3).toFixed(3)})`);
		parts.push(`hue-rotate(${(-w * 10).toFixed(1)}deg)`);
	} else if (t < 0.499) {
		const cl = (0.5 - t) * 2;
		parts.push(`hue-rotate(${(cl * 25).toFixed(1)}deg)`);
		parts.push(`saturate(${(1 - cl * 0.15).toFixed(3)})`);
		parts.push(`brightness(${(1 + cl * 0.05).toFixed(3)})`);
	}
	return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function deepClone(x) { return JSON.parse(JSON.stringify(x)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function cssUrl(src) { return src.replace(/["\\]/g, '\\$&'); }

function hexToRgba(hex, alpha) {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
	if (!m) return hex || '#000000';
	const n = parseInt(m[1], 16);
	const a = alpha == null ? 1 : alpha;
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Shift a hex color toward white (f > 0) or black (f < 0).
function shadeHex(hex, f) {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
	if (!m) return hex || '#000000';
	const n = parseInt(m[1], 16);
	const target = f < 0 ? 0 : 255;
	const p = Math.min(1, Math.abs(f));
	let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
	r = Math.round((target - r) * p + r);
	g = Math.round((target - g) * p + g);
	b = Math.round((target - b) * p + b);
	return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function debounce(fn, ms) {
	let timer = null;
	const wrapped = (...args) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => { timer = null; fn(...args); }, ms);
	};
	wrapped.flush = (...args) => {
		if (timer) { clearTimeout(timer); timer = null; }
		fn(...args);
	};
	wrapped.cancel = () => {
		if (timer) { clearTimeout(timer); timer = null; }
	};
	return wrapped;
}

// Track a pointer drag: onMove(dx, dy, event) gets deltas from the start point.
function dragTrack(e, { onMove, onEnd }) {
	const sx = e.clientX, sy = e.clientY;
	const move = (ev) => { ev.preventDefault(); onMove(ev.clientX - sx, ev.clientY - sy, ev); };
	const finish = (ev) => {
		window.removeEventListener('pointermove', move, true);
		window.removeEventListener('pointerup', finish, true);
		window.removeEventListener('pointercancel', finish, true);
		if (onEnd) onEnd(ev);
	};
	window.addEventListener('pointermove', move, true);
	window.addEventListener('pointerup', finish, true);
	window.addEventListener('pointercancel', finish, true);
}

/* Geometry: rotated-rectangle collision via SAT ---------------------- */

function rectPoly(cx, cy, w, h, rotRad) {
	const c = Math.cos(rotRad), s = Math.sin(rotRad);
	const hw = w / 2, hh = h / 2;
	return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
		.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

function polysIntersect(a, b) {
	for (const poly of [a, b]) {
		for (let i = 0; i < poly.length; i++) {
			const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
			const ax = p2[1] - p1[1], ay = p1[0] - p2[0];
			let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
			for (const p of a) { const d = p[0] * ax + p[1] * ay; if (d < minA) minA = d; if (d > maxA) maxA = d; }
			for (const p of b) { const d = p[0] * ax + p[1] * ay; if (d < minB) minB = d; if (d > maxB) maxB = d; }
			if (maxA <= minB || maxB <= minA) return false;
		}
	}
	return true;
}

// Tapes and text boxes share the same box model: center x,y (fractions of
// the outer box), w and h as fractions of the outer box WIDTH.
function tapePoly(t, boxW, boxH, shrink) {
	const w = Math.max(1, t.w * boxW - (shrink || 0));
	const h = Math.max(1, t.h * boxW - (shrink || 0));
	return rectPoly(t.x * boxW, t.y * boxH, w, h, (t.rot || 0) * Math.PI / 180);
}

// A tape is valid when it still touches the photo (frame included) and
// does not overlap any other tape.
function tapeIsValid(tapes, cand, ignoreIdx, boxW, boxH) {
	const poly = tapePoly(cand, boxW, boxH, 0);
	const box = rectPoly(boxW / 2, boxH / 2, boxW, boxH, 0);
	if (!polysIntersect(poly, box)) return false;
	const shrunk = tapePoly(cand, boxW, boxH, 3);
	for (let i = 0; i < tapes.length; i++) {
		if (i === ignoreIdx) continue;
		if (polysIntersect(shrunk, tapePoly(tapes[i], boxW, boxH, 3))) return false;
	}
	return true;
}

// Pins anchor at their (invisible) needle tip (x,y), located at the
// PIN_ANCHOR fractions of the graphic's box; the body rotates around it.
function pinPoly(t, boxW, boxH, shrink) {
	const w = Math.max(1, t.w * boxW - (shrink || 0));
	const h = Math.max(1, t.w * boxW * PIN_ASPECT - (shrink || 0));
	const rad = (t.rot || 0) * Math.PI / 180;
	const cos = Math.cos(rad), sin = Math.sin(rad);
	// Box center relative to the anchor point, rotated into place.
	const ox = (0.5 - PIN_ANCHOR_X) * w;
	const oy = (0.5 - PIN_ANCHOR_Y) * h;
	const cx = t.x * boxW + ox * cos - oy * sin;
	const cy = t.y * boxH + ox * sin + oy * cos;
	return rectPoly(cx, cy, w, h, rad);
}

// A pin is valid when its tip (the penetration point) is on the photo and
// it does not overlap any other pin.
function pinIsValid(pins, cand, ignoreIdx, boxW, boxH) {
	if (cand.x < 0 || cand.x > 1 || cand.y < 0 || cand.y > 1) return false;
	const shrunk = pinPoly(cand, boxW, boxH, 3);
	for (let i = 0; i < pins.length; i++) {
		if (i === ignoreIdx) continue;
		if (polysIntersect(shrunk, pinPoly(pins[i], boxW, boxH, 3))) return false;
	}
	return true;
}

// The polygon of a text's rendered GRAPHIC (the glyphs), not its box.
// m = { ox, oy, gw, gh }: the graphic's center offset from the box center
// and its size, in unrotated local pixels.
function textGraphicPoly(t, m, boxW, boxH, shrink) {
	const rad = (t.rot || 0) * Math.PI / 180;
	const cos = Math.cos(rad), sin = Math.sin(rad);
	const cx = t.x * boxW + m.ox * cos - m.oy * sin;
	const cy = t.y * boxH + m.ox * sin + m.oy * cos;
	return rectPoly(cx, cy,
		Math.max(1, m.gw - (shrink || 0)),
		Math.max(1, m.gh - (shrink || 0)), rad);
}

// A text is valid when its rendered graphic lies entirely inside the photo
// and does not overlap any other text's graphic — the box edges themselves
// may hang outside and boxes may overlap. metricOf(index, item) supplies
// measured graphic metrics; without it the whole box is used as fallback.
// Coordinates are relative to the image box; `bounds` widens the allowed
// area by the frame paddings (texts may sit on the frame).
function textIsValid(texts, cand, ignoreIdx, boxW, boxH, metricOf, bounds) {
	const bx = bounds || { l: 0, t: 0, r: 0, b: 0 };
	const metric = metricOf ||
		((i, t) => ({ ox: 0, oy: 0, gw: Math.max(1, t.w * boxW), gh: Math.max(1, t.h * boxW) }));
	const candMetric = metric(ignoreIdx, cand);
	const poly = textGraphicPoly(cand, candMetric, boxW, boxH, 0);
	for (const pt of poly) {
		if (pt[0] < -bx.l - 1 || pt[1] < -bx.t - 1 ||
			pt[0] > boxW + bx.r + 1 || pt[1] > boxH + bx.b + 1) return false;
	}
	const shrunk = textGraphicPoly(cand, candMetric, boxW, boxH, 3);
	for (let i = 0; i < texts.length; i++) {
		if (i === ignoreIdx) continue;
		if (polysIntersect(shrunk, textGraphicPoly(texts[i], metric(i, texts[i]), boxW, boxH, 3))) return false;
	}
	return true;
}

// Measure a rendered text's graphic from the DOM (offsets are unaffected by
// the photo's rotation); estimate for items that are not rendered yet.
function textGraphicMetric(el, t, boxW) {
	if (el && el._inner && el.offsetWidth) {
		const inner = el._inner;
		return {
			ox: inner.offsetLeft + inner.offsetWidth / 2 - el.offsetWidth / 2,
			oy: inner.offsetTop + inner.offsetHeight / 2 - el.offsetHeight / 2,
			gw: Math.max(1, inner.offsetWidth),
			gh: Math.max(1, inner.offsetHeight),
		};
	}
	const fsPx = (t.fs == null ? (t.h || TEXT_DEFAULT.h) * TEXT_FONT_RATIO : t.fs) * boxW;
	const chars = (t.text || 'Text').length;
	return {
		ox: 0, oy: 0,
		gw: Math.max(4, Math.min(t.w * boxW, fsPx * 0.55 * chars)),
		gh: Math.max(4, fsPx * 1.2),
	};
}

/* Frame geometry ------------------------------------------------------ */

function frameGeom(photo) {
	const f = photo.frame;
	if (!f || f.type === 'none') return { top: 0, right: 0, bottom: 0, left: 0 };
	// User-adjustable thickness: sizeScale 0.5 is the classic size, 1 doubles
	// it, and 0 still leaves a thin visible sliver of frame.
	const base = clamp(Math.round(Math.min(photo.size.w, photo.size.h) * 0.08), 6, 40);
	const sizeScale = f.sizeScale == null ? 0.5 : f.sizeScale;
	const t = Math.max(2, Math.round(base * 2 * sizeScale));
	if (f.type === 'polaroid') {
		return { top: t, right: t, bottom: Math.max(6, Math.round(t * 3.2)), left: t };
	}
	let extra = 0;
	// A frame that is rounder than its image must be big enough that the
	// image's corners stay inside the ring: pad out toward the half-diagonal
	// (the frame thickness t then acts as the visual margin). This covers
	// circular frames and rounded frame corners alike, and shrinks as the
	// image's own corners get rounder.
	if (photo.shape === 'square') {
		const frameRound = f.shape === 'circle' ? 1 : clamp(f.cornerRadius || 0, 0, 1);
		const imageRound = clamp(photo.cornerRadius || 0, 0, 1);
		extra = Math.round(0.21 * Math.max(photo.size.w, photo.size.h) *
			Math.max(0, frameRound - imageRound));
	}
	const pad = t + extra;
	return { top: pad, right: pad, bottom: pad, left: pad };
}

function outerSize(photo) {
	const g = frameGeom(photo);
	return { w: photo.size.w + g.left + g.right, h: photo.size.h + g.top + g.bottom };
}

/* SVG builders --------------------------------------------------------- */

function svgEl(parent, name, attrs) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', name);
	for (const k in attrs) el.setAttribute(k, attrs[k]);
	parent.appendChild(el);
	return el;
}

function buildTapeSvg(color, alpha) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 120 44');
	svg.setAttribute('preserveAspectRatio', 'none');
	const path = svgEl(svg, 'path', {
		d: TAPE_PATH, fill: color, 'fill-opacity': String(alpha),
		stroke: 'rgba(110,110,110,0.75)', 'stroke-width': '1',
		'vector-effect': 'non-scaling-stroke',
	});
	svgEl(svg, 'path', {
		d: 'M12 7 H108', stroke: 'rgba(255,255,255,0.3)', 'stroke-width': '2',
		fill: 'none', 'vector-effect': 'non-scaling-stroke',
	});
	return { svg, colorEl: path };
}

// Push pin, adapted from samples/pin.svg (openclipart "Pushpin 2" by
// randoogle, public domain): a tilted pin whose head is recolored from the
// user's choice via regenerated gradient stops. Gradient/filter ids are
// unique per instance because all pins share the document's id namespace.
const PIN_ELLIPSE = 'm286.18 14.557a7.3868 8.4658 0 1 1 -14.774 0 7.3868 8.4658 0 1 1 14.774 0z';
const PIN_CIRCLE = 'm311.75 4.6951a8.9206 8.9206 0 1 1 -17.841 0 8.9206 8.9206 0 1 1 17.841 0z';

function buildPinSvg(color, alpha) {
	const id = 'dp' + uid();
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 131.64 123.82');
	svg.setAttribute('preserveAspectRatio', 'none');
	const defs = svgEl(svg, 'defs', {});

	const blur = (suffix, dev) => {
		const f = svgEl(defs, 'filter', {
			id: id + suffix, x: '-25%', y: '-45%', width: '150%', height: '190%',
			'color-interpolation-filters': 'sRGB',
		});
		svgEl(f, 'feGaussianBlur', { stdDeviation: dev });
	};
	blur('-b1', '1.38');
	blur('-b2', '1.24');
	blur('-b3', '0.34');

	const gShadow = svgEl(defs, 'radialGradient', {
		id: id + '-sh', gradientUnits: 'userSpaceOnUse', cx: '278.53', cy: '12.798',
		r: '7.3868', gradientTransform: 'matrix(1.6668 .25023 -.43535 1.4424 -180.07 -76.258)',
	});
	svgEl(gShadow, 'stop', { offset: '0', 'stop-opacity': '0.991' });
	svgEl(gShadow, 'stop', { offset: '0.514', 'stop-opacity': '0.616' });
	svgEl(gShadow, 'stop', { offset: '1', 'stop-color': '#8d8d8d', 'stop-opacity': '0' });

	const gHead = svgEl(defs, 'radialGradient', {
		id: id + '-hd', gradientUnits: 'userSpaceOnUse', cx: '305.98', cy: '4.6951', r: '8.9206',
	});
	const hd0 = svgEl(gHead, 'stop', { offset: '0' });
	const hd1 = svgEl(gHead, 'stop', { offset: '1' });

	const gDark = svgEl(defs, 'radialGradient', {
		id: id + '-dk', gradientUnits: 'userSpaceOnUse', cx: '302.83', cy: '4.6951', r: '8.9206',
	});
	const dk0 = svgEl(gDark, 'stop', { offset: '0', 'stop-opacity': '0.584' });
	const dk1 = svgEl(gDark, 'stop', { offset: '0.667', 'stop-opacity': '0.498' });
	const dk2 = svgEl(gDark, 'stop', { offset: '1', 'stop-opacity': '0' });

	const gLit = svgEl(defs, 'radialGradient', {
		id: id + '-lt', gradientUnits: 'userSpaceOnUse', cx: '302.66', cy: '3.251', r: '8.9206',
		gradientTransform: 'matrix(.75426 .68023 -.67730 .80831 77.596 -205.09)',
	});
	const lt0 = svgEl(gLit, 'stop', { offset: '0' });
	const lt1 = svgEl(gLit, 'stop', { offset: '0.481' });
	const lt2 = svgEl(gLit, 'stop', { offset: '0.736' });
	const lt3 = svgEl(gLit, 'stop', { offset: '1' });

	const glare = (suffix, transform) => {
		const g = svgEl(defs, 'radialGradient', {
			id: id + suffix, gradientUnits: 'userSpaceOnUse', cx: '537.75', cy: '228.65',
			r: '0.74646', gradientTransform: transform,
		});
		svgEl(g, 'stop', { offset: '0', 'stop-color': '#ffffff' });
		svgEl(g, 'stop', { offset: '1', 'stop-color': '#ffffff', 'stop-opacity': '0' });
	};
	glare('-ga', 'matrix(-4.0973 2.6711 -10.635 -16.503 5102.7 2861.5)');
	glare('-gb', 'matrix(5.8281 -3.599 17.872 21.975 -6695.6 -2611.2)');

	const root = svgEl(svg, 'g', { transform: 'translate(-399.13 -466.21)' });
	const shadows = svgEl(root, 'g', {});
	svgEl(shadows, 'path', {
		d: PIN_ELLIPSE, opacity: '0.62', fill: `url(#${id}-sh)`, filter: `url(#${id}-b2)`,
		transform: 'matrix(1.2623 3.1595 -5.763 2.4855 192.04 -379.19)',
	});
	svgEl(shadows, 'path', {
		d: PIN_ELLIPSE, opacity: '0.303', fill: `url(#${id}-sh)`, filter: `url(#${id}-b1)`,
		transform: 'matrix(1.3571 2.2762 -2.5511 1.241 136.44 -137.78)',
	});
	const head = svgEl(root, 'g', {});
	svgEl(head, 'path', {
		d: PIN_CIRCLE, fill: `url(#${id}-hd)`,
		transform: 'matrix(3.4214 0 0 3.4413 -545.23 495.42)',
	});
	svgEl(head, 'path', {
		d: PIN_CIRCLE, fill: `url(#${id}-dk)`, filter: `url(#${id}-b3)`,
		transform: 'matrix(2.1108 0 0 2.1231 -144.39 495.36)',
	});
	svgEl(head, 'path', {
		d: 'm474.2 531.26c-6.4976-5.2202-8.2466-8.1777-7.2576-14.181 2.8176 7.7769 6.9716 13.737 7.2576 14.181z',
		opacity: '0.74', 'fill-rule': 'evenodd', fill: `url(#${id}-ga)`,
	});
	svgEl(head, 'path', {
		d: PIN_CIRCLE, fill: `url(#${id}-lt)`,
		transform: 'matrix(2.3962 .18197 0 2.4872 -216.26 421.67)',
	});
	svgEl(head, 'path', {
		d: 'm514.32 468.93c10.35 6.9283 13.318 10.867 12.538 18.896-5.1338-10.371-12.058-18.305-12.538-18.896z',
		'fill-rule': 'evenodd', fill: `url(#${id}-gb)`,
	});

	const update = (c, a) => {
		const alphaVal = a == null ? 1 : a;
		hd0.setAttribute('stop-color', shadeHex(c, 0.12));
		hd1.setAttribute('stop-color', shadeHex(c, -0.30));
		dk0.setAttribute('stop-color', shadeHex(c, -0.50));
		dk1.setAttribute('stop-color', shadeHex(c, -0.48));
		dk2.setAttribute('stop-color', shadeHex(c, -0.48));
		lt0.setAttribute('stop-color', shadeHex(c, 0.17));
		lt1.setAttribute('stop-color', shadeHex(c, 0.08));
		lt2.setAttribute('stop-color', c);
		lt3.setAttribute('stop-color', shadeHex(c, -0.42));
		head.setAttribute('opacity', String(alphaVal));
		shadows.setAttribute('opacity', String(0.9 * alphaVal));
	};
	update(color, alpha);
	return { svg, update };
}

function placeBoxNear(box, r) {
	const bw = box.offsetWidth || 300, bh = box.offsetHeight || 160;
	const W = window.innerWidth, H = window.innerHeight, m = 16;
	let x = r.right + m;
	let y = clamp(r.top, 8, Math.max(8, H - bh - 8));
	if (x + bw > W - 8) x = r.left - m - bw;
	if (x < 8) {
		x = clamp(r.left + (r.width - bw) / 2, 8, Math.max(8, W - bw - 8));
		y = r.bottom + m;
		if (y + bh > H - 8) y = clamp(r.top - m - bh, 8, Math.max(8, H - bh - 8));
	}
	box.style.left = x + 'px';
	box.style.top = y + 'px';
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

class OptionModal extends Modal {
	constructor(app, title, options, onCancel) {
		super(app);
		this._title = title;
		this._options = options;
		this._onCancel = onCancel;
		this._chosen = false;
	}
	onOpen() {
		this.titleEl.setText(this._title);
		const wrap = this.contentEl.createDiv({ cls: 'dp-option-list' });
		for (const o of this._options) {
			const b = wrap.createEl('button', { cls: 'dp-option-btn' });
			if (o.icon) setIcon(b.createSpan({ cls: 'dp-option-icon' }), o.icon);
			b.createSpan({ text: o.label });
			b.addEventListener('click', () => {
				this._chosen = true;
				this.close();
				o.cb();
			});
		}
	}
	onClose() {
		this.contentEl.empty();
		if (!this._chosen && this._onCancel) this._onCancel();
	}
}

class TextPromptModal extends Modal {
	constructor(app, title, placeholder, onSubmit, onCancel) {
		super(app);
		this._title = title;
		this._placeholder = placeholder;
		this._onSubmit = onSubmit;
		this._onCancel = onCancel;
		this._done = false;
	}
	onOpen() {
		this.titleEl.setText(this._title);
		const input = this.contentEl.createEl('input', {
			type: 'text', cls: 'dp-text-input', placeholder: this._placeholder,
		});
		const row = this.contentEl.createDiv({ cls: 'dp-modal-btns' });
		const ok = row.createEl('button', { text: 'OK', cls: 'mod-cta' });
		const cancel = row.createEl('button', { text: 'Cancel' });
		const submit = () => {
			const v = input.value.trim();
			if (!/^(https?:\/\/|data:)/i.test(v)) {
				new Notice('Enter a direct link starting with http:// or https://');
				return;
			}
			this._done = true;
			this.close();
			this._onSubmit(v);
		};
		ok.addEventListener('click', submit);
		cancel.addEventListener('click', () => this.close());
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
		window.setTimeout(() => input.focus(), 10);
	}
	onClose() {
		this.contentEl.empty();
		if (!this._done && this._onCancel) this._onCancel();
	}
}

class ConfirmModal extends Modal {
	constructor(app, title, message, confirmLabel, onConfirm, onCancel) {
		super(app);
		this._title = title;
		this._message = message;
		this._confirmLabel = confirmLabel;
		this._onConfirm = onConfirm;
		this._onCancel = onCancel;
		this._done = false;
	}
	onOpen() {
		this.titleEl.setText(this._title);
		this.contentEl.createEl('p', { text: this._message });
		const row = this.contentEl.createDiv({ cls: 'dp-modal-btns' });
		const yes = row.createEl('button', { text: this._confirmLabel, cls: 'mod-warning' });
		const no = row.createEl('button', { text: 'Cancel' });
		yes.addEventListener('click', () => { this._done = true; this.close(); this._onConfirm(); });
		no.addEventListener('click', () => this.close());
		if (this.scope && this.scope.register) {
			this.scope.register([], 'Enter', () => {
				this._done = true;
				this.close();
				this._onConfirm();
			});
		}
	}
	onClose() {
		this.contentEl.empty();
		if (!this._done && this._onCancel) this._onCancel();
	}
}

class VaultFileModal extends FuzzySuggestModal {
	constructor(app, exts, onChoose, onCancel) {
		super(app);
		this._exts = exts;
		this._onChoose = onChoose;
		this._onCancel = onCancel;
		this._chosen = false;
		this.setPlaceholder('Type to search files in your vault…');
	}
	getItems() {
		return this.app.vault.getFiles()
			.filter((f) => this._exts.includes(f.extension.toLowerCase()));
	}
	getItemText(f) { return f.path; }
	onChooseItem(f) { this._chosen = true; this._onChoose(f); }
	onClose() {
		super.onClose();
		window.setTimeout(() => {
			if (!this._chosen && this._onCancel) this._onCancel();
		}, 0);
	}
}

// Compact color + transparency popover next to the photo — the same widget
// tapes and pins use, reused for frame color.
class ColorAlphaMode {
	// opts: { getColor(), getAlpha(), set(color, alpha) }
	constructor(plugin, view, opts) {
		this.plugin = plugin;
		this.view = view;
		this.opts = opts;
		this.type = 'slider';
		this.closed = false;
	}

	open() {
		this.plugin.activeMode = this;
		this.before = this.plugin.snapshot();
		this.box = document.body.createDiv({ cls: 'dp-box dp-colorpop' });
		const color = this.box.createEl('input', { type: 'color' });
		color.value = this.opts.getColor();
		const alpha = this.box.createEl('input', { type: 'range' });
		alpha.min = '0'; alpha.max = '100';
		alpha.value = String(Math.round(this.opts.getAlpha() * 100));
		alpha.setAttribute('aria-label', 'Transparency');
		const close = this.box.createEl('button', { text: 'Close' });
		const update = () => {
			this.opts.set(color.value, Number(alpha.value) / 100);
			this.view.applyGeometry();
		};
		color.addEventListener('input', update);
		alpha.addEventListener('input', update);
		close.addEventListener('click', () => this.finish());
		placeBoxNear(this.box, this.view.rootEl.getBoundingClientRect());

		this._outside = (e) => {
			if (this.view.rootEl.contains(e.target) || this.box.contains(e.target)) return;
			this.finish();
		};
		this._esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); this.finish(); } };
		document.addEventListener('pointerdown', this._outside, true);
		document.addEventListener('keydown', this._esc, true);
	}

	finish() {
		if (this.closed) return;
		this.closed = true;
		document.removeEventListener('pointerdown', this._outside, true);
		document.removeEventListener('keydown', this._esc, true);
		this.box.remove();
		if (this.plugin.activeMode === this) this.plugin.activeMode = null;
		this.plugin.commit(this.before);
		this.view.render();
		this.plugin.processErrors();
	}
}

// Arrange desk photo layers: one draggable row per photo showing its image.
// The top row is the front-most photo; changes apply on Done.
class LayersModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.modalEl.addClass('dp-layers-modal');
		this.titleEl.setText('Arrange desk photo layers');
		this.contentEl.createEl('p', {
			text: 'Drag the rows to rearrange. The top row sits in front.',
			cls: 'dp-layers-hint',
		});
		this.listEl = this.contentEl.createDiv({ cls: 'dp-layers-list' });
		// Front-most photo (end of the data array) is listed first.
		const photos = this.plugin.data.photos.slice().reverse();
		for (const photo of photos) {
			const row = this.listEl.createDiv({ cls: 'dp-layer-row' });
			row.dataset.id = photo.id;
			const grip = row.createSpan({ cls: 'dp-layer-grip' });
			setIcon(grip, 'grip-horizontal');
			const thumb = row.createDiv({ cls: 'dp-layer-thumb' });
			const src = this.plugin.resolveSrc(photo.image);
			if (src) {
				const img = thumb.createEl('img');
				img.src = src;
				img.draggable = false;
			} else {
				setIcon(thumb, 'image-off');
			}
			row.addEventListener('pointerdown', (e) => this.startDrag(e, row));
		}
		const btns = this.contentEl.createDiv({ cls: 'dp-modal-btns' });
		const done = btns.createEl('button', { text: 'Done', cls: 'mod-cta' });
		done.addEventListener('click', () => {
			this.apply();
			this.close();
		});
	}

	startDrag(e, row) {
		if (e.button !== 0) return;
		e.preventDefault();
		row.addClass('dp-layer-dragging');
		dragTrack(e, {
			onMove: (dx, dy, ev) => {
				const others = Array.from(this.listEl.children).filter((r) => r !== row);
				let placed = false;
				for (const other of others) {
					const r = other.getBoundingClientRect();
					if (ev.clientY < r.top + r.height / 2) {
						this.listEl.insertBefore(row, other);
						placed = true;
						break;
					}
				}
				if (!placed) this.listEl.appendChild(row);
			},
			onEnd: () => row.removeClass('dp-layer-dragging'),
		});
	}

	apply() {
		const ids = Array.from(this.listEl.children).map((r) => r.dataset.id).reverse();
		this.plugin.change(() => {
			this.plugin.data.photos.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
		}, null);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* Spotlight: dim the whole app, lift one photo above the dim          */
/* ------------------------------------------------------------------ */

class Spotlight {
	constructor(plugin, view, opts) {
		this.plugin = plugin;
		this.view = view;
		this.opts = opts || {};
		this.boxes = [];
		this.closed = false;
	}

	open() {
		const el = this.view.rootEl;
		this.dim = document.body.createDiv({ cls: 'dp-dim' });
		const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
		for (const type of ['mousedown', 'click', 'dblclick', 'contextmenu', 'wheel', 'auxclick']) {
			this.dim.addEventListener(type, swallow);
		}
		this.dim.addEventListener('pointerdown', (e) => {
			e.preventDefault(); e.stopPropagation();
			if (this.opts.onDimClick) this.opts.onDimClick(e);
		});

		this._keyHandler = (e) => {
			const t = e.target;
			const allowed = (this.holder && this.holder.contains(t)) ||
				this.boxes.some((b) => b.isConnected && b.contains(t));
			if (e.key === 'Escape' && this.opts.onEscape) {
				e.preventDefault(); e.stopPropagation();
				this.opts.onEscape();
				return;
			}
			if (!allowed) { e.preventDefault(); e.stopPropagation(); }
		};
		window.addEventListener('keydown', this._keyHandler, true);

		const r = el.getBoundingClientRect();
		this.holder = document.body.createDiv({ cls: 'dp-holder' });
		this.holder.style.left = r.left + 'px';
		this.holder.style.top = r.top + 'px';
		this.holder.style.width = r.width + 'px';
		this.holder.style.height = r.height + 'px';
		this._prevParent = el.parentElement;
		this._prevLeft = el.style.left;
		this._prevTop = el.style.top;
		el.style.left = '50%';
		el.style.top = '50%';
		this.holder.appendChild(el);
		this.view.spotlighted = true;

		this._resizeHandler = () => this.reposition();
		window.addEventListener('resize', this._resizeHandler);
	}

	reposition() {
		if (this.closed || !this.plugin.layerEl) return;
		// Document-locked photos have no meaningful pos fractions; their
		// holder keeps its opening position until the spotlight closes.
		if (this.view.photo.lock === 'document') return;
		const lr = this.plugin.layerEl.getBoundingClientRect();
		const pos = this.view.photo.pos;
		const w = this.holder.offsetWidth, h = this.holder.offsetHeight;
		this.holder.style.left = (lr.left + pos.x * lr.width - w / 2) + 'px';
		this.holder.style.top = (lr.top + pos.y * lr.height - h / 2) + 'px';
	}

	addBox(box) { this.boxes.push(box); }

	close() {
		if (this.closed) return;
		this.closed = true;
		window.removeEventListener('keydown', this._keyHandler, true);
		window.removeEventListener('resize', this._resizeHandler);
		const el = this.view.rootEl;
		el.style.left = this._prevLeft;
		el.style.top = this._prevTop;
		const parent = (this._prevParent && this._prevParent.isConnected)
			? this._prevParent : this.plugin.layerEl;
		if (parent) {
			// Reinsert at the photo's layer position — a plain appendChild
			// would silently promote it to the front layer.
			let nextEl = null;
			const photos = this.plugin.data.photos;
			for (let k = photos.indexOf(this.view.photo) + 1; k < photos.length && !nextEl; k++) {
				const v = this.plugin.views.get(photos[k].id);
				if (v && v !== this.view && v.rootEl && v.rootEl.parentElement === parent) {
					nextEl = v.rootEl;
				}
			}
			parent.insertBefore(el, nextEl);
		}
		this.view.spotlighted = false;
		this.holder.remove();
		this.dim.remove();
		this.view.applyPosition();
	}
}

/* ------------------------------------------------------------------ */
/* Crop editor: pick a region of an image inside a shape outline       */
/* ------------------------------------------------------------------ */

class CropEditor {
	// opts: { src, circle, aspect, initial, title, hole, onApply, onCancel }
	constructor(plugin, opts) {
		this.plugin = plugin;
		this.opts = opts;
		this.type = 'crop';
		this.closed = false;
	}

	open() {
		this.plugin.activeMode = this;
		this.dim = document.body.createDiv({ cls: 'dp-dim' });
		const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
		for (const type of ['pointerdown', 'mousedown', 'click', 'contextmenu', 'wheel']) {
			this.dim.addEventListener(type, swallow);
		}
		this._keyHandler = (e) => {
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancel(); }
		};
		window.addEventListener('keydown', this._keyHandler, true);

		this.stage = document.body.createDiv({ cls: 'dp-crop-stage' });
		this.img = this.stage.createEl('img');
		this.img.draggable = false;
		this.img.addEventListener('load', () => this.layout());
		this.img.addEventListener('error', () => {
			new Notice('Desk Photos: could not load the image for cropping.');
			this.cancel();
		});

		this.region = this.stage.createDiv({ cls: 'dp-crop-region' });
		if (this.opts.circle) this.region.addClass('dp-circle');
		if (this.opts.hole) {
			const h = this.region.createDiv({ cls: 'dp-crop-hole' });
			h.style.left = (this.opts.hole.x * 100) + '%';
			h.style.right = (this.opts.hole.x * 100) + '%';
			h.style.top = (this.opts.hole.y * 100) + '%';
			h.style.bottom = (this.opts.hole.y * 100) + '%';
			if (this.opts.hole.circle) h.style.borderRadius = '50%';
		}
		this.region.addEventListener('pointerdown', (e) => this.startMove(e));
		for (const c of ['nw', 'ne', 'se', 'sw']) {
			const el = this.region.createDiv({ cls: 'dp-crop-h dp-ch-' + c });
			el.addEventListener('pointerdown', (e) => this.startResize(e, c));
		}

		this.bar = document.body.createDiv({ cls: 'dp-box dp-crop-bar' });
		this.bar.createSpan({ text: this.opts.title || 'Crop image' });
		const apply = this.bar.createEl('button', { text: 'Apply', cls: 'mod-cta' });
		const cancel = this.bar.createEl('button', { text: 'Cancel' });
		apply.addEventListener('click', () => this.apply());
		cancel.addEventListener('click', () => this.cancel());

		this.img.src = this.opts.src;
	}

	layout() {
		const nw = this.img.naturalWidth || 300, nh = this.img.naturalHeight || 300;
		const maxW = window.innerWidth * 0.76, maxH = window.innerHeight * 0.62;
		const scale = Math.min(maxW / nw, maxH / nh);
		this.W = Math.max(60, Math.round(nw * scale));
		this.H = Math.max(60, Math.round(nh * scale));
		this.stage.style.width = this.W + 'px';
		this.stage.style.height = this.H + 'px';

		const aspect = this.opts.aspect || 1;
		const init = this.opts.initial;
		let w = Math.min(this.W, this.H * aspect);
		let h = w / aspect;
		let x = (this.W - w) / 2, y = (this.H - h) / 2;
		if (init && init.w > 0 && init.h > 0) {
			const cx = (init.x + init.w / 2) * this.W;
			const cy = (init.y + init.h / 2) * this.H;
			w = Math.min(init.w * this.W, this.W, this.H * aspect);
			h = w / aspect;
			x = clamp(cx - w / 2, 0, this.W - w);
			y = clamp(cy - h / 2, 0, this.H - h);
		}
		this.rect = { x, y, w, h };
		this.syncRegion();
	}

	syncRegion() {
		const r = this.rect;
		this.region.style.left = r.x + 'px';
		this.region.style.top = r.y + 'px';
		this.region.style.width = r.w + 'px';
		this.region.style.height = r.h + 'px';
	}

	startMove(e) {
		if (e.button !== 0) return;
		e.preventDefault(); e.stopPropagation();
		const r0 = Object.assign({}, this.rect);
		dragTrack(e, {
			onMove: (dx, dy) => {
				this.rect.x = clamp(r0.x + dx, 0, this.W - this.rect.w);
				this.rect.y = clamp(r0.y + dy, 0, this.H - this.rect.h);
				this.syncRegion();
			},
		});
	}

	startResize(e, corner) {
		if (e.button !== 0) return;
		e.preventDefault(); e.stopPropagation();
		const aspect = this.opts.aspect || 1;
		const r0 = Object.assign({}, this.rect);
		// Opposite corner stays fixed.
		const ax = corner.includes('w') ? r0.x + r0.w : r0.x;
		const ay = corner.includes('n') ? r0.y + r0.h : r0.y;
		const sx = corner.includes('w') ? -1 : 1;
		const sy = corner.includes('n') ? -1 : 1;
		dragTrack(e, {
			onMove: (dx, dy) => {
				let w = r0.w + sx * dx;
				const availX = sx > 0 ? this.W - ax : ax;
				const availY = sy > 0 ? this.H - ay : ay;
				w = clamp(w, 30, Math.min(availX, availY * aspect));
				const h = w / aspect;
				this.rect.w = w;
				this.rect.h = h;
				this.rect.x = sx > 0 ? ax : ax - w;
				this.rect.y = sy > 0 ? ay : ay - h;
				this.syncRegion();
			},
		});
	}

	apply() {
		const crop = {
			x: this.rect.x / this.W, y: this.rect.y / this.H,
			w: this.rect.w / this.W, h: this.rect.h / this.H,
		};
		this.cleanup();
		this.opts.onApply(crop);
	}

	cancel() {
		this.cleanup();
		if (this.opts.onCancel) this.opts.onCancel();
	}

	// Called by plugin.endMode()
	finish() { this.cancel(); }

	cleanup() {
		if (this.closed) return;
		this.closed = true;
		if (this.plugin.activeMode === this) this.plugin.activeMode = null;
		window.removeEventListener('keydown', this._keyHandler, true);
		this.dim.remove();
		this.stage.remove();
		this.bar.remove();
		this.plugin.processErrors();
	}
}

/* ------------------------------------------------------------------ */
/* Resize/rotate mode: edge handles, aspect lock, rotate handle        */
/* ------------------------------------------------------------------ */

class ResizeMode {
	constructor(plugin, view) {
		this.plugin = plugin;
		this.view = view;
		this.type = 'resize';
		this.closed = false;
	}

	open() {
		this.plugin.activeMode = this;
		this.before = this.plugin.snapshot();
		this.view.mode = 'resize';
		this.view.rootEl.addClass('dp-resizing');
		this.els = [];
		for (const side of ['left', 'right', 'top', 'bottom']) {
			const h = this.view.rootEl.createDiv({ cls: 'dp-handle dp-h-' + side });
			h.addEventListener('pointerdown', (e) => this.startResize(e, side));
			this.els.push(h);
		}
		this.lockBtn = this.view.rootEl.createDiv({ cls: 'dp-lockbtn' });
		this.updateLockIcon();
		this.lockBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
		this.lockBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.view.photo.aspectLocked = !this.view.photo.aspectLocked;
			this.updateLockIcon();
		});
		this.els.push(this.lockBtn);
		this.rotBtn = this.view.rootEl.createDiv({ cls: 'dp-rotbtn' });
		setIcon(this.rotBtn, 'rotate-cw');
		this.rotBtn.setAttribute('aria-label', 'Rotate desk photo');
		this.rotBtn.addEventListener('pointerdown', (e) => this.startRotate(e));
		this.els.push(this.rotBtn);

		this._outside = (e) => {
			if (!this.view.rootEl.contains(e.target)) this.finish();
		};
		this._esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); this.finish(); } };
		document.addEventListener('pointerdown', this._outside, true);
		document.addEventListener('keydown', this._esc, true);
		new Notice('Drag the edge handles to resize and the bottom handle to rotate. Click anywhere else to finish.', 4000);
	}

	updateLockIcon() {
		setIcon(this.lockBtn, this.view.photo.aspectLocked ? 'lock' : 'lock-open');
		this.lockBtn.setAttribute('aria-label',
			this.view.photo.aspectLocked ? 'Aspect ratio locked' : 'Aspect ratio unlocked');
	}

	startResize(e, side) {
		if (e.button !== 0) return;
		e.preventDefault(); e.stopPropagation();
		const p = this.view.photo;
		const w0 = p.size.w, h0 = p.size.h;
		const pos0 = { x: p.pos.x, y: p.pos.y };
		const lr = this.plugin.layerEl.getBoundingClientRect();
		const maxW = Math.max(MIN_PHOTO_PX, lr.width);
		const maxH = Math.max(MIN_PHOTO_PX, lr.height);
		const ratio = h0 > 0 && w0 > 0 ? h0 / w0 : 1;
		// Work in the photo's rotated axes so handles behave naturally.
		const rad = (p.rot || 0) * Math.PI / 180;
		const cos = Math.cos(rad), sin = Math.sin(rad);
		dragTrack(e, {
			onMove: (dx, dy) => {
				const ldx = dx * cos + dy * sin;
				const ldy = -dx * sin + dy * cos;
				let w = w0, h = h0, sx = 0, sy = 0;
				if (side === 'right') { w = w0 + ldx; sx = 1; }
				else if (side === 'left') { w = w0 - ldx; sx = -1; }
				else if (side === 'bottom') { h = h0 + ldy; sy = 1; }
				else { h = h0 - ldy; sy = -1; }
				w = clamp(w, MIN_PHOTO_PX, maxW);
				h = clamp(h, MIN_PHOTO_PX, maxH);
				if (p.aspectLocked || p.shape === 'circle') {
					if (sx) { h = clamp(w * ratio, MIN_PHOTO_PX, maxH); w = h / ratio; }
					else { w = clamp(h / ratio, MIN_PHOTO_PX, maxW); h = w * ratio; }
				}
				// Keep the opposite edge anchored: shift the center along the
				// photo's local axes, rotated back into screen space.
				const lsx = (sx * (w - w0)) / 2, lsy = (sy * (h - h0)) / 2;
				const shiftX = lsx * cos - lsy * sin;
				const shiftY = lsx * sin + lsy * cos;
				p.size.w = Math.round(w);
				p.size.h = Math.round(h);
				p.pos.x = clamp(pos0.x + shiftX / lr.width, 0.01, 0.99);
				p.pos.y = clamp(pos0.y + shiftY / lr.height, 0.01, 0.99);
				this.view.applyPosition();
				this.view.applyGeometry();
			},
		});
	}

	startRotate(e) {
		if (e.button !== 0) return;
		e.preventDefault(); e.stopPropagation();
		const p = this.view.photo;
		const el = this.view.rootEl;
		dragTrack(e, {
			onMove: (dx, dy, ev) => {
				const r = el.getBoundingClientRect();
				const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
				let ang = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI - 90;
				while (ang <= -180) ang += 360;
				while (ang > 180) ang -= 360;
				for (const s of [0, 90, 180, -90, -180]) {
					if (Math.abs(ang - s) < 4) { ang = s; break; }
				}
				p.rot = Math.round(ang);
				this.view.applyTransform();
			},
		});
	}

	finish() {
		if (this.closed) return;
		this.closed = true;
		document.removeEventListener('pointerdown', this._outside, true);
		document.removeEventListener('keydown', this._esc, true);
		for (const el of this.els) el.remove();
		this.view.rootEl.removeClass('dp-resizing');
		this.view.mode = null;
		if (this.plugin.activeMode === this) this.plugin.activeMode = null;
		this.plugin.commit(this.before);
		this.view.render();
		this.plugin.processErrors();
	}
}

/* ------------------------------------------------------------------ */
/* Slider mode: a small 0–100% slider next to the photo                */
/* ------------------------------------------------------------------ */

class SliderMode {
	// opts: { title, get(), set(v) } — v runs 0..1, shown as 0–100%.
	// The slider disappears when the user clicks outside the photo.
	constructor(plugin, view, opts) {
		this.plugin = plugin;
		this.view = view;
		this.opts = opts;
		this.type = 'slider';
		this.closed = false;
	}

	open() {
		this.plugin.activeMode = this;
		this.before = this.plugin.snapshot();
		this.box = document.body.createDiv({ cls: 'dp-box dp-radiusbox' });
		this.box.createSpan({ text: this.opts.title });
		const range = this.box.createEl('input', { type: 'range' });
		range.min = '0'; range.max = '100';
		range.value = String(Math.round(this.opts.get() * 100));
		const val = this.box.createSpan({ cls: 'dp-radius-val', text: range.value + '%' });
		range.addEventListener('input', () => {
			this.opts.set(Number(range.value) / 100);
			val.setText(range.value + '%');
			this.view.applyGeometry();
		});
		if (this.opts.reset != null) {
			const reset = this.box.createEl('button', { text: 'Reset to default' });
			reset.addEventListener('click', () => {
				this.opts.set(this.opts.reset);
				range.value = String(Math.round(this.opts.reset * 100));
				val.setText(range.value + '%');
				this.view.applyGeometry();
			});
		}
		placeBoxNear(this.box, this.view.rootEl.getBoundingClientRect());

		this._outside = (e) => {
			if (this.view.rootEl.contains(e.target) || this.box.contains(e.target)) return;
			this.finish();
		};
		this._esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); this.finish(); } };
		document.addEventListener('pointerdown', this._outside, true);
		document.addEventListener('keydown', this._esc, true);
	}

	finish() {
		if (this.closed) return;
		this.closed = true;
		document.removeEventListener('pointerdown', this._outside, true);
		document.removeEventListener('keydown', this._esc, true);
		this.box.remove();
		if (this.plugin.activeMode === this) this.plugin.activeMode = null;
		this.plugin.commit(this.before);
		this.view.render();
		this.plugin.processErrors();
	}
}

/* ------------------------------------------------------------------ */
/* Decorations: shared editor for tapes, pins, and text boxes          */
/* ------------------------------------------------------------------ */

const DECOR = {
	tape: {
		key: 'tapes', container: 'tapesEl', cls: 'dp-tape', title: 'Tapes',
		colorBtn: true, editable: false,
		noRoom: 'No room for a tape there.',
		help: [
			'Double-click the photo to add a tape.',
			'Click a tape to select it, then drag it to move.',
			'Drag a corner handle to resize.',
			'Use the top button to change color and transparency.',
			'Drag the bottom handle to rotate.',
			'Right-click a selected tape to remove it.',
			'Tapes may hang over the edge but must touch the photo, and cannot overlap each other.',
		],
		make: (pt) => ({
			x: pt.x, y: pt.y, w: TAPE_DEFAULT.w, h: TAPE_DEFAULT.h,
			rot: Math.round(Math.random() * 20 - 10),
			color: TAPE_DEFAULT.color, alpha: TAPE_DEFAULT.alpha,
		}),
		valid: (items, c, i, W, H) => tapeIsValid(items, c, i, W, H),
		sync: (view, el, t) => view.syncBoxStyle(el, t),
		resize: (t0, ld, sx, sy, d) => ({
			w: clamp(t0.w + (2 * sx * ld.x) / d.width, TAPE_MIN_W, TAPE_MAX_W),
			h: clamp(t0.h + (2 * sy * ld.y) / d.width, TAPE_MIN_H, TAPE_MAX_H),
		}),
	},
	pin: {
		key: 'pins', container: 'pinsEl', cls: 'dp-pin', title: 'Pins',
		colorBtn: true, editable: false,
		noRoom: 'No room for a pin there.',
		help: [
			'Double-click the photo to add a pin.',
			'Click a pin to select it, then drag it to move.',
			'Drag a corner handle to resize.',
			'Use the top button to change the head color and transparency.',
			'Drag the bottom handle to rotate.',
			'Right-click a selected pin to remove it.',
			'The pin’s point must stay on the photo; pins cannot overlap each other.',
		],
		make: (pt) => ({
			x: clamp(pt.x, 0, 1), y: clamp(pt.y, 0, 1), w: PIN_DEFAULT.w,
			rot: Math.round(Math.random() * 30 - 15),
			color: PIN_DEFAULT.color, alpha: PIN_DEFAULT.alpha,
		}),
		valid: (items, c, i, W, H) => pinIsValid(items, c, i, W, H),
		sync: (view, el, t) => view.syncPinStyle(el, t),
		resize: (t0, ld, sx, sy, d) => ({
			w: clamp(t0.w + (sx * ld.x + sy * ld.y) / d.width, PIN_MIN_W, PIN_MAX_W),
		}),
	},
	text: {
		key: 'texts', container: 'textsEl', cls: 'dp-text', title: 'Texts',
		colorBtn: false, editable: true,
		noRoom: 'No room for a text box there.',
		help: [
			'Double-click the photo to add a text box.',
			'Click a text box to select it; click it again to edit its text.',
			'Hold the button above the selected text box to drag it around.',
			'Drag a corner handle to resize, and the bottom handle to rotate.',
			'Use the toolbar below to style the selected text and set its size.',
			'To change the font, type the name of a font installed on your system into the toolbar’s font box (leave it empty for the default font).',
			'Right-click a selected text box to remove it.',
			'The text itself must stay inside the photo and cannot overlap other texts — the box edges may hang outside.',
		],
		make: (pt) => ({
			x: pt.x, y: pt.y, w: TEXT_DEFAULT.w, h: TEXT_DEFAULT.h, rot: 0,
			fs: TEXT_DEFAULT.h * TEXT_FONT_RATIO,
			text: 'Text', color: TEXT_DEFAULT.color, alpha: TEXT_DEFAULT.alpha,
			font: '', bold: false, italic: false, underline: false, strike: false,
		}),
		valid: (items, c, i, W, H, ctx) =>
			textIsValid(items, c, i, W, H, ctx && ctx.metricOf, ctx && ctx.bounds),
		sync: (view, el, t) => view.syncBoxStyle(el, t),
		resize: (t0, ld, sx, sy, d) => ({
			w: clamp(t0.w + (2 * sx * ld.x) / d.width, TEXT_MIN_W, TEXT_MAX_W),
			h: clamp(t0.h + (2 * sy * ld.y) / d.width, TEXT_MIN_H, TEXT_MAX_H),
		}),
	},
};
DECOR.backText = Object.assign({}, DECOR.text, {
	key: 'backTexts', container: 'backTextsEl', title: 'Hidden texts',
	help: [
		'These text boxes live on the back of the photo and only show while it is flipped.',
	].concat(DECOR.text.help),
});

class DecorEditor {
	constructor(plugin, view, kind) {
		this.plugin = plugin;
		this.view = view;
		this.kind = kind;
		this.cfg = DECOR[kind];
		this.type = 'decor';
		this.sel = -1;
		this.closed = false;
	}

	items() { return this.view.photo[this.cfg.key]; }
	container() { return this.view[this.cfg.container]; }
	els() { return this.view.decorEls[this.kind]; }

	open() {
		this.plugin.activeMode = this;
		this.before = this.plugin.snapshot();
		this.view.mode = 'decor';
		this.view.rootEl.addClass('dp-decor-mode');
		this.view.rootEl.addClass('dp-mode-' + this.kind);

		this.spot = new Spotlight(this.plugin, this.view, {
			onDimClick: () => this.select(-1),
			onEscape: () => this.finish(),
		});
		this.spot.open();

		this.box = document.body.createDiv({ cls: 'dp-box dp-tapebox' });
		this.box.createEl('h3', { text: this.cfg.title });
		const ul = this.box.createEl('ul', { cls: 'dp-tape-help' });
		for (const line of this.cfg.help) ul.createEl('li', { text: line });
		if (this.cfg.editable) this.buildToolbar();
		const done = this.box.createEl('button', { text: 'Done', cls: 'mod-cta' });
		done.addEventListener('click', () => this.finish());
		this.spot.addBox(this.box);
		placeBoxNear(this.box, this.spot.holder.getBoundingClientRect());
	}

	/* --- coordinate helpers (photo may be rotated) --- */

	boxDims() {
		return {
			width: this.container().offsetWidth || 1,
			height: this.container().offsetHeight || 1,
		};
	}

	localPoint(clientX, clientY) {
		const r = this.container().getBoundingClientRect();
		const rad = -(this.view.photo.rot || 0) * Math.PI / 180;
		const dx = clientX - (r.left + r.width / 2);
		const dy = clientY - (r.top + r.height / 2);
		const d = this.boxDims();
		return {
			x: (dx * Math.cos(rad) - dy * Math.sin(rad) + d.width / 2) / d.width,
			y: (dx * Math.sin(rad) + dy * Math.cos(rad) + d.height / 2) / d.height,
		};
	}

	localDelta(dx, dy, extraRot) {
		const rad = ((this.view.photo.rot || 0) + (extraRot || 0)) * Math.PI / 180;
		const cos = Math.cos(rad), sin = Math.sin(rad);
		return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
	}

	localToScreen(fx, fy) {
		const r = this.container().getBoundingClientRect();
		const d = this.boxDims();
		const rad = (this.view.photo.rot || 0) * Math.PI / 180;
		const lx = (fx - 0.5) * d.width, ly = (fy - 0.5) * d.height;
		return {
			x: r.left + r.width / 2 + lx * Math.cos(rad) - ly * Math.sin(rad),
			y: r.top + r.height / 2 + lx * Math.sin(rad) + ly * Math.cos(rad),
		};
	}

	/* --- pointer handling --- */

	onPointerDown(e) {
		if (e.button !== 0) return;
		const itemEl = e.target.closest ? e.target.closest('.' + this.cfg.cls) : null;
		if (itemEl && this.container().contains(itemEl)) {
			const idx = Number(itemEl.dataset.idx);
			// A second click on the selected text box goes to the caret.
			if (this.cfg.editable && idx === this.sel) return;
			e.preventDefault(); e.stopPropagation();
			this.select(idx);
			this.beginMove(e, idx);
		} else {
			// Empty area: a single click only deselects; adding is double-click.
			e.preventDefault(); e.stopPropagation();
			this.select(-1);
		}
	}

	onDblClick(e) {
		e.preventDefault(); e.stopPropagation();
		const itemEl = e.target.closest ? e.target.closest('.' + this.cfg.cls) : null;
		if (itemEl && this.container().contains(itemEl)) return;
		this.addItem(e);
	}

	onContextMenu(e) {
		e.preventDefault(); e.stopPropagation();
		const itemEl = e.target.closest ? e.target.closest('.' + this.cfg.cls) : null;
		if (!itemEl || !this.container().contains(itemEl)) return;
		const idx = Number(itemEl.dataset.idx);
		if (idx === this.sel) {
			this.items().splice(idx, 1);
			this.sel = -1;
			this.closePopover();
			this.view.renderDecor(this.kind);
			this.removeSelUI();
			if (this.cfg.editable) this.updateToolbar();
		} else {
			this.select(idx);
		}
	}

	// Measurement context for text validity: graphics are measured from the
	// rendered DOM; estimated for items that are not rendered yet. Bounds
	// widen the allowed area by the frame paddings.
	validCtx() {
		if (!this.cfg.editable) return undefined;
		const d = this.boxDims();
		const g = frameGeom(this.view.photo);
		return {
			metricOf: (i, t) => textGraphicMetric(i >= 0 ? this.els()[i] : null, t, d.width),
			bounds: { l: g.left, t: g.top, r: g.right, b: g.bottom },
		};
	}

	addItem(e) {
		const d = this.boxDims();
		const pt = this.localPoint(e.clientX, e.clientY);
		let t = this.cfg.make(pt);
		if (!this.cfg.valid(this.items(), t, -1, d.width, d.height, this.validCtx()) && this.cfg.editable) {
			// Nudge new text boxes toward the interior.
			const halfX = t.w / 2, halfY = (t.h * d.width) / d.height / 2;
			t = Object.assign({}, t, {
				x: clamp(pt.x, halfX + 0.01, 0.99 - halfX),
				y: clamp(pt.y, halfY + 0.01, 0.99 - halfY),
			});
		}
		if (!this.cfg.valid(this.items(), t, -1, d.width, d.height, this.validCtx())) {
			new Notice(this.cfg.noRoom);
			return;
		}
		this.items().push(t);
		this.view.renderDecor(this.kind);
		this.select(this.items().length - 1);
		if (this.cfg.editable) this.focusText(this.sel);
	}

	select(idx) {
		if (this.cfg.editable && this.sel >= 0) {
			const prev = this.els()[this.sel];
			if (prev && prev._inner) {
				prev._inner.removeAttribute('contenteditable');
				prev._inner.blur();
			}
		}
		this.sel = idx;
		this.closePopover();
		this.removeSelUI();
		if (this.cfg.editable) this.updateToolbar();
		if (idx < 0 || idx >= this.items().length) return;
		if (this.cfg.editable) {
			const el = this.els()[idx];
			if (el && el._inner) {
				el._inner.setAttribute('contenteditable', 'plaintext-only');
				el._inner.oninput = () => {
					const t = this.items()[idx];
					if (t) t.text = el._inner.textContent;
				};
			}
		}
		this.renderSelUI();
	}

	focusText(idx) {
		const el = this.els()[idx];
		if (!el || !el._inner) return;
		el._inner.focus();
		try {
			const s = window.getSelection();
			s.selectAllChildren(el._inner);
			s.collapseToEnd();
		} catch (e) { /* caret position is cosmetic */ }
	}

	removeSelUI() {
		if (this.selEl) { this.selEl.remove(); this.selEl = null; }
	}

	renderSelUI() {
		const t = this.items()[this.sel];
		this.selEl = this.container().createDiv({ cls: 'dp-tape-sel' });
		this.cfg.sync(this.view, this.selEl, t);
		const corners = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] };
		for (const [c, [sx, sy]] of Object.entries(corners)) {
			const h = this.selEl.createDiv({ cls: 'dp-tsel-h dp-c-' + c });
			h.addEventListener('pointerdown', (e) => this.startResize(e, sx, sy));
		}
		if (this.cfg.colorBtn) {
			const colorBtn = this.selEl.createDiv({ cls: 'dp-tsel-btn dp-tsel-color' });
			setIcon(colorBtn, 'palette');
			colorBtn.setAttribute('aria-label', 'Change color');
			colorBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
			colorBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openPopover(); });
		}
		if (this.cfg.editable) {
			// Text boxes are drag-handled from above: clicks on the box itself
			// go to the text caret, so the body cannot double as a drag target.
			const moveBtn = this.selEl.createDiv({ cls: 'dp-tsel-btn dp-tsel-move' });
			setIcon(moveBtn, 'move');
			moveBtn.setAttribute('aria-label', 'Hold to drag');
			moveBtn.addEventListener('pointerdown', (e) => {
				if (e.button !== 0) return;
				e.preventDefault(); e.stopPropagation();
				this.beginMove(e, this.sel, true);
			});
		}
		const rotBtn = this.selEl.createDiv({ cls: 'dp-tsel-btn dp-tsel-rot' });
		setIcon(rotBtn, 'rotate-cw');
		rotBtn.setAttribute('aria-label', 'Rotate');
		rotBtn.addEventListener('pointerdown', (e) => this.startRotate(e));
	}

	sync(idx) {
		const t = this.items()[idx];
		const el = this.els()[idx];
		if (el) {
			this.cfg.sync(this.view, el, t);
			if (this.cfg.editable) this.view.styleTextEl(el, t);
		}
		if (idx === this.sel && this.selEl) this.cfg.sync(this.view, this.selEl, t);
	}

	tryApply(idx, cand, fallbacks) {
		const d = this.boxDims();
		const ctx = this.validCtx();
		const all = [cand].concat(fallbacks || []);
		for (const c of all) {
			if (this.cfg.valid(this.items(), c, idx, d.width, d.height, ctx)) {
				Object.assign(this.items()[idx], c);
				this.sync(idx);
				return true;
			}
		}
		return false;
	}

	beginMove(e, idx, fromHandle) {
		const d = this.boxDims();
		const t0 = Object.assign({}, this.items()[idx]);
		let moved = false;
		dragTrack(e, {
			onMove: (dx, dy) => {
				if (!moved && Math.hypot(dx, dy) < 3) return;
				moved = true;
				const ld = this.localDelta(dx, dy, 0);
				const nx = t0.x + ld.x / d.width;
				const ny = t0.y + ld.y / d.height;
				this.tryApply(idx, Object.assign({}, t0, { x: nx, y: ny }), [
					Object.assign({}, this.items()[idx], { x: nx }),
					Object.assign({}, this.items()[idx], { y: ny }),
				]);
			},
			onEnd: () => {
				// A click (no movement) on a fresh text box starts editing.
				if (!moved && !fromHandle && this.cfg.editable && idx === this.sel) this.focusText(idx);
			},
		});
	}

	startResize(e, sx, sy) {
		if (e.button !== 0) return;
		e.preventDefault(); e.stopPropagation();
		const idx = this.sel;
		const d = this.boxDims();
		const t0 = Object.assign({}, this.items()[idx]);
		dragTrack(e, {
			onMove: (dx, dy) => {
				const ld = this.localDelta(dx, dy, t0.rot || 0);
				const patch = this.cfg.resize(t0, ld, sx, sy, d);
				const fallbacks = [];
				if ('w' in patch && 'h' in patch) {
					fallbacks.push(Object.assign({}, this.items()[idx], { w: patch.w }));
					fallbacks.push(Object.assign({}, this.items()[idx], { h: patch.h }));
				}
				this.tryApply(idx, Object.assign({}, t0, patch), fallbacks);
			},
		});
	}

	startRotate(e) {
		if (e.button !== 0) return;
		e.preventDefault(); e.stopPropagation();
		const idx = this.sel;
		const t0 = Object.assign({}, this.items()[idx]);
		dragTrack(e, {
			onMove: (dx, dy, ev) => {
				const pivot = this.localToScreen(t0.x, t0.y);
				let ang = Math.atan2(ev.clientY - pivot.y, ev.clientX - pivot.x) * 180 / Math.PI
					- 90 - (this.view.photo.rot || 0);
				while (ang <= -180) ang += 360;
				while (ang > 180) ang -= 360;
				for (const s of [0, 90, 180, -90, -180]) {
					if (Math.abs(ang - s) < 4) { ang = s; break; }
				}
				this.tryApply(idx, Object.assign({}, t0, { rot: Math.round(ang) }), []);
			},
		});
	}

	/* --- color popover (tapes and pins) --- */

	openPopover() {
		this.closePopover();
		const t = this.items()[this.sel];
		if (!t) return;
		this.pop = document.body.createDiv({ cls: 'dp-box dp-colorpop' });
		const color = this.pop.createEl('input', { type: 'color' });
		color.value = t.color;
		const alpha = this.pop.createEl('input', { type: 'range' });
		alpha.min = '10'; alpha.max = '100'; alpha.value = String(Math.round(t.alpha * 100));
		alpha.setAttribute('aria-label', 'Transparency');
		const close = this.pop.createEl('button', { text: 'Close' });
		const update = () => {
			t.color = color.value;
			t.alpha = Number(alpha.value) / 100;
			const el = this.els()[this.sel];
			if (el && el._updateColor) {
				el._updateColor(t.color, t.alpha);
			} else if (el && el._colorEl) {
				el._colorEl.setAttribute('fill', t.color);
				el._colorEl.setAttribute('fill-opacity', String(t.alpha));
			}
		};
		color.addEventListener('input', update);
		alpha.addEventListener('input', update);
		close.addEventListener('click', () => this.closePopover());
		this.spot.addBox(this.pop);
		placeBoxNear(this.pop, this.spot.holder.getBoundingClientRect());
	}

	closePopover() {
		if (this.pop) { this.pop.remove(); this.pop = null; }
	}

	/* --- text toolbar --- */

	buildToolbar() {
		const bar = this.box.createDiv({ cls: 'dp-textbar' });
		this.tb = { bar, toggles: {} };
		const mkToggle = (prop, icon, label) => {
			const b = bar.createEl('button', { cls: 'dp-tb-btn' });
			setIcon(b, icon);
			b.setAttribute('aria-label', label);
			b.addEventListener('click', () => {
				const t = this.items()[this.sel];
				if (!t) return;
				t[prop] = !t[prop];
				this.restyleSel();
				this.updateToolbar();
			});
			this.tb.toggles[prop] = b;
		};
		mkToggle('bold', 'bold', 'Bold');
		mkToggle('italic', 'italic', 'Italic');
		mkToggle('underline', 'underline', 'Underline');
		mkToggle('strike', 'strikethrough', 'Strikethrough');
		this.tb.color = bar.createEl('input', { type: 'color', cls: 'dp-tb-color' });
		this.tb.color.setAttribute('aria-label', 'Text color');
		this.tb.color.addEventListener('input', () => {
			const t = this.items()[this.sel];
			if (!t) return;
			t.color = this.tb.color.value;
			this.restyleSel();
		});
		this.tb.alpha = bar.createEl('input', { type: 'range', cls: 'dp-tb-alpha' });
		this.tb.alpha.min = '10'; this.tb.alpha.max = '100';
		this.tb.alpha.setAttribute('aria-label', 'Text transparency');
		this.tb.alpha.addEventListener('input', () => {
			const t = this.items()[this.sel];
			if (!t) return;
			t.alpha = Number(this.tb.alpha.value) / 100;
			this.restyleSel();
		});
		const sizeWrap = bar.createDiv({ cls: 'dp-tb-size' });
		this.tb.sizeMinus = sizeWrap.createEl('button', { cls: 'dp-tb-btn' });
		setIcon(this.tb.sizeMinus, 'minus');
		this.tb.sizeMinus.setAttribute('aria-label', 'Decrease text size');
		this.tb.size = sizeWrap.createEl('input', { type: 'number', cls: 'dp-tb-sizein' });
		this.tb.size.min = '4';
		this.tb.size.max = '200';
		this.tb.size.setAttribute('aria-label', 'Text size');
		this.tb.sizePlus = sizeWrap.createEl('button', { cls: 'dp-tb-btn' });
		setIcon(this.tb.sizePlus, 'plus');
		this.tb.sizePlus.setAttribute('aria-label', 'Increase text size');
		this.tb.sizeMinus.addEventListener('click', () => this.setFontSize(this.currentFontPx() - 1));
		this.tb.sizePlus.addEventListener('click', () => this.setFontSize(this.currentFontPx() + 1));
		this.tb.size.addEventListener('change', () => this.setFontSize(Number(this.tb.size.value)));
		this.tb.font = bar.createEl('input', {
			type: 'text', cls: 'dp-tb-font', placeholder: 'Font name…',
		});
		this.tb.font.setAttribute('aria-label', 'Font (type a system font name)');
		this.tb.font.addEventListener('input', () => {
			const t = this.items()[this.sel];
			if (!t) return;
			t.font = this.tb.font.value.trim();
			this.restyleSel();
		});
		this.updateToolbar();
	}

	restyleSel() {
		const t = this.items()[this.sel];
		const el = this.els()[this.sel];
		if (t && el) this.view.styleTextEl(el, t);
	}

	currentFontPx() {
		const t = this.items()[this.sel];
		if (!t) return 0;
		const boxW = this.view.photo.size.w;
		const fs = t.fs == null ? (t.h || TEXT_DEFAULT.h) * TEXT_FONT_RATIO : t.fs;
		return Math.max(4, Math.round(fs * boxW));
	}

	// Text size is independent of the box size, stored as a fraction of the
	// image's width so it scales with the photo but not with the frame.
	// A larger font grows its box.
	setFontSize(px) {
		const t = this.items()[this.sel];
		if (!t || !isFinite(px)) return;
		const boxW = this.view.photo.size.w;
		px = clamp(Math.round(px), 4, 200);
		t.fs = px / boxW;
		const needH = (px * 1.4) / boxW;
		if ((t.h || 0) < needH) t.h = Math.min(TEXT_MAX_H, needH);
		this.tb.size.value = String(px);
		this.sync(this.sel);
	}

	updateToolbar() {
		if (!this.tb) return;
		const t = this.sel >= 0 ? this.items()[this.sel] : null;
		this.tb.bar.toggleClass('dp-tb-disabled', !t);
		for (const prop in this.tb.toggles) {
			this.tb.toggles[prop].toggleClass('is-active', !!(t && t[prop]));
			this.tb.toggles[prop].disabled = !t;
		}
		this.tb.color.disabled = !t;
		this.tb.alpha.disabled = !t;
		this.tb.font.disabled = !t;
		this.tb.size.disabled = !t;
		this.tb.sizeMinus.disabled = !t;
		this.tb.sizePlus.disabled = !t;
		if (t) {
			this.tb.color.value = t.color || '#1f1f1f';
			this.tb.alpha.value = String(Math.round((t.alpha == null ? 1 : t.alpha) * 100));
			this.tb.font.value = t.font || '';
			this.tb.size.value = String(this.currentFontPx());
		}
	}

	finish() {
		if (this.closed) return;
		this.closed = true;
		this.select(-1);
		this.closePopover();
		this.removeSelUI();
		if (this.cfg.editable) {
			// Drop text boxes that ended up empty.
			const arr = this.items();
			for (let i = arr.length - 1; i >= 0; i--) {
				if (!arr[i].text || !arr[i].text.trim()) arr.splice(i, 1);
			}
		}
		this.box.remove();
		this.view.rootEl.removeClass('dp-decor-mode');
		this.view.rootEl.removeClass('dp-mode-' + this.kind);
		this.view.mode = null;
		this.spot.close();
		if (this.plugin.activeMode === this) this.plugin.activeMode = null;
		this.plugin.commit(this.before);
		this.view.render();
		this.plugin.processErrors();
	}
}

/* ------------------------------------------------------------------ */
/* PhotoView: DOM + interaction for one desk photo                     */
/* ------------------------------------------------------------------ */

class PhotoView {
	constructor(plugin, photo) {
		this.plugin = plugin;
		this.photo = photo;
		this.mode = null;
		this.spotlighted = false;
		this.flipped = false;
		this.natW = 0;
		this.natH = 0;
		this._imgSrc = null;
		this.decorEls = { tape: [], pin: [], text: [], backText: [] };
	}

	mount(layer) {
		this.rootEl = layer.createDiv({ cls: 'desk-photo' });
		this.flipEl = this.rootEl.createDiv({ cls: 'dp-flip' });
		this.frontEl = this.flipEl.createDiv({ cls: 'dp-front' });
		this.frameEl = this.frontEl.createDiv({ cls: 'dp-frame' });
		// The frame's paint lives on a dedicated underlay so its transparency
		// never affects the image or anything else inside the frame.
		this.frameBgEl = this.frameEl.createDiv({ cls: 'dp-frame-bg' });
		this.clipEl = this.frameEl.createDiv({ cls: 'dp-clip' });
		this.imgEl = this.clipEl.createEl('img', { cls: 'dp-img' });
		this.imgEl.draggable = false;
		this.phEl = this.clipEl.createDiv({ cls: 'dp-ph' });
		setIcon(this.phEl, 'image-off');
		// Texts sit under tapes and pins so overlapping tapes/pins cover them.
		this.textsEl = this.frontEl.createDiv({ cls: 'dp-decor dp-texts' });
		this.tapesEl = this.frontEl.createDiv({ cls: 'dp-decor dp-tapes' });
		this.pinsEl = this.frontEl.createDiv({ cls: 'dp-decor dp-pins' });
		this.backEl = this.flipEl.createDiv({ cls: 'dp-back' });
		this.backBgEl = this.backEl.createDiv({ cls: 'dp-frame-bg' });
		this.backTextsEl = this.backEl.createDiv({ cls: 'dp-decor dp-texts' });

		this.imgEl.addEventListener('load', () => {
			this.natW = this.imgEl.naturalWidth || 300;
			this.natH = this.imgEl.naturalHeight || 300;
			this.setMissing(false);
			this.layoutImage();
		});
		this.imgEl.addEventListener('error', () => {
			if (!this._imgSrc) return;
			this.setMissing(true);
			this.plugin.queueError(this, 'image');
		});
		this.rootEl.addEventListener('pointerdown', (e) => this.onPointerDown(e));
		this.rootEl.addEventListener('contextmenu', (e) => this.onContextMenu(e));
		this.rootEl.addEventListener('dblclick', (e) => this.onDblClick(e));
		this.render();
	}

	destroy() {
		if (this._audio) { try { this._audio.pause(); } catch (e) { /* noop */ } }
		if (this._flipOutside) {
			document.removeEventListener('pointerdown', this._flipOutside, true);
			document.removeEventListener('wheel', this._flipOutside, { capture: true, passive: true });
			this._flipOutside = null;
		}
		if (this._flipTimer) clearTimeout(this._flipTimer);
		if (this._peekTimer) clearTimeout(this._peekTimer);
		if (this.rootEl) this.rootEl.remove();
	}

	render() {
		this.rootEl.toggleClass('dp-locked', this.photo.lock !== 'none');
		this.rootEl.toggleClass('dp-noshadow', this.photo.shadow === false);
		this.applyPosition();
		this.applyGeometry();
		this.applyImage();
		for (const kind of ['tape', 'pin', 'text', 'backText']) this.renderDecor(kind);
	}

	applyPosition() {
		if (this.spotlighted) return;
		if (this.photo.lock === 'document') {
			this.applyDocPosition();
			return;
		}
		this.rootEl.style.display = '';
		this.rootEl.style.left = (this.photo.pos.x * 100) + '%';
		this.rootEl.style.top = (this.photo.pos.y * 100) + '%';
	}

	// Pin the photo to its anchored spot inside the note it is locked to;
	// hidden while that note is not visible.
	applyDocPosition() {
		const a = this.photo.docAnchor;
		const layer = this.plugin.layerEl;
		const info = a && layer ? this.plugin.findDocScroller(a.path, this) : null;
		if (!info) {
			this.rootEl.style.display = 'none';
			return;
		}
		const sr = info.scroller.getBoundingClientRect();
		const lr = layer.getBoundingClientRect();
		this.rootEl.style.display = '';
		this.rootEl.style.left = (sr.left + a.x * sr.width - lr.left) + 'px';
		this.rootEl.style.top = (sr.top + (a.y - info.scroller.scrollTop) - lr.top) + 'px';
	}

	isHidden() {
		return this.rootEl.style.display === 'none';
	}

	applyTransform() {
		this.rootEl.style.transform =
			`translate(-50%,-50%) rotate(${this.photo.rot || 0}deg)`;
	}

	// Border radius of the frame box (also used for the back face). The
	// frame's shape is independent of the image shape, except that polaroid
	// frames stay rectangular and a frameless photo follows the image.
	frameRadius() {
		const p = this.photo, f = p.frame;
		if (f.type === 'polaroid') return '3px';
		if (f.type === 'none') {
			return p.shape === 'circle' ? '50%' : ((p.cornerRadius || 0) * 50) + '%';
		}
		return f.shape === 'circle' ? '50%' : ((f.cornerRadius || 0) * 50) + '%';
	}

	applyGeometry() {
		const p = this.photo, f = p.frame;
		this.applyTransform();
		const g = frameGeom(p);
		const fe = this.frameEl;
		const bg = this.frameBgEl;
		fe.style.padding = `${g.top}px ${g.right}px ${g.bottom}px ${g.left}px`;
		fe.style.borderRadius = this.frameRadius();
		bg.style.backgroundColor = '';
		bg.style.backgroundImage = '';
		bg.style.backgroundSize = '';
		bg.style.backgroundPosition = '';
		bg.style.backgroundBlendMode = '';
		// 0% transparency keeps the frame barely visible, matching the image.
		bg.style.opacity = String(0.06 + 0.94 * (f.alpha == null ? 1 : f.alpha));
		if (f.type === 'blank' || f.type === 'polaroid') {
			bg.style.backgroundColor = f.color || '#ffffff';
			if (f.type === 'blank' && f.texture) this.applyFrameTexture();
		}
		this.clipEl.style.width = p.size.w + 'px';
		this.clipEl.style.height = p.size.h + 'px';
		this.clipEl.style.borderRadius =
			p.shape === 'circle' ? '50%' : ((p.cornerRadius || 0) * 50) + '%';
		// 0% transparency keeps the image barely visible, never fully gone.
		this.imgEl.style.opacity =
			String(0.06 + 0.94 * (p.imageAlpha == null ? 1 : p.imageAlpha));
		this.imgEl.style.filter = imageFilter(p);
		// Text containers track the image box (not the frame-included outer
		// box), so frame changes never move or rescale texts.
		for (const cont of [this.textsEl, this.backTextsEl]) {
			cont.style.left = g.left + 'px';
			cont.style.top = g.top + 'px';
			cont.style.width = p.size.w + 'px';
			cont.style.height = p.size.h + 'px';
		}
		this.refreshTextStyles();
		this.styleBack();
		this.layoutImage();
	}

	// Text sizes are fractions of the photo's width, so they must be
	// re-applied live while the photo is being resized.
	refreshTextStyles() {
		for (const kind of ['text', 'backText']) {
			const items = this.photo[DECOR[kind].key] || [];
			this.decorEls[kind].forEach((el, i) => {
				if (items[i]) this.styleTextEl(el, items[i]);
			});
		}
	}

	// The back of the photo: just the frame's shape, color, or texture.
	styleBack() {
		const p = this.photo, f = p.frame;
		const be = this.backEl;
		const bg = this.backBgEl;
		be.style.borderRadius = this.frameRadius();
		bg.style.backgroundColor = '';
		bg.style.backgroundImage = '';
		bg.style.backgroundSize = '';
		bg.style.backgroundPosition = '';
		bg.style.backgroundBlendMode = '';
		bg.style.opacity = String(0.06 + 0.94 * (f.alpha == null ? 1 : f.alpha));
		if (f.type === 'blank' || f.type === 'polaroid') {
			bg.style.backgroundColor = f.color || '#ffffff';
			if (f.type === 'blank' && f.texture) {
				const src = this.plugin.resolveSrc(f.texture);
				if (src) {
					bg.style.backgroundImage = `url("${cssUrl(src)}")`;
					bg.style.backgroundSize = 'cover';
					bg.style.backgroundPosition = 'center';
					bg.style.backgroundBlendMode = 'multiply';
				}
			}
		} else {
			// No frame: plain photo-paper back, unaffected by frame alpha.
			bg.style.backgroundColor = '#efe9da';
			bg.style.opacity = '1';
		}
	}

	applyFrameTexture() {
		const p = this.photo, f = p.frame;
		const texture = f.texture;
		const src = this.plugin.resolveSrc(texture);
		if (!src) {
			this.plugin.queueError(this, 'texture');
			return;
		}
		this.plugin.loadImageDims(src).then(({ w: nw, h: nh }) => {
			if (this.photo.frame.texture !== texture || !this.rootEl.isConnected) return;
			const o = outerSize(p);
			const c = f.textureCrop || { x: 0, y: 0, w: 1, h: 1 };
			const scale = Math.max(o.w / (c.w * nw), o.h / (c.h * nh));
			let bx = o.w / 2 - (c.x + c.w / 2) * nw * scale;
			let by = o.h / 2 - (c.y + c.h / 2) * nh * scale;
			bx = clamp(bx, o.w - nw * scale, 0);
			by = clamp(by, o.h - nh * scale, 0);
			this.frameBgEl.style.backgroundImage = `url("${cssUrl(src)}")`;
			this.frameBgEl.style.backgroundSize = `${nw * scale}px ${nh * scale}px`;
			this.frameBgEl.style.backgroundPosition = `${bx}px ${by}px`;
			this.frameBgEl.style.backgroundBlendMode = 'multiply';
		}).catch(() => this.plugin.queueError(this, 'texture'));
	}

	applyImage() {
		const src = this.plugin.resolveSrc(this.photo.image);
		if (!src) {
			this._imgSrc = null;
			this.setMissing(true);
			this.plugin.queueError(this, 'image');
			return;
		}
		if (this._imgSrc !== src) {
			this._imgSrc = src;
			this.natW = 0;
			this.natH = 0;
			this.setMissing(false);
			this.imgEl.src = src;
		} else if (this.natW) {
			this.layoutImage();
		}
	}

	setMissing(missing) {
		this.clipEl.toggleClass('dp-missing', missing);
		this.imgEl.style.display = missing ? 'none' : '';
	}

	// Position the <img> inside the clip so the chosen crop region covers it.
	layoutImage() {
		const nw = this.natW, nh = this.natH;
		if (!nw || !nh) return;
		const W = this.photo.size.w, H = this.photo.size.h;
		const c = this.photo.crop || { x: 0, y: 0, w: 1, h: 1 };
		const scale = Math.max(W / (c.w * nw), H / (c.h * nh));
		const dw = nw * scale, dh = nh * scale;
		let left = W / 2 - (c.x + c.w / 2) * nw * scale;
		let top = H / 2 - (c.y + c.h / 2) * nh * scale;
		left = clamp(left, W - dw, 0);
		top = clamp(top, H - dh, 0);
		this.imgEl.style.width = dw + 'px';
		this.imgEl.style.height = dh + 'px';
		this.imgEl.style.left = left + 'px';
		this.imgEl.style.top = top + 'px';
	}

	/* --- decorations --- */

	syncBoxStyle(el, t) {
		el.style.left = (t.x * 100) + '%';
		el.style.top = (t.y * 100) + '%';
		el.style.width = (t.w * 100) + '%';
		el.style.aspectRatio = `${t.w} / ${t.h}`;
		el.style.transformOrigin = '';
		el.style.transform = `translate(-50%,-50%) rotate(${t.rot || 0}deg)`;
	}

	// Pins anchor at their (invisible) needle tip and rotate around it.
	syncPinStyle(el, t) {
		el.style.left = (t.x * 100) + '%';
		el.style.top = (t.y * 100) + '%';
		el.style.width = (t.w * 100) + '%';
		el.style.aspectRatio = '131.64 / 123.82';
		el.style.transformOrigin = `${PIN_ANCHOR_X * 100}% ${PIN_ANCHOR_Y * 100}%`;
		el.style.transform =
			`translate(${-PIN_ANCHOR_X * 100}%,${-PIN_ANCHOR_Y * 100}%) rotate(${t.rot || 0}deg)`;
	}

	styleTextEl(el, t) {
		// Text metrics are relative to the image box, not the outer box.
		const boxW = this.photo.size.w;
		const fs = t.fs == null ? (t.h || TEXT_DEFAULT.h) * TEXT_FONT_RATIO : t.fs;
		el.style.fontSize = Math.max(4, Math.round(fs * boxW)) + 'px';
		el.style.color = hexToRgba(t.color, t.alpha);
		el.style.fontFamily = t.font || '';
		el.style.fontWeight = t.bold ? '700' : '400';
		el.style.fontStyle = t.italic ? 'italic' : 'normal';
		const deco = [t.underline ? 'underline' : null, t.strike ? 'line-through' : null]
			.filter(Boolean).join(' ');
		el.style.textDecoration = deco || 'none';
	}

	renderDecor(kind) {
		const cfg = DECOR[kind];
		const cont = this[cfg.container];
		cont.empty();
		this.decorEls[kind] = [];
		const items = this.photo[cfg.key] || [];
		items.forEach((t, i) => {
			const d = cont.createDiv({ cls: cfg.cls });
			d.dataset.idx = String(i);
			cfg.sync(this, d, t);
			if (kind === 'tape') {
				const { svg, colorEl } = buildTapeSvg(t.color, t.alpha);
				d.appendChild(svg);
				d._colorEl = colorEl;
			} else if (kind === 'pin') {
				const { svg, update } = buildPinSvg(t.color, t.alpha);
				d.appendChild(svg);
				d._updateColor = update;
			} else {
				const inner = d.createDiv({ cls: 'dp-text-inner' });
				inner.textContent = t.text || '';
				d._inner = inner;
				this.styleTextEl(d, t);
			}
			this.decorEls[kind].push(d);
		});
	}

	/* --- flipping --- */

	setFlipped(flipped) {
		if (this.flipped === flipped) return;
		this.flipped = flipped;
		this.plugin.playFlipSound();
		this.rootEl.addClass('dp-flipping');
		this.rootEl.toggleClass('dp-flipped', flipped);
		if (this._flipTimer) clearTimeout(this._flipTimer);
		this._flipTimer = window.setTimeout(() => {
			this.rootEl.removeClass('dp-flipping');
			this._flipTimer = null;
		}, 650);
		if (flipped) {
			this._flipOutside = (e) => this.maybeUnflip(e);
			document.addEventListener('pointerdown', this._flipOutside, true);
			document.addEventListener('wheel', this._flipOutside, { capture: true, passive: true });
		} else if (this._flipOutside) {
			document.removeEventListener('pointerdown', this._flipOutside, true);
			document.removeEventListener('wheel', this._flipOutside, { capture: true, passive: true });
			this._flipOutside = null;
		}
	}

	// Clicks and scroll-wheel outside the flipped photo flip it back — but
	// not clicks in menus, our floating boxes, or modals (e.g. picking
	// "Add/remove hidden text" from the flipped context menu must not unflip).
	maybeUnflip(e) {
		if (this.plugin.activeMode || this.plugin.errorActive) return;
		const t = e.target;
		if (t instanceof Element) {
			if (this.rootEl.contains(t)) return;
			if (t.closest('.menu, .dp-box, .dp-dim, .dp-holder, .modal-container, .suggestion-container, .prompt')) return;
		}
		this.setFlipped(false);
	}

	/* --- sound --- */

	playSound() {
		const p = this.photo;
		if (!p.sound) return;
		const src = this.plugin.resolveSrc(p.sound);
		if (!src) {
			this.plugin.queueError(this, 'audio');
			return;
		}
		// A fresh element per play is the most reliable restart: seeking a
		// still-playing element back to zero can silently no-op. The previous
		// element is stopped first so plays never overlap, and the new one is
		// retained on the view so it cannot be garbage-collected mid-play.
		this.stopSound();
		const audio = new Audio(src);
		audio.addEventListener('error', () => this.plugin.queueError(this, 'audio'));
		this._audio = audio;
		const pr = audio.play();
		if (pr && pr.catch) pr.catch(() => { /* reported via error event */ });
	}

	// Fade the photo down to barely visible and let pointer events pass
	// through for three seconds, so whatever it covers can be reached
	// without unlocking and moving it. Decorations hide entirely.
	peekBehind() {
		if (this._peekTimer) return;
		this.rootEl.addClass('dp-peek');
		this._peekTimer = window.setTimeout(() => {
			this._peekTimer = null;
			this.rootEl.removeClass('dp-peek');
		}, 3000);
	}

	isSoundPlaying() {
		return !!(this._audio && !this._audio.paused && !this._audio.ended);
	}

	stopSound() {
		if (!this._audio) return;
		try {
			this._audio.pause();
			this._audio.currentTime = 0;
		} catch (e) { /* nothing to stop */ }
	}

	/* --- pointer handling --- */

	onPointerDown(e) {
		const mode = this.plugin.activeMode;
		if (mode && mode.type === 'decor' && mode.view === this) {
			mode.onPointerDown(e);
			return;
		}
		if (this.spotlighted) return;
		if (e.button !== 0) return;
		if (this.flipped) { e.preventDefault(); e.stopPropagation(); return; }
		e.preventDefault();
		e.stopPropagation();
		const lr = this.plugin.layerEl.getBoundingClientRect();
		const start = { x: this.photo.pos.x, y: this.photo.pos.y };
		let before = null;
		let moved = false;
		// Sound plays on a long press (hold without moving).
		let longTimer = window.setTimeout(() => {
			longTimer = null;
			this.playSound();
		}, LONG_PRESS_MS);
		const cancelTimer = () => {
			if (longTimer) { clearTimeout(longTimer); longTimer = null; }
		};
		dragTrack(e, {
			onMove: (dx, dy) => {
				if (!moved && Math.hypot(dx, dy) < 4) return;
				if (!moved) {
					moved = true;
					cancelTimer();
					if (this.photo.lock === 'none') {
						// The undo snapshot is taken lazily, right before the
						// first position change: plain clicks and long presses
						// should not pay for a deep clone of all photos.
						before = this.plugin.snapshot();
						// Tapes and pins hide while the photo is being dragged,
						// and the slide sound marks the start of the drag.
						this.rootEl.addClass('dp-dragging');
						this.plugin.playSlideSound();
					}
				}
				if (this.photo.lock !== 'none') return;
				this.photo.pos.x = clamp(start.x + dx / lr.width, 0.01, 0.99);
				this.photo.pos.y = clamp(start.y + dy / lr.height, 0.01, 0.99);
				this.applyPosition();
			},
			onEnd: () => {
				cancelTimer();
				this.rootEl.removeClass('dp-dragging');
				if (moved && before && this.photo.lock === 'none') this.plugin.commit(before);
			},
		});
	}

	onDblClick(e) {
		const mode = this.plugin.activeMode;
		if (mode && mode.type === 'decor' && mode.view === this) {
			mode.onDblClick(e);
			return;
		}
		if (mode || this.plugin.errorActive || this.spotlighted) return;
		e.preventDefault();
		e.stopPropagation();
		this.setFlipped(!this.flipped);
	}

	onContextMenu(e) {
		const mode = this.plugin.activeMode;
		if (mode && mode.type === 'decor' && mode.view === this) {
			mode.onContextMenu(e);
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		if (this.spotlighted) return;
		if (mode && mode.type === 'resize') this.plugin.endMode();
		if (this.flipped) this.showFlippedMenu(e);
		else this.showMenu(e);
	}

	/* --- menus --- */

	showFlippedMenu(evt) {
		const plugin = this.plugin;
		const menu = new Menu();
		if (this.photo.lock === 'none') {
			menu.addItem((i) => i.setTitle('Add/remove hidden text').setIcon('type')
				.onClick(() => {
					plugin.endMode();
					new DecorEditor(plugin, this, 'backText').open();
				}));
		}
		menu.addItem((i) => i.setTitle('Flip back').setIcon('flip-horizontal')
			.onClick(() => this.setFlipped(false)));
		menu.showAtMouseEvent(evt);
	}

	showMenu(evt) {
		const plugin = this.plugin;
		const p = this.photo;
		const f = p.frame;
		const locked = p.lock !== 'none';
		const menu = new Menu();
		// Hover previews (frame type, image shape, frame shape) are
		// transient: sections push their revert here, and everything reverts
		// when the menu closes without a pick.
		const previewReverts = [];
		if (menu.onHide) menu.onHide(() => {
			for (const revert of previewReverts) revert();
		});
		// Obsidian does not close an open nested submenu when a sibling item
		// is hovered, so each scope with child submenus registers its items
		// here and closes the other submenus manually on hover.
		const makeSiblingFix = () => {
			const entries = [];
			return (item, submenu) => {
				entries.push({ item, submenu: submenu || null });
				if (item.dom) item.dom.addEventListener('mouseenter', () => {
					for (const e of entries) {
						if (e.item !== item && e.submenu && e.submenu.hide) e.submenu.hide();
					}
				});
			};
		};

		menu.addItem((i) => {
			i.setTitle('Lock desk photo').setIcon(locked ? 'lock' : 'lock-open');
			const sub = i.setSubmenu();
			sub.addItem((s) => s.setTitle('Unlocked').setIcon('lock-open')
				.setChecked(p.lock === 'none')
				.onClick(() => plugin.setLock(this, 'none')));
			sub.addItem((s) => s.setTitle('Lock to screen').setIcon('monitor')
				.setChecked(p.lock === 'screen')
				.onClick(() => plugin.setLock(this, 'screen')));
			sub.addItem((s) => s.setTitle('Lock to document').setIcon('file-text')
				.setChecked(p.lock === 'document')
				.onClick(() => plugin.setLock(this, 'document')));
		});
		menu.addSeparator();

		menu.addItem((i) => {
			const playing = this.isSoundPlaying();
			i.setTitle(playing ? 'Stop sound' : 'Play sound')
				.setIcon(playing ? 'volume-x' : 'volume-2')
				.setDisabled(!p.sound);
			if (p.sound) i.onClick(() => {
				if (playing) this.stopSound();
				else this.playSound();
			});
		});
		menu.addItem((i) => i.setTitle('Flip desk photo').setIcon('flip-horizontal')
			.onClick(() => this.setFlipped(true)));

		// Everything below only exists while the photo is unlocked.
		if (locked) {
			menu.addSeparator();
			menu.addItem((i) => i.setTitle('Peek behind').setIcon('eye')
				.onClick(() => this.peekBehind()));
			menu.showAtMouseEvent(evt);
			return;
		}
		menu.addSeparator();

		menu.addItem((i) => {
			i.setTitle('Change image').setIcon('image');
			const sub = i.setSubmenu();
			const reg = makeSiblingFix();
			sub.addItem((s) => {
				reg(s);
				s.setTitle('Select from vault').setIcon('folder').onClick(() =>
					new VaultFileModal(plugin.app, IMAGE_EXTS, (file) =>
						plugin.change(() => { p.image = { type: 'vault', path: file.path }; p.crop = null; }, this)
					).open());
			});
			sub.addItem((s) => {
				reg(s);
				s.setTitle('Enter web link').setIcon('link').onClick(() =>
					new TextPromptModal(plugin.app, 'Enter web link', 'https://example.com/image.png', (v) =>
						plugin.change(() => { p.image = { type: 'url', path: v }; p.crop = null; }, this)
					).open());
			});
			sub.addSeparator();
			sub.addItem((s) => {
				reg(s);
				s.setTitle('Crop image').setIcon('crop')
					.onClick(() => plugin.cropImage(this));
			});
			sub.addItem((s) => {
				s.setTitle('Edit image').setIcon('sliders-horizontal');
				const sub2 = s.setSubmenu();
				reg(s, sub2);
				const regEdit = makeSiblingFix();
				const slider = (label, key, neutral) => sub2.addItem((s2) => {
					regEdit(s2);
					s2.setTitle(label).onClick(() => {
						plugin.endMode();
						new SliderMode(plugin, this, {
							title: label,
							get: () => (p[key] == null ? neutral : p[key]),
							set: (v) => { p[key] = v; },
							reset: neutral,
						}).open();
					});
				});
				slider('Brightness', 'brightness', 0.5);
				slider('Contrast', 'contrast', 0.5);
				slider('Saturation', 'saturation', 0.5);
				slider('Temperature', 'temperature', 0.5);
				slider('Transparency', 'imageAlpha', 1);
				sub2.addSeparator();
				const valOf = (k) => (p[k] == null ? FILTER_RESET[k] : p[k]);
				const matches = (preset) =>
					Object.keys(preset).every((k) => Math.abs(valOf(k) - preset[k]) < 0.005);
				const applyPreset = (preset) =>
					plugin.change(() => Object.assign(p, preset), this);
				sub2.addItem((s2) => {
					s2.setTitle('Set filters').setIcon('wand');
					const sub3 = s2.setSubmenu();
					regEdit(s2, sub3);
					// Hovering a preset previews it on the image; the preview
					// reverts on mouse-out or menu close unless it is clicked.
					const filterKeys = Object.keys(FILTER_RESET);
					const origFilter = {};
					for (const k of filterKeys) origFilter[k] = p[k];
					let filterPicked = false;
					const revertFilter = () => {
						let dirty = false;
						for (const k of filterKeys) {
							if (p[k] !== origFilter[k]) {
								p[k] = origFilter[k];
								dirty = true;
							}
						}
						if (dirty) this.applyGeometry();
					};
					const previewFilter = (preset) => {
						if (filterPicked) return;
						for (const k of filterKeys) p[k] = origFilter[k];
						Object.assign(p, preset);
						this.applyGeometry();
					};
					previewReverts.push(() => { if (!filterPicked) revertFilter(); });
					const presetItem = (label, preset) => sub3.addItem((s3) => {
						s3.setTitle(label).setChecked(matches(preset))
							.onClick(() => {
								filterPicked = true;
								revertFilter(); // commit from the real, unpreviewed state
								applyPreset(preset);
							});
						if (s3.dom) {
							s3.dom.addEventListener('mouseenter', () => previewFilter(preset));
							s3.dom.addEventListener('mouseleave', () => revertFilter());
						}
					});
					presetItem('No filter', FILTER_RESET);
					for (const [label, preset] of FILTER_PRESETS) presetItem(label, preset);
				});
				sub2.addItem((s2) => {
					regEdit(s2);
					s2.setTitle('Reset to default').setIcon('rotate-ccw')
						.onClick(() => applyPreset(FILTER_RESET));
				});
			});
			sub.addItem((s) => {
				s.setTitle('Change image shape').setIcon('shapes');
				const sub2 = s.setSubmenu();
				reg(s, sub2);
				// Hovering Square/Circle previews the image shape.
				const origShape = p.shape, origH = p.size.h;
				let shapePicked = false;
				const revertShape = () => {
					if (p.shape !== origShape || p.size.h !== origH) {
						p.shape = origShape;
						p.size.h = origH;
						this.applyGeometry();
					}
				};
				const previewShape = (shape) => {
					if (shapePicked) return;
					if (shape === origShape) { revertShape(); return; }
					p.shape = shape;
					if (shape === 'circle') p.size.h = p.size.w;
					this.applyGeometry();
				};
				previewReverts.push(() => { if (!shapePicked) revertShape(); });
				const shapeItem = (shape, label, icon) => sub2.addItem((s2) => {
					s2.setTitle(label).setIcon(icon).setChecked(origShape === shape)
						.onClick(() => {
							shapePicked = true;
							revertShape(); // commit from the real, unpreviewed state
							plugin.setShape(this, shape);
						});
					if (s2.dom) {
						s2.dom.addEventListener('mouseenter', () => previewShape(shape));
						s2.dom.addEventListener('mouseleave', () => previewShape(origShape));
					}
				});
				shapeItem('square', 'Square', 'square');
				shapeItem('circle', 'Circle', 'circle');
				sub2.addSeparator();
				sub2.addItem((s2) => {
					s2.setTitle('Change corner radius').setIcon('radius')
						.setDisabled(p.shape !== 'square');
					if (p.shape === 'square') s2.onClick(() => {
						plugin.endMode();
						new SliderMode(plugin, this, {
							title: 'Corner radius',
							get: () => p.cornerRadius || 0,
							set: (v) => { p.cornerRadius = v; },
						}).open();
					});
				});
			});
		});

		menu.addItem((i) => {
			i.setTitle('Change frame').setIcon('frame');
			const sub = i.setSubmenu();
			const regF = makeSiblingFix();
			// Hovering a frame type previews it on the photo. The preview is
			// transient: it reverts on mouse-out or when the menu closes, and
			// only clicking a type commits it.
			const originalType = f.type;
			let framePicked = false;
			const preview = (type) => {
				if (framePicked || f.type === type) return;
				f.type = type;
				this.applyGeometry();
			};
			previewReverts.push(() => {
				if (!framePicked && f.type !== originalType) {
					f.type = originalType;
					this.applyGeometry();
				}
			});
			const types = [
				['none', 'No frame'], ['blank', 'Blank frame'], ['polaroid', 'Polaroid frame'],
			];
			for (const [type, label] of types) {
				sub.addItem((s) => {
					regF(s);
					s.setTitle(label).setChecked(originalType === type)
						.onClick(() => {
							framePicked = true;
							f.type = originalType; // commit from the real, unpreviewed state
							plugin.change(() => { f.type = type; }, this);
						});
					if (s.dom) {
						s.dom.addEventListener('mouseenter', () => preview(type));
						s.dom.addEventListener('mouseleave', () => preview(originalType));
					}
				});
			}
			sub.addSeparator();
			sub.addItem((s) => {
				regF(s);
				s.setTitle('Change frame size').setIcon('move-diagonal')
					.setDisabled(f.type === 'none');
				if (f.type !== 'none') s.onClick(() => {
					plugin.endMode();
					new SliderMode(plugin, this, {
						title: 'Frame size',
						get: () => (f.sizeScale == null ? 0.5 : f.sizeScale),
						set: (v) => { f.sizeScale = v; },
						reset: 0.5,
					}).open();
				});
			});
			sub.addItem((s) => {
				s.setTitle('Change frame shape').setIcon('shapes')
					.setDisabled(f.type === 'polaroid' || f.type === 'none');
				if (f.type === 'polaroid' || f.type === 'none') { regF(s); return; }
				const sub2 = s.setSubmenu();
				regF(s, sub2);
				// Hovering Square/Circle previews the frame shape.
				const origFShape = f.shape;
				let fShapePicked = false;
				const previewFShape = (shape) => {
					if (fShapePicked || f.shape === shape) return;
					f.shape = shape;
					this.applyGeometry();
				};
				previewReverts.push(() => {
					if (!fShapePicked && f.shape !== origFShape) {
						f.shape = origFShape;
						this.applyGeometry();
					}
				});
				const fShapeItem = (shape, label, icon) => sub2.addItem((s2) => {
					s2.setTitle(label).setIcon(icon)
						.setChecked(shape === 'circle' ? origFShape === 'circle' : origFShape !== 'circle')
						.onClick(() => {
							fShapePicked = true;
							f.shape = origFShape; // commit from the real, unpreviewed state
							plugin.change(() => { f.shape = shape; }, this);
						});
					if (s2.dom) {
						s2.dom.addEventListener('mouseenter', () => previewFShape(shape));
						s2.dom.addEventListener('mouseleave', () => previewFShape(origFShape));
					}
				});
				fShapeItem('square', 'Square', 'square');
				fShapeItem('circle', 'Circle', 'circle');
				sub2.addSeparator();
				sub2.addItem((s2) => {
					s2.setTitle('Change corner radius').setIcon('radius')
						.setDisabled(f.shape === 'circle');
					if (f.shape !== 'circle') s2.onClick(() => {
						plugin.endMode();
						new SliderMode(plugin, this, {
							title: 'Frame corner radius',
							get: () => f.cornerRadius || 0,
							set: (v) => { f.cornerRadius = v; },
						}).open();
					});
				});
			});
			sub.addItem((s) => {
				regF(s);
				s.setTitle('Change frame color').setIcon('palette')
					.setDisabled(f.type === 'none')
					.onClick(() => plugin.pickFrameColor(this));
			});
			sub.addItem((s) => {
				s.setTitle('Change frame texture').setIcon('image')
					.setDisabled(f.type !== 'blank');
				if (f.type !== 'blank') { regF(s); return; }
				const sub2 = s.setSubmenu();
				regF(s, sub2);
				sub2.addItem((s2) => s2.setTitle('Select from vault').setIcon('folder')
					.onClick(() => plugin.pickFrameTexture(this, 'vault')));
				sub2.addItem((s2) => s2.setTitle('Enter web link').setIcon('link')
					.onClick(() => plugin.pickFrameTexture(this, 'url')));
			});
		});

		menu.addItem((i) => {
			i.setTitle('Change sound').setIcon('volume-2');
			const sub = i.setSubmenu();
			sub.addItem((s) => s.setTitle('No sound').setChecked(!p.sound)
				.onClick(() => {
					this.stopSound();
					plugin.change(() => { p.sound = null; }, this);
				}));
			sub.addItem((s) => s.setTitle('Select from vault').setIcon('folder').onClick(() =>
				new VaultFileModal(plugin.app, AUDIO_EXTS, (file) =>
					plugin.change(() => { p.sound = { type: 'vault', path: file.path }; }, this)
				).open()));
			sub.addItem((s) => s.setTitle('Enter web link').setIcon('link').onClick(() =>
				new TextPromptModal(plugin.app, 'Enter web link', 'https://example.com/sound.mp3', (v) =>
					plugin.change(() => { p.sound = { type: 'url', path: v }; }, this)
				).open()));
		});

		menu.addItem((i) => {
			i.setTitle('Change layers').setIcon('layers');
			const sub = i.setSubmenu();
			sub.addItem((s) => s.setTitle('Bring forward').setIcon('arrow-up')
				.onClick(() => plugin.moveLayer(this, 'forward')));
			sub.addItem((s) => s.setTitle('Bring to front').setIcon('arrow-up-to-line')
				.onClick(() => plugin.moveLayer(this, 'front')));
			sub.addItem((s) => s.setTitle('Send backward').setIcon('arrow-down')
				.onClick(() => plugin.moveLayer(this, 'backward')));
			sub.addItem((s) => s.setTitle('Send to back').setIcon('arrow-down-to-line')
				.onClick(() => plugin.moveLayer(this, 'back')));
			sub.addSeparator();
			sub.addItem((s) => s.setTitle('Show all layers').setIcon('list')
				.onClick(() => new LayersModal(plugin.app, plugin).open()));
		});

		menu.addItem((i) => {
			i.setTitle('Change size/rotation').setIcon('scaling');
			i.onClick(() => {
				plugin.endMode();
				new ResizeMode(plugin, this).open();
			});
		});

		menu.addSeparator();
		menu.addItem((i) => i.setTitle('Add/remove tapes').setIcon('sticker')
			.onClick(() => {
				plugin.endMode();
				new DecorEditor(plugin, this, 'tape').open();
			}));
		menu.addItem((i) => i.setTitle('Add/remove pin').setIcon('pin')
			.onClick(() => {
				plugin.endMode();
				new DecorEditor(plugin, this, 'pin').open();
			}));
		menu.addItem((i) => i.setTitle('Add/remove texts').setIcon('type')
			.onClick(() => {
				plugin.endMode();
				new DecorEditor(plugin, this, 'text').open();
			}));
		menu.addItem((i) => i
			.setTitle(p.shadow ? 'Disable shadows' : 'Enable shadows')
			.setIcon('contrast')
			.onClick(() => plugin.change(() => { p.shadow = !p.shadow; }, this)));

		menu.addSeparator();
		menu.addItem((i) => {
			i.setTitle('Remove desk photo').setIcon('trash-2');
			if (i.setWarning) i.setWarning(true);
			i.onClick(() => plugin.removePhoto(this));
		});

		menu.showAtMouseEvent(evt);
	}
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

module.exports = class DeskPhotosPlugin extends Plugin {
	async onload() {
		// data.json holds exactly { photos: [...] } in the stable schema;
		// there is no migration from pre-release versions. The checks below
		// are light structural validation against hand-edited files only.
		const loaded = await this.loadData();
		this.data = {
			photos: (loaded && Array.isArray(loaded.photos)) ? loaded.photos : [],
		};
		for (const p of this.data.photos) {
			if (!p.frame) {
				p.frame = {
					type: 'none', shape: 'square', cornerRadius: 0, sizeScale: 0.5,
					color: '#ffffff', alpha: 1, texture: null, textureCrop: null,
				};
			} else if (!FRAME_TYPES.includes(p.frame.type)) {
				p.frame.type = 'blank';
			}
			for (const key of ['tapes', 'pins', 'texts', 'backTexts']) {
				if (!Array.isArray(p[key])) p[key] = [];
			}
		}

		this.views = new Map();
		this.undoStack = [];
		this.redoStack = [];
		this.activeMode = null;
		this.errorQueue = [];
		this.errorActive = null;
		this.errorFlags = new Set();
		this._dimCache = new Map();
		this._uiAudios = new Set();
		this._assetSounds = {};
		this._save = debounce(() => { this.saveData(this.data); }, 400);
		this._recheck = debounce(() => this.recheckSources(), 400);

		this.addCommand({
			id: 'add-desk-photo',
			name: 'Add desk photo',
			callback: () => this.promptAdd(),
		});
		this.addCommand({
			id: 'undo-desk-photo-change',
			name: 'Undo desk photo change',
			callback: () => this.undo(),
		});
		this.addCommand({
			id: 'redo-desk-photo-change',
			name: 'Redo desk photo change',
			callback: () => this.redo(),
		});
		this.addCommand({
			id: 'stop-desk-photo-sounds',
			name: 'Stop all desk photo sounds',
			callback: () => this.stopAllSounds(),
		});

		this.registerEvent(this.app.workspace.on('editor-menu', (menu) => {
			menu.addItem((i) => {
				i.setTitle('Add desk photo').setIcon('image-plus');
				const sub = i.setSubmenu ? i.setSubmenu() : null;
				if (!sub) {
					i.onClick(() => this.promptAdd());
					return;
				}
				sub.addItem((s) => s.setTitle('Select from vault').setIcon('folder')
					.onClick(() => this.addPhotoFromVault()));
				sub.addItem((s) => s.setTitle('Enter web link').setIcon('link')
					.onClick(() => this.addPhotoFromLink()));
			});
		}));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.ensureMounted()));
		this.registerEvent(this.app.workspace.on('resize', () => this.ensureMounted()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			this.updateDocLocked();
			this.processErrors();
		}));
		this.registerEvent(this.app.workspace.on('file-open', () => this.updateDocLocked()));
		// Re-verify vault sources whenever files are added, deleted, or
		// moved (the layoutReady guard skips the create-event flood that
		// Obsidian emits while indexing the vault at startup).
		const vaultChanged = () => {
			if (!this.app.workspace.layoutReady) return;
			this._recheck();
		};
		this.registerEvent(this.app.vault.on('create', vaultChanged));
		this.registerEvent(this.app.vault.on('delete', vaultChanged));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (!this.app.workspace.layoutReady) return;
			this.handleVaultRename(file, oldPath);
			this._recheck();
		}));
		this.registerDomEvent(window, 'resize', () => this.syncLayer());
		// Capture-phase so scrolls inside any note scroller reach us.
		this.registerDomEvent(document, 'scroll', () => this.onAnyScroll(), { capture: true, passive: true });
		// Retry deferred error dialogs the moment Obsidian's last modal
		// (e.g. the settings window) leaves the DOM.
		if (typeof MutationObserver !== 'undefined') {
			this._modalObserver = new MutationObserver(() => {
				if (this.errorQueue.length &&
					!document.body.querySelector('.modal-container')) {
					this.processErrors();
				}
			});
			this._modalObserver.observe(document.body, { childList: true });
		}
		this.app.workspace.onLayoutReady(() => this.mount());
	}

	onunload() {
		this.endMode();
		if (this._errorCleanup) this._errorCleanup();
		if (this._ro) { this._ro.disconnect(); this._ro = null; }
		if (this._modalObserver) { this._modalObserver.disconnect(); this._modalObserver = null; }
		for (const a of this._uiAudios) { try { a.pause(); } catch (e) { /* noop */ } }
		this._uiAudios.clear();
		if (this.layerEl) this.layerEl.remove();
		this.layerEl = null;
		for (const v of this.views.values()) v.destroy();
		this.views.clear();
		this._recheck.cancel();
		this._save.flush();
	}

	/* --- mounting ---------------------------------------------------- */

	getRootContainer() {
		const ws = this.app.workspace;
		let el = ws.rootSplit && ws.rootSplit.containerEl;
		if (!el || !el.isConnected) el = ws.containerEl.querySelector('.workspace-split.mod-root');
		return el || ws.containerEl;
	}

	// The layer lives on document.body (position: fixed) and is kept aligned
	// to the editor pane's rectangle. Mounting it inside the workspace split
	// does not work: the workspace's own stacking paints the opaque editor
	// over it, hiding the photos and swallowing their pointer events.
	mount() {
		const host = this.getRootContainer();
		if (!host) return;
		if (this.layerEl) this.layerEl.remove();
		this.hostEl = host;
		this.layerEl = document.body.createDiv({ cls: 'desk-photos-layer' });
		if (!this._ro && typeof ResizeObserver !== 'undefined') {
			this._ro = new ResizeObserver(() => this.syncLayer());
		}
		if (this._ro) {
			this._ro.disconnect();
			this._ro.observe(host);
		}
		this.syncLayer();
		this.renderAll();
	}

	syncLayer() {
		if (!this.layerEl || !this.hostEl || !this.hostEl.isConnected) return;
		const r = this.hostEl.getBoundingClientRect();
		// Photos are confined to the tab body area: the layer starts at the
		// topmost .workspace-tab-container, below the tab headers, so photos
		// can never cover the tab labels or the new-tab button.
		let top = Infinity;
		for (const el of this.hostEl.querySelectorAll('.workspace-tab-container')) {
			const cr = el.getBoundingClientRect();
			if (cr.height > 0 && cr.top < top) top = cr.top;
		}
		if (!isFinite(top) || top < r.top) top = r.top;
		this.layerEl.style.left = r.left + 'px';
		this.layerEl.style.top = top + 'px';
		this.layerEl.style.width = r.width + 'px';
		this.layerEl.style.height = Math.max(0, r.bottom - top) + 'px';
		this.updateDocLocked();
	}

	ensureMounted() {
		const host = this.getRootContainer();
		const stale = !this.layerEl || !this.layerEl.isConnected ||
			!this.hostEl || !this.hostEl.isConnected || host !== this.hostEl;
		if (!stale) { this.syncLayer(); return; }
		if (this.activeMode || this.errorActive) return;
		this.mount();
	}

	renderAll() {
		// Rebuilding views must not silence photos whose sound is playing:
		// detach their audio elements first and hand them to the recreated
		// views, so playback only stops when the owning photo is gone.
		const liveAudio = new Map();
		for (const [id, v] of this.views) {
			if (v.isSoundPlaying()) {
				liveAudio.set(id, v._audio);
				v._audio = null; // destroy() must not pause it
			}
			v.destroy();
		}
		this.views.clear();
		if (!this.layerEl || !this.layerEl.isConnected) {
			for (const a of liveAudio.values()) { try { a.pause(); } catch (e) { /* noop */ } }
			return;
		}
		for (const p of this.data.photos) {
			const v = new PhotoView(this, p);
			const audio = liveAudio.get(p.id);
			if (audio) {
				v._audio = audio;
				liveAudio.delete(p.id);
			}
			// Register before mounting: mounting synchronously detects missing
			// vault sources and queues an error, and processErrors drops queue
			// entries whose photo has no registered view yet.
			this.views.set(p.id, v);
			v.mount(this.layerEl);
		}
		// Whatever is left belongs to photos that no longer exist.
		for (const a of liveAudio.values()) { try { a.pause(); } catch (e) { /* noop */ } }
		this.processErrors();
	}

	/* --- document-locked photos ---------------------------------------- */

	// Find a visible markdown leaf showing `path` and its scrollable element.
	findDocScroller(path, view) {
		const cached = view._docCache;
		if (cached && cached.scroller.isConnected && cached.mdView.file &&
			cached.mdView.file.path === path &&
			(!cached.container.isShown || cached.container.isShown())) {
			return cached;
		}
		view._docCache = null;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const v = leaf.view;
			if (!v || !v.file || v.file.path !== path) continue;
			const container = v.containerEl;
			if (container.isShown && !container.isShown()) continue;
			const scroller = container.querySelector('.cm-scroller, .markdown-preview-view');
			if (scroller) {
				view._docCache = { mdView: v, scroller, container };
				return view._docCache;
			}
		}
		return null;
	}

	updateDocLocked() {
		if (!this.views) return;
		for (const v of this.views.values()) {
			if (v.photo.lock === 'document' && !v.spotlighted) v.applyDocPosition();
		}
	}

	onAnyScroll() {
		if (this._scrollRaf) return;
		this._scrollRaf = true;
		requestAnimationFrame(() => {
			this._scrollRaf = false;
			this.updateDocLocked();
		});
	}

	setLock(view, mode) {
		const p = view.photo;
		if (mode === p.lock) return;
		if (mode === 'document') {
			const md = this.app.workspace.getActiveViewOfType(MarkdownView);
			const scroller = md && md.file
				? md.containerEl.querySelector('.cm-scroller, .markdown-preview-view') : null;
			if (!scroller) {
				new Notice('Open a note first to lock the desk photo to it.');
				return;
			}
			const r = view.rootEl.getBoundingClientRect();
			const sr = scroller.getBoundingClientRect();
			this.change(() => {
				p.docAnchor = {
					path: md.file.path,
					x: (r.left + r.width / 2 - sr.left) / Math.max(1, sr.width),
					y: (r.top + r.height / 2 - sr.top) + scroller.scrollTop,
				};
				p.lock = 'document';
			}, view);
		} else {
			this.change(() => {
				// Keep the photo where it visually is when leaving document lock.
				if (p.lock === 'document' && !view.isHidden() && this.layerEl) {
					const r = view.rootEl.getBoundingClientRect();
					const lr = this.layerEl.getBoundingClientRect();
					p.pos.x = clamp((r.left + r.width / 2 - lr.left) / Math.max(1, lr.width), 0.01, 0.99);
					p.pos.y = clamp((r.top + r.height / 2 - lr.top) / Math.max(1, lr.height), 0.01, 0.99);
				}
				p.lock = mode;
			}, view);
		}
	}

	/* --- persistence + undo ------------------------------------------ */

	snapshot() { return deepClone(this.data.photos); }

	commit(before) {
		const after = this.snapshot();
		if (JSON.stringify(before) === JSON.stringify(after)) return;
		this.undoStack.push({ before, after });
		if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
		this.redoStack.length = 0;
		this._save();
	}

	change(fn, view) {
		const before = this.snapshot();
		fn();
		this.commit(before);
		if (view) view.render(); else this.renderAll();
	}

	undo() {
		this.endMode();
		if (this.errorActive) { new Notice('Resolve the desk photo dialog first.'); return; }
		const entry = this.undoStack.pop();
		if (!entry) { new Notice('Nothing to undo.'); return; }
		this.redoStack.push(entry);
		this.data.photos = deepClone(entry.before);
		this.renderAll();
		this._save();
	}

	redo() {
		this.endMode();
		if (this.errorActive) { new Notice('Resolve the desk photo dialog first.'); return; }
		const entry = this.redoStack.pop();
		if (!entry) { new Notice('Nothing to redo.'); return; }
		this.undoStack.push(entry);
		this.data.photos = deepClone(entry.after);
		this.renderAll();
		this._save();
	}

	endMode() {
		const m = this.activeMode;
		if (!m) return;
		this.activeMode = null;
		try { m.finish(); } catch (e) { console.error('Desk Photos:', e); }
	}

	/* --- sources ------------------------------------------------------ */

	resolveSrc(srcObj) {
		if (!srcObj || !srcObj.path) return null;
		if (srcObj.type === 'vault') {
			const f = this.app.vault.getAbstractFileByPath(normalizePath(srcObj.path));
			return f instanceof TFile ? this.app.vault.getResourcePath(f) : null;
		}
		return srcObj.path;
	}

	// UI sounds (flip.webm, slide.webm) live in the plugin's assets folder.
	// A missing file is downloaded once from the plugin's GitHub repository
	// and cached there. Failures only log to the console — the triggering
	// action must never be interrupted.
	async resolveAssetSound(name) {
		const adapter = this.app.vault.adapter;
		const rel = normalizePath(this.manifest.dir + '/assets/' + name);
		if (await adapter.exists(rel)) return adapter.getResourcePath(rel);
		const url = ASSET_SOUND_BASE_URL + name;
		const state = this._assetSounds[name];
		try {
			const resp = await requestUrl({ url });
			const dir = normalizePath(this.manifest.dir + '/assets');
			if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
			await adapter.writeBinary(rel, resp.arrayBuffer);
			if (await adapter.exists(rel)) return adapter.getResourcePath(rel);
		} catch (err) {
			if (state && !state.warned) {
				state.warned = true;
				console.error('Desk Photos: could not download ' + url + '.', err);
			}
		}
		// Last resort: stream straight from the repository.
		return url;
	}

	async playAssetSound(name) {
		try {
			if (!this.manifest || !this.manifest.dir) return;
			const state = this._assetSounds[name] || (this._assetSounds[name] = {});
			if (!state.src) {
				// One resolution at a time, shared by rapid triggers.
				if (!state.promise) state.promise = this.resolveAssetSound(name);
				state.src = await state.promise;
				state.promise = null;
				if (!state.src) return;
			}
			// A fresh element per play: reusing one element can silently fail
			// to restart while the previous playback is still active. The
			// element is retained in _uiAudios until it finishes — an
			// unreferenced audio element can be garbage-collected before it
			// turns audible, with no event and no error.
			const audio = new Audio(state.src);
			this._uiAudios.add(audio);
			const release = () => this._uiAudios.delete(audio);
			audio.addEventListener('ended', release);
			window.setTimeout(release, 30000); // safety net for stuck loads
			audio.addEventListener('error', () => {
				if (!state.warned) {
					state.warned = true;
					console.error('Desk Photos: sound ' + name + ' could not be loaded.');
				}
				state.src = null; // re-resolve on the next play
				release();
			});
			const pr = audio.play();
			if (pr && pr.catch) pr.catch((err) => {
				console.error('Desk Photos: sound ' + name + ' failed to play.', err);
				release();
			});
		} catch (err) {
			console.error('Desk Photos: sound error (' + name + ').', err);
		}
	}

	playFlipSound() { return this.playAssetSound('flip.webm'); }

	playSlideSound() { return this.playAssetSound('slide.webm'); }

	loadImageDims(src) {
		if (this._dimCache.has(src)) return this._dimCache.get(src);
		const pr = new Promise((resolve, reject) => {
			const im = new Image();
			im.onload = () => resolve({ w: im.naturalWidth || 300, h: im.naturalHeight || 300 });
			im.onerror = () => { this._dimCache.delete(src); reject(new Error('image load failed')); };
			im.src = src;
		});
		this._dimCache.set(src, pr);
		return pr;
	}

	/* --- photo lifecycle ---------------------------------------------- */

	addPhotoFromVault() {
		new VaultFileModal(this.app, IMAGE_EXTS,
			(f) => this.createPhoto({ type: 'vault', path: f.path })).open();
	}

	addPhotoFromLink() {
		new TextPromptModal(this.app, 'Enter web link', 'https://example.com/image.png',
			(v) => this.createPhoto({ type: 'url', path: v })).open();
	}

	// Used by the command palette entry, which cannot host a submenu.
	promptAdd() {
		new OptionModal(this.app, 'Add desk photo', [
			{ label: 'Select from vault', icon: 'folder', cb: () => this.addPhotoFromVault() },
			{ label: 'Enter web link', icon: 'link', cb: () => this.addPhotoFromLink() },
		]).open();
	}

	async createPhoto(image) {
		// New photos keep the image's proportions: natural size, scaled down
		// so the photo stays well under half of the editor area, and scaled
		// up a little for tiny images so they remain grabbable.
		let w = 240, h = 240;
		let loadedOk = false;
		const src = this.resolveSrc(image);
		if (src) {
			try {
				const dims = await this.loadImageDims(src);
				loadedOk = true;
				const lr = (this.layerEl && this.layerEl.isConnected)
					? this.layerEl.getBoundingClientRect()
					: { width: 800, height: 600 };
				const cap = Math.min(1,
					(lr.width * 0.45) / dims.w,
					(lr.height * 0.45) / dims.h);
				w = dims.w * cap;
				h = dims.h * cap;
				const floor = Math.max(1, 80 / Math.max(w, h));
				w = Math.max(1, Math.round(w * floor));
				h = Math.max(1, Math.round(h * floor));
			} catch (e) {
				// Unloadable image: keep the default size. The missing-source
				// flow appears once the photo renders.
			}
		}
		const n = this.data.photos.length;
		const photo = {
			id: uid(),
			image,
			crop: null,
			shape: 'square',
			cornerRadius: 0,
			shadow: true,
			imageAlpha: 1,
			brightness: 0.5,
			contrast: 0.5,
			saturation: 0.5,
			temperature: 0.5,
			pos: { x: clamp(0.5 + (n % 4) * 0.03, 0.05, 0.95), y: clamp(0.45 + (n % 4) * 0.03, 0.05, 0.95) },
			size: { w, h },
			rot: 0,
			aspectLocked: true,
			lock: 'none',
			docAnchor: null,
			frame: {
				type: 'none', shape: 'square', cornerRadius: 0, sizeScale: 0.5,
				color: '#ffffff', alpha: 1, texture: null, textureCrop: null,
			},
			sound: null,
			tapes: [],
			pins: [],
			texts: [],
			backTexts: [],
		};
		this.change(() => this.data.photos.push(photo), null);
		// Slide sound only for clean additions, not ones that will
		// immediately raise a missing-source dialog.
		if (loadedOk) this.playSlideSound();
	}

	removePhoto(view, onCancel) {
		new ConfirmModal(this.app, 'Remove desk photo',
			'Remove this desk photo? You can restore it with "Undo desk photo change".',
			'Remove',
			() => {
				this.change(() => {
					this.data.photos = this.data.photos.filter((x) => x.id !== view.photo.id);
				}, null);
				this.playSlideSound();
			},
			onCancel,
		).open();
	}

	// Nothing is mutated until the crop is applied, so Cancel keeps the
	// photo's previous shape untouched.
	setShape(view, shape) {
		const p = view.photo;
		const apply = (crop) => this.change(() => {
			p.shape = shape;
			if (shape === 'circle') p.size.h = p.size.w;
			if (crop !== undefined) p.crop = crop;
		}, view);
		const src = this.resolveSrc(p.image);
		if (!src || !view.natW) {
			apply(undefined);
			return;
		}
		const w = p.size.w;
		const h = shape === 'circle' ? p.size.w : p.size.h;
		new CropEditor(this, {
			src,
			circle: shape === 'circle',
			aspect: w / h,
			initial: p.crop,
			title: shape === 'circle' ? 'Crop image (circle)' : 'Crop image (square)',
			onApply: (crop) => apply(crop),
		}).open();
	}

	// Re-crop the current image without changing the photo's shape.
	cropImage(view) {
		const p = view.photo;
		const src = this.resolveSrc(p.image);
		if (!src || !view.natW) {
			new Notice('Desk Photos: the image is not available to crop.');
			return;
		}
		new CropEditor(this, {
			src,
			circle: p.shape === 'circle',
			aspect: p.size.w / p.size.h,
			initial: p.crop,
			title: 'Crop image',
			onApply: (crop) => this.change(() => { p.crop = crop; }, view),
		}).open();
	}

	stopAllSounds() {
		for (const v of this.views.values()) v.stopSound();
		// Also silence in-flight interface sounds (flip, slide).
		for (const a of this._uiAudios) { try { a.pause(); } catch (e) { /* noop */ } }
		this._uiAudios.clear();
	}

	// Array order is z-order: later photos render on top.
	moveLayer(view, action) {
		const arr = this.data.photos;
		const i = arr.indexOf(view.photo);
		if (i < 0) return;
		let j = i;
		if (action === 'forward') j = Math.min(arr.length - 1, i + 1);
		else if (action === 'backward') j = Math.max(0, i - 1);
		else if (action === 'front') j = arr.length - 1;
		else if (action === 'back') j = 0;
		if (j === i) return;
		this.change(() => {
			arr.splice(i, 1);
			arr.splice(j, 0, view.photo);
		}, null);
	}

	pickFrameColor(view) {
		this.endMode();
		const f = view.photo.frame;
		new ColorAlphaMode(this, view, {
			getColor: () => f.color || '#ffffff',
			getAlpha: () => (f.alpha == null ? 1 : f.alpha),
			set: (c, a) => { f.color = c; f.alpha = a; },
		}).open();
	}

	pickFrameTexture(view, mode) {
		const openCrop = (texture) => {
			const src = this.resolveSrc(texture);
			if (!src) { new Notice('Desk Photos: that file could not be found.'); return; }
			const p = view.photo;
			const o = outerSize(p);
			const g = frameGeom(p);
			new CropEditor(this, {
				src,
				circle: p.frame.shape === 'circle',
				aspect: o.w / o.h,
				initial: null,
				title: 'Crop frame texture',
				hole: { x: g.left / o.w, y: g.top / o.h, circle: p.shape === 'circle' },
				onApply: (crop) => this.change(() => {
					p.frame.texture = texture;
					p.frame.textureCrop = crop;
				}, view),
			}).open();
		};
		if (mode === 'url') {
			new TextPromptModal(this.app, 'Enter web link', 'https://example.com/texture.png',
				(v) => openCrop({ type: 'url', path: v })).open();
		} else {
			new VaultFileModal(this.app, IMAGE_EXTS,
				(f) => openCrop({ type: 'vault', path: f.path })).open();
		}
	}

	/* --- missing-source error flow ------------------------------------ */

	// Re-verify every vault-based source after files are added, deleted, or
	// moved. Restored sources clear their pending error state (including a
	// currently displayed dialog); newly missing ones enter the error flow.
	recheckSources() {
		for (const view of this.views.values()) {
			const p = view.photo;
			const checks = [
				['image', p.image],
				['audio', p.sound],
				['texture', p.frame.type === 'blank' ? p.frame.texture : null],
			];
			for (const [kind, srcObj] of checks) {
				if (!srcObj || srcObj.type !== 'vault') continue;
				if (this.resolveSrc(srcObj)) {
					const flag = p.id + ':' + kind + ':' + JSON.stringify(srcObj);
					this.errorFlags.delete(flag);
					this.errorQueue = this.errorQueue.filter(
						(q) => !(q.photoId === p.id && q.kind === kind));
					if (this.errorActive && this._errorCleanup &&
						this.errorActive.view === view && this.errorActive.kind === kind) {
						this._errorCleanup();
					}
				} else {
					this.queueError(view, kind);
				}
			}
			view.render();
		}
		this.processErrors();
	}

	// Follow renamed or moved files (and folders) so vault sources keep
	// pointing at them instead of turning into missing-source errors.
	handleVaultRename(file, oldPath) {
		let changed = false;
		const remap = (srcObj) => {
			if (!srcObj || srcObj.type !== 'vault') return;
			if (srcObj.path === oldPath) {
				srcObj.path = file.path;
				changed = true;
			} else if (srcObj.path.startsWith(oldPath + '/')) {
				srcObj.path = file.path + srcObj.path.slice(oldPath.length);
				changed = true;
			}
		};
		for (const p of this.data.photos) {
			remap(p.image);
			remap(p.sound);
			remap(p.frame && p.frame.texture);
		}
		if (changed) this._save();
	}

	queueError(view, kind) {
		const p = view.photo;
		const srcObj = kind === 'image' ? p.image : kind === 'audio' ? p.sound : p.frame.texture;
		const flag = p.id + ':' + kind + ':' + JSON.stringify(srcObj);
		if (this.errorFlags.has(flag)) return;
		this.errorFlags.add(flag);
		this.errorQueue.push({ photoId: p.id, kind });
		this.processErrors();
	}

	processErrors() {
		if (this.errorActive || this.activeMode) return;
		// Wait until Obsidian's own modals (settings, dialogs) are closed; a
		// body observer retries as soon as the last one goes away.
		if (typeof document !== 'undefined' && document.body &&
			document.body.querySelector('.modal-container')) return;
		for (let i = 0; i < this.errorQueue.length; i++) {
			const item = this.errorQueue[i];
			const view = this.views.get(item.photoId);
			if (!view || !view.rootEl || !view.rootEl.isConnected) {
				this.errorQueue.splice(i, 1);
				i--;
				continue;
			}
			// A document-locked photo whose note is closed stays queued until
			// the note is opened again (retried on active-leaf-change).
			if (view.isHidden()) continue;
			// Not laid out yet (e.g. mid-mount): a spotlight opened now would
			// be positioned nonsensically. Keep it queued for a later retry.
			const r = view.rootEl.getBoundingClientRect();
			if (!r.width || !r.height) continue;
			this.errorQueue.splice(i, 1);
			this.showError(view, item.kind);
			return;
		}
	}

	showError(view, kind) {
		this.errorActive = { view, kind };
		view.setFlipped(false);
		const spot = new Spotlight(this, view, {});
		spot.open();
		const box = document.body.createDiv({ cls: 'dp-box dp-errorbox' });
		spot.addBox(box);

		// The message names the failing source and shows its path or link.
		const srcObj = kind === 'image' ? view.photo.image
			: kind === 'audio' ? view.photo.sound : view.photo.frame.texture;
		const noun = {
			image: 'The source for this desk photo',
			audio: 'The sound for this desk photo',
			texture: 'The frame texture for this desk photo',
		}[kind];
		const message = srcObj && srcObj.type === 'vault'
			? noun + ' cannot be found inside your vault.'
			: noun + ' cannot be accessed online. Please check your internet ' +
				'connection or if the source is still accessible through the link.';
		box.createEl('h3', { text: 'Desk photo problem' });
		box.createEl('p', { text: message });
		if (srcObj && srcObj.path) {
			box.createEl('p', { cls: 'dp-err-src', text: srcObj.path });
		}
		const row = box.createDiv({ cls: 'dp-btnrow' });

		const finish = () => {
			box.remove();
			spot.close();
			this.errorActive = null;
			this._errorCleanup = null;
		};
		this._errorCleanup = finish;
		const requeue = () => {
			this.errorQueue.unshift({ photoId: view.photo.id, kind });
			this.processErrors();
		};
		const applyFix = (fn) => {
			this.change(fn, view);
			this.processErrors();
		};
		const p = view.photo;
		const exts = kind === 'audio' ? AUDIO_EXTS : IMAGE_EXTS;
		const setSrc = (srcObj) => {
			if (kind === 'image') applyFix(() => { p.image = srcObj; p.crop = null; });
			else if (kind === 'audio') applyFix(() => { p.sound = srcObj; });
			else applyFix(() => { p.frame.texture = srcObj; p.frame.textureCrop = null; });
		};
		const button = (label, cb) => {
			const b = row.createEl('button', { text: label });
			b.addEventListener('click', () => { finish(); cb(); });
		};

		button('Select from vault', () =>
			new VaultFileModal(this.app, exts, (f) => setSrc({ type: 'vault', path: f.path }), requeue).open());
		button('Enter web link', () =>
			new TextPromptModal(this.app, 'Enter web link',
				kind === 'audio' ? 'https://example.com/sound.mp3' : 'https://example.com/image.png',
				(v) => setSrc({ type: 'url', path: v }), requeue).open());
		if (kind === 'image') {
			button('Remove desk photo', () => this.removePhoto(view, requeue));
		} else if (kind === 'audio') {
			button('Remove sound (No sound)', () => applyFix(() => { p.sound = null; }));
		} else {
			button('Remove frame (No frame)', () => applyFix(() => {
				p.frame.type = 'none';
				p.frame.texture = null;
				p.frame.textureCrop = null;
			}));
		}

		placeBoxNear(box, spot.holder.getBoundingClientRect());
	}
};
