/**
 * 离线自检脚本（不依赖浏览器、不依赖网络）
 *
 * 它把 main.js 里的纯数学与配置抽出来做数值断言，并静态检查着色器与 DOM 契约。
 * 用法：node verify.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dirname, f), 'utf8');
const mainSrc = read('main.js');
const htmlSrc = read('index.html');
const cssSrc = read('style.css');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name} ${extra}`); }
};

/* ==========================================================================
   0. 从 main.js 里解析出配置（避免测试和实现对不上）
   ========================================================================== */

const num = (key) => {
  const m = mainSrc.match(new RegExp(`^\\s{2}${key}:\\s*([\\d.]+)`, 'm'));
  if (!m) throw new Error(`CONFIG.${key} 未在 main.js 中找到`);
  return parseFloat(m[1]);
};

const CFG = {
  lowTension: num('lowTension'),
  highTension: num('highTension'),
  openGain: num('openGain'),
  gain: num('gain'),
  smoothing: num('smoothing'),
  spreadEase: num('spreadEase'),
  petalCount: num('petalCount'),
  petalSharp: num('petalSharp'),
  centerRatio: num('centerRatio'),
  moteRatio: num('moteRatio'),
};

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

/* 复刻 main.js 的两个公式 */
function tensionToBloom(tension) {
  const { lowTension: lo, highTension: hi } = CFG;
  const t = clamp((tension - lo) / (hi - lo || 1e-6));
  const core = t * t * (3 - 2 * t);
  return clamp(core * (1 + 0.10 * Math.sin(Math.PI * t)));
}

function damp(current, target, alpha, dt) {
  if (!Number.isFinite(dt) || dt <= 0) return current;
  if (!Number.isFinite(current) || !Number.isFinite(target)) return target;
  const keep = Math.pow(1 - clamp(alpha, 0.0001, 0.9999), dt * 60);
  return current + (target - current) * (1 - clamp(keep, 0, 1));
}

/* ==========================================================================
   1. 张力 → 绽放映射（规格：<0.32 闭合、>0.66 完全绽放、中间平滑）
   ========================================================================== */

console.log(`\n[1] 张力 → 绽放映射   (lo=${CFG.lowTension} hi=${CFG.highTension})`);
ok('阈值就是规格里的 0.32 / 0.66',
  Math.abs(CFG.lowTension - 0.32) < 1e-9 && Math.abs(CFG.highTension - 0.66) < 1e-9);
ok('tension = 0     → bloom = 0（握拳，粒子聚合）', tensionToBloom(0) === 0);
ok('tension = 0.32  → bloom = 0（阈值下沿仍闭合）', tensionToBloom(0.32) === 0);
ok('tension = 0.49  → 处于过渡中段', tensionToBloom(0.49) > 0.1 && tensionToBloom(0.49) < 1);
ok('tension = 0.66  → bloom = 1（阈值上沿完全绽放）', Math.abs(tensionToBloom(0.66) - 1) < 1e-9);
ok('tension = 1     → bloom = 1（不越界）', Math.abs(tensionToBloom(1) - 1) < 1e-9);
{
  let mono = true, inRange = true, prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.002) {
    const b = tensionToBloom(t);
    if (b < prev - 1e-9) { mono = false; break; }
    if (b < 0 || b > 1 + 1e-9) { inRange = false; break; }
    prev = b;
  }
  ok('映射在 [0,1] 上单调不减（不会"张开反而收缩"）', mono);
  ok('映射始终落在 [0,1] 内', inRange);
}

/* ==========================================================================
   2. 手掌张开度 tension 公式
   ========================================================================== */

console.log('\n[2] 手掌张开度 tension 公式');
function computeTension(lm, gain = 1) {
  const wrist = lm[0];
  const dip = (i) => Math.hypot(lm[i].x - wrist.x, lm[i].y - wrist.y);
  const palmScale = Math.max(dip(9), 1e-4);
  const tips = [4, 8, 12, 16, 20];
  const tipMean = tips.reduce((s, i) => s + dip(i), 0) / tips.length;
  const relative = tipMean / palmScale - 1;
  return clamp(clamp(relative * CFG.openGain, 0, 1) * gain, 0, 1);
}

/** 造一只手：open=true 张开，false 握拳 */
function makeHand(open, scale = 1, ox = 0.5, oy = 0.5) {
  const lm = [];
  const P = (x, y) => ({ x: ox + x * scale, y: oy + y * scale, z: 0 });
  lm[0] = P(0, 0.20);
  lm[1] = P(-0.055, 0.115); lm[5] = P(-0.02, 0.085);
  lm[9] = P(0.012, 0.075); lm[13] = P(0.042, 0.095); lm[17] = P(0.068, 0.135);
  lm[2] = P(-0.088, 0.075); lm[6] = P(-0.028, 0.015);
  lm[10] = P(0.012, 0.005); lm[14] = P(0.052, 0.03); lm[18] = P(0.085, 0.08);
  lm[3] = P(-0.105, 0.045); lm[7] = P(-0.032, -0.035);
  lm[11] = P(0.012, -0.045); lm[15] = P(0.058, -0.01); lm[19] = P(0.095, 0.045);
  lm[4] = open ? P(-0.115, 0.02) : P(-0.02, 0.10);
  lm[8] = open ? P(-0.035, -0.085) : P(-0.007, 0.09);
  lm[12] = open ? P(0.012, -0.10) : P(0.012, 0.095);
  lm[16] = open ? P(0.062, -0.06) : P(0.028, 0.08);
  lm[20] = open ? P(0.105, 0.005) : P(0.062, 0.115);
  return lm;
}

{
  const tOpen = computeTension(makeHand(true));
  const tFist = computeTension(makeHand(false));
  ok(`张开手张力明显高于握拳（${tOpen.toFixed(2)} vs ${tFist.toFixed(2)}）`, tOpen > tFist);
  ok('张开手接近 1（完全张开）', tOpen > 0.9, tOpen.toFixed(3));
  ok('握拳接近 0（闭合）', tFist < 0.12, tFist.toFixed(3));
  ok('尺度归一化：手离镜头远近不改变读数',
    Math.abs(computeTension(makeHand(true, 0.6, 0.3, 0.4)) - tOpen) < 0.06);
  ok('位置归一化：手在画面不同位置读数不变',
    Math.abs(computeTension(makeHand(true, 1, 0.2, 0.7)) - tOpen) < 0.06);
  ok('增益 gain 线性作用于结果',
    Math.abs(computeTension(makeHand(true), 0.5) - Math.min(1, tOpen * 0.5)) < 0.02);
}

/* ==========================================================================
   3. 缓动与平滑
   ========================================================================== */

console.log('\n[3] 缓动与平滑');
ok('规格要求的缓动系数是 0.1（currentSpread += (target-current)*0.1）',
  Math.abs(CFG.spreadEase - 0.1) < 1e-9);
{
  let s = 0;
  for (let i = 0; i < 60; i++) s += (1 - s) * CFG.spreadEase;
  ok('缓动 60 帧后到达 0.99 以上', s > 0.99, s.toFixed(4));

  let v = 0, over = false;
  for (let i = 0; i < 200; i++) {
    v += (1 - v) * CFG.spreadEase;
    if (v > 1 + 1e-9) over = true;
  }
  ok('缓动无过冲（不会超过 1）', !over);
  ok('缓动指数收敛（每帧保留 90%）', Math.abs(v - 1) < 1e-6);
}
{
  ok('damp：dt = 0 时不改变当前值', damp(0.3, 0.9, 0.2, 0) === 0.3);
  ok('damp：负 dt 时返回当前值（否则会指数级发散）', damp(0.3, 0.9, 0.2, -0.05) === 0.3);
  ok('damp：NaN dt 时返回当前值', damp(0.3, 0.9, 0.2, NaN) === 0.3);
  let a = 0, b = 0;
  for (let i = 0; i < 30; i++) a = damp(a, 1, 0.2, 1 / 30);
  for (let i = 0; i < 120; i++) b = damp(b, 1, 0.2, 1 / 120);
  ok(`damp 帧率无关（30fps ${a.toFixed(3)} vs 120fps ${b.toFixed(3)}）`,
    Math.abs(a - b) < 1e-3);
  ok('damp 单调逼近目标', a > 0 && a < 1 && b < 1);
}

/* ==========================================================================
   4. 参数表与规格一致性
   ========================================================================== */

console.log('\n[4] 参数面板（规格：模块二）');

function parseParamDefs(src) {
  const body = src.match(/const PARAM_DEFS = \[([\s\S]*?)\n\];/);
  if (!body) return [];
  const defs = [];
  for (const m of body[1].matchAll(/key:\s*'(\w+)'[\s\S]*?min:\s*(-?[\d.]+)[\s\S]*?max:\s*(-?[\d.]+)[\s\S]*?step:\s*([\d.]+)[\s\S]*?def:\s*(-?[\d.]+)/g)) {
    defs.push({ key: m[1], min: +m[2], max: +m[3], step: +m[4], def: +m[5] });
  }
  return defs;
}

{
  const defs = parseParamDefs(mainSrc);
  ok(`PARAM_DEFS 解析出 8 项（实际 ${defs.length}）`, defs.length === 8);
  const byKey = Object.fromEntries(defs.map((d) => [d.key, d]));

  const SPEC = [
    ['particleCount', 1000, 50000, 1000],
    ['particleSize', 0.5, 6.0, null],
    ['colorFlow', 0.0, 1.0, null],
    ['glowIntensity', 0.0, 3.0, null],
    ['bloomStrength', 0.0, 2.5, null],
    ['bloomRadius', 0, 1.5, null],
    ['bloomThreshold', 0, 1, null],
    ['brightness', 0.2, 2.0, null],
  ];
  for (const [key, min, max, step] of SPEC) {
    const d = byKey[key];
    ok(`参数 ${key} 的范围 = ${min} ~ ${max}`,
      !!d && Math.abs(d.min - min) < 1e-9 && Math.abs(d.max - max) < 1e-9,
      d ? `${d.min}~${d.max}` : '缺失');
    if (d && step !== null) ok(`参数 ${key} 的步长 = ${step}`, Math.abs(d.step - step) < 1e-9);
  }
  ok('粒子上限就是 50000（规格：MAX_PARTICLES = 50000）',
    /const MAX_PARTICLES = 50000;/.test(mainSrc));
  ok('滑块只改 drawRange，不重建几何体',
    /setDrawRange\(0,\s*Math\.max\(1,\s*Math\.min\(n,\s*MAX_PARTICLES\)\)\)/.test(mainSrc));
  ok('参数自动保存到 localStorage', /localStorage\.setItem\(STORAGE_KEY/.test(mainSrc));
  ok('恢复初始状态会清掉 localStorage', /localStorage\.removeItem\(STORAGE_KEY\)/.test(mainSrc));
  ok('存在 DEFAULT_STATE（规格：模块三）', /const DEFAULT_STATE = \{/.test(mainSrc));
  ok('DEFAULT_STATE 的张力是 0.5', /tension:\s*0\.5,/.test(mainSrc));
  ok('参数映射到 uniform / 后处理（applyParams）',
    /uSize\.value = params\.particleSize/.test(mainSrc) &&
    /uGlow\.value = params\.glowIntensity/.test(mainSrc) &&
    /uColorFlow\.value = params\.colorFlow/.test(mainSrc) &&
    /bloomPass\.strength = params\.bloomStrength/.test(mainSrc) &&
    /toneMappingExposure = params\.brightness/.test(mainSrc));
  ok('泛光用 ACESFilmicToneMapping', /ACESFilmicToneMapping/.test(mainSrc));
}

/* ==========================================================================
   4b. 视觉预设：标准模式 / 梦幻模式
   ========================================================================== */

console.log('\n[4b] 视觉预设（标准 / 梦幻）');
{
  const block = mainSrc.match(/const PRESETS = \[([\s\S]*?)\n\];/);
  ok('存在 PRESETS 预设表', !!block);

  const presetKeys = [...mainSrc.matchAll(/key:\s*'(standard|dreamy)'/g)].map((m) => m[1]);
  ok('有 standard 与 dreamy 两个预设',
    presetKeys.includes('standard') && presetKeys.includes('dreamy'));

  // standard = 全默认（粒子已拉满）
  const std = mainSrc.match(/key: 'standard'[\s\S]*?overrides: \{([^}]*)\}/);
  ok('标准模式不覆盖任何参数（全靠默认值）',
    !!std && std[1].trim() === '');

  // dreamy = 粒子拉满 + 泛光半径 0
  const dmy = mainSrc.match(/key: 'dreamy'[\s\S]*?overrides: \{([^}]*)\}/);
  ok('梦幻模式把泛光半径设成 0（拉到最低）',
    !!dmy && /bloomRadius:\s*0\b/.test(dmy[1]));

  // 粒子数量默认值 = 最大值（两种模式都"拉满"）
  const pc = mainSrc.match(/key: 'particleCount'[\s\S]*?max:\s*(\d+)[\s\S]*?def:\s*(\d+)/);
  ok('粒子数量默认值 = 最大值 50000（标准模式一开始就是拉满）',
    !!pc && +pc[1] === 50000 && +pc[2] === 50000,
    pc ? `max=${pc[1]} def=${pc[2]}` : '');

  ok('默认预设是标准模式', /const DEFAULT_PRESET = 'standard';/.test(mainSrc));
  ok('恢复初始状态回到标准模式', /this\.presetKey = DEFAULT_PRESET;/.test(mainSrc));
  ok('DEFAULT_STATE.params 由预设展开（默认状态 = 标准模式）',
    /params: presetParams\(DEFAULT_PRESET\)/.test(mainSrc) &&
    /preset: DEFAULT_PRESET,/.test(mainSrc));
  ok('切预设只改参数，不重建几何体',
    /applyPreset\(key\)/.test(mainSrc) &&
    /this\.stage\.applyParams\(\)/.test(mainSrc.split('applyPreset')[1] || ''));
  ok('预设按钮是动态生成到 #presetSeg',
    /_buildPresets\(\)/.test(mainSrc) && /host\.appendChild\(btn\)/.test(mainSrc));
  ok('手动拖滑块后预设高亮取消（变成自定义）',
    /const matched = this\.ui\._matchPreset\(\);/.test(mainSrc));
  ok('HTML 里有 #presetSeg 容器', /id="presetSeg"/.test(htmlSrc));
  ok('CSS 区分了预设按钮的高亮色', /\.preset-btn\.active/.test(cssSrc));
}

/* ==========================================================================
   5. 花朵几何
   ========================================================================== */

console.log('\n[5] 花瓣几何（极坐标玫瑰曲线）');
{
  ok(`花瓣数是 ${CFG.petalCount}（规格：数学公式生成花瓣）`, CFG.petalCount >= 3);
  ok('花瓣锐度在合理区间（0.2~2）', CFG.petalSharp > 0.2 && CFG.petalSharp < 2);
  ok('花瓣用 |cos(kθ/2)|^sharp 的极坐标玫瑰曲线',
    /Math\.pow\(Math\.abs\(Math\.cos\(\(k \* theta\) \/ 2\)\),\s*sharp\)/.test(mainSrc));
  ok('半径用 sqrt 采样，粒子在面积上均匀（否则全挤圆心）',
    /Math\.sqrt\(Math\.random\(\)\)/.test(mainSrc));
  ok('内外两层花瓣（内层旋转 30°）', /Math\.PI \/ CONFIG\.petalCount/.test(mainSrc));
  ok('花心 + 尘埃占比合理', CFG.centerRatio + CFG.moteRatio < 0.5);

  const peaksOf = (k, sharp) => {
    const N = 4000;
    const v = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      v.push(Math.pow(Math.abs(Math.cos((k * th) / 2)), sharp));
    }
    let peaks = 0;
    for (let i = 0; i < N; i++) {
      const a = v[(i - 1 + N) % N], b = v[i], c = v[(i + 1) % N];
      if (b > a && b >= c && b > 0.55) peaks++;
    }
    return peaks;
  };
  for (const k of [5, 6, 7]) {
    ok(`k=${k} 时曲线恰好有 ${k} 个瓣（检测到 ${peaksOf(k, CFG.petalSharp)} 个）`,
      peaksOf(k, CFG.petalSharp) === k);
  }
}

/* ==========================================================================
   6. 着色器静态检查
   ========================================================================== */

console.log('\n[6] 着色器');
{
  const extract = (name) => {
    const m = mainSrc.match(new RegExp(`const ${name} = /\\* glsl \\*/ \`([\\s\\S]*?)\`;`));
    return m ? m[1] : null;
  };
  const vert = extract('FLOWER_VERT');
  const frag = extract('FLOWER_FRAG');
  ok('能提取到花朵顶点着色器', !!vert);
  ok('能提取到花朵片元着色器', !!frag);

  if (vert && frag) {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const vc = strip(vert);
    const fc = strip(frag);

    const vset = new Set([...vc.matchAll(/varying\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]));
    const fset = new Set([...fc.matchAll(/varying\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]));
    const missingVar = [...fset].filter((v) => !vset.has(v));
    ok('片元着色器用到的 varying 都在顶点着色器里声明过', missingVar.length === 0, missingVar.join(', '));
    const notWritten = [...vset].filter((v) => !new RegExp(`\\b${v}\\s*=`).test(vc));
    ok('顶点着色器写入了它声明的所有 varying', notWritten.length === 0, notWritten.join(', '));

    const jsUniforms = new Set(
      [...mainSrc.matchAll(/^\s{6}(u[A-Z]\w*):\s*\{\s*value:/gm)].map((m) => m[1])
    );
    const shaderUniforms = new Set(
      [...vc.matchAll(/uniform\s+\w+\s+(u\w+)\s*;/g), ...fc.matchAll(/uniform\s+\w+\s+(u\w+)\s*;/g)]
        .map((m) => m[1])
    );
    const missing = [...shaderUniforms].filter((u) => !jsUniforms.has(u));
    ok(`着色器的 uniform 都在 JS 里提供（${shaderUniforms.size} 个）`, missing.length === 0, missing.join(', '));

    ok('规格要求的 uSize 在顶点着色器里控制 gl_PointSize',
      /uSize/.test(vc) && /gl_PointSize\s*=/.test(vc));
    ok('规格要求的 uGlow 参与颜色计算', /uGlow/.test(fc) && /uGlow/.test(vc));
    ok('规格要求的 uColorFlow 在片元着色器里做色相/色彩流动', /uColorFlow/.test(fc));

    ok('顶点着色器用 uBloom 在花苞与绽放之间插值',
      /mix\(aPosBud,\s*position,\s*b\)/.test(vc));

    const attribs = [...vc.matchAll(/attribute\s+\w+\s+(a\w+)\s*;/g)].map((m) => m[1]);
    const setAttrs = [...mainSrc.matchAll(/setAttribute\('(a\w+)'/g)].map((m) => m[1]);
    const missingAttr = attribs.filter((a) => !setAttrs.includes(a));
    ok(`顶点属性 ${attribs.length} 个都在 geometry 上设置过`, missingAttr.length === 0, missingAttr.join(', '));

    ok('片元着色器写了 gl_FragColor', /gl_FragColor\s*=/.test(fc));
    ok('片元着色器丢弃圆外的点（discard）', /discard/.test(fc));
    ok('片元着色器用 dot 而不是 length 判断半径（省一次开方）', /dot\(q,\s*q\)/.test(fc));
    ok('花括号配对', (vc.match(/{/g) || []).length === (vc.match(/}/g) || []).length);
  }

  ok('有 EffectComposer + RenderPass + UnrealBloomPass + OutputPass',
    /new EffectComposer/.test(mainSrc) && /new RenderPass/.test(mainSrc) &&
    /new UnrealBloomPass/.test(mainSrc) && /new OutputPass/.test(mainSrc));
  ok('resize 时同步更新 composer 与 bloom',
    /composer\.setSize\(w, h\)/.test(mainSrc) && /bloomPass\.setSize\(w, h\)/.test(mainSrc));
  ok('粒子用加法混合 + 不写深度',
    /THREE\.AdditiveBlending/.test(mainSrc) && /depthWrite:\s*false/.test(mainSrc));
}

/* ==========================================================================
   7. DOM 契约与交互
   ========================================================================== */

console.log('\n[7] DOM 契约与交互');
{
  const wanted = new Set([...mainSrc.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  const htmlIds = new Set([...htmlSrc.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !htmlIds.has(id));
  ok(`main.js 引用的 ${wanted.size} 个 id 都在 HTML 里`, missing.length === 0, missing.join(', '));

  const cls = (c) => new RegExp(`\\.${c}\\b`).test(cssSrc);
  for (const c of ['panel', 'hud', 'toast', 'seg-btn', 'reset-btn', 'cursor-dot']) {
    ok(`CSS 里有 .${c}`, cls(c));
  }
  ok('CSS 有窄屏媒体查询', /@media\s*\(max-width/.test(cssSrc));
  ok('CSS 适配刘海屏安全区', /safe-area-inset/.test(cssSrc));
  ok('CSS 尊重 prefers-reduced-motion', /prefers-reduced-motion/.test(cssSrc));

  ok('模式切换：手势 / 鼠标（setMode）', /setMode\(mode\)/.test(mainSrc) && /'mouse'/.test(mainSrc));
  ok('快捷键 M / H / R',
    /k === 'm'/.test(mainSrc) && /k === 'h'/.test(mainSrc) && /k === 'r'/.test(mainSrc));
  ok('鼠标横向 → 张力', /this\.tension = clamp\(e\.clientX \/ window\.innerWidth/.test(mainSrc));
  ok('鼠标纵向 → 俯仰（约 ±0.3 弧度）',
    /this\.pitch = \(0\.5 - e\.clientY \/ window\.innerHeight\) \* 0\.6/.test(mainSrc));
  ok('滚轮缩放区间 0.5 ~ 2.0', /clamp\(next, 0\.5, 2\.0\)/.test(mainSrc));
  ok('左键旋转 / 右键平移 / 双击复位',
    /this\.dragging = e\.button === 2 \? 'pan' : 'orbit'/.test(mainSrc) &&
    /addEventListener\('dblclick'/.test(mainSrc));
  ok('摄像头失败自动回退鼠标模式', /_fallbackToMouse/.test(mainSrc));
  ok('摄像头错误分支覆盖权限拒绝', /NotAllowedError/.test(mainSrc));
  ok('摄像头错误分支覆盖无设备', /NotFoundError/.test(mainSrc));
  ok('摄像头错误分支覆盖被占用', /NotReadableError/.test(mainSrc));
  ok('摄像头错误分支覆盖 file:// 安全限制', /SecurityError/.test(mainSrc));
  ok('页面切后台会暂停渲染', /visibilitychange/.test(mainSrc));
  ok('dt 做了截断且不允许为负',
    /Math\.max\(0,\s*Math\.min\(\(now - this\.lastTime\) \/ 1000, 0\.05\)\)/.test(mainSrc));
  ok('骨骼绘制受 CONFIG.showSkeleton 控制', /CONFIG\.showSkeleton/.test(mainSrc));
}

console.log(`\n${'='.repeat(58)}`);
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log(`${'='.repeat(58)}\n`);
process.exit(fail === 0 ? 0 : 1);