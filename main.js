/**
 * ============================================================================
 *  指尖花开 · 手势控制粒子花朵
 *  摄像头识别手部 21 点 → 手掌张开度 → 粒子花朵绽放
 * ----------------------------------------------------------------------------
 *  模块划分：
 *   §0  配置与默认参数      PARAMS / DEFAULT_STATE / CONFIG
 *   §1  工具函数            缓动、平滑、张力→绽放映射
 *   §2  张力计算            TensionMeter（21 点 → 0~1）
 *   §3  手势追踪            HandTracker（MediaPipe Hands + 骨架绘制）
 *   §4  粒子花朵            FlowerField（5 万粒子池 + 顶点着色器插值）
 *   §5  舞台                Stage（Three.js / 泛光后期 / 摄像头背景 / 星尘）
 *   §6  鼠标模式            MouseController（X 张力 / Y 俯仰 / 滚轮 / 拖拽）
 *   §7  界面                UI（参数面板 / HUD / 快捷键 / 恢复初始状态）
 *   §8  主程序              App（装配 + 主循环）
 * ============================================================================
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ==========================================================================
   §0.5  MediaPipe tasks-vision 多源加载 + 模型下载进度
   --------------------------------------------------------------------------
   · 旧版 @mediapipe/hands（UMD）已废弃，迁移到 tasks-vision HandLandmarker：
       - GPU delegate 推理更快，失败自动回退 CPU
       - 额外输出 worldLandmarks（米制 3D 坐标），张开度计算抗手旋转
   · 依赖按优先级依次尝试：jsDelivr → npmmirror（国内）→ unpkg
   · 模型优先用仓库自带的本地文件（models/hand_landmarker.task），
     下载过程带进度回调，页面遮罩实时显示百分比
   ========================================================================== */

const MP_VER = '0.10.21';
const VISION_SOURCES = [
  { name: 'jsdelivr',  mod: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`,
    wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm` },
  { name: 'npmmirror', mod: `https://registry.npmmirror.com/@mediapipe/tasks-vision/${MP_VER}/files/vision_bundle.mjs`,
    wasm: `https://registry.npmmirror.com/@mediapipe/tasks-vision/${MP_VER}/files/wasm` },
  { name: 'unpkg',     mod: `https://unpkg.com/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`,
    wasm: `https://unpkg.com/@mediapipe/tasks-vision@${MP_VER}/wasm` },
];
const MODEL_SOURCES = [
  './models/hand_landmarker.task',
  'https://cdn.jsdelivr.net/gh/tan396222-prog/gesture-bloom@main/models/hand_landmarker.task',
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
];

/** 下载字节流，带 0~1 进度回调；校验不是被静态托管回退成的 HTML */
async function fetchBytes(url, onProgress) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let bytes;
  if (res.body && total && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress?.(Math.min(0.99, got / total));
    }
    bytes = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.length; }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  // .task 是带 2 字节前缀的 zip（PK 头）；HTML 回退页以 '<' 开头且很小
  if (bytes.length < 100000 || bytes[0] === 0x3c) throw new Error('invalid model file');
  onProgress?.(1);
  return bytes;
}

/* ---- 加载进度遮罩（DOM 直接操作，避免和 UI 类互相依赖） ---- */
const loadEl = {
  overlay: document.getElementById('loadOverlay'),
  label: document.getElementById('loadLabel'),
  bar: document.getElementById('loadBar'),
  pct: document.getElementById('loadPct'),
};
function showLoad(label) {
  if (!loadEl.overlay) return;
  loadEl.overlay.hidden = false;
  setLoad(0, label);
}
function setLoad(p, label) {
  if (!loadEl.overlay || loadEl.overlay.hidden) return;
  const pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
  if (loadEl.bar) loadEl.bar.style.width = pct + '%';
  if (loadEl.pct) loadEl.pct.textContent = pct + '%';
  if (label && loadEl.label) loadEl.label.textContent = label;
}
function hideLoad() {
  if (loadEl.overlay) loadEl.overlay.hidden = true;
}

/* ==========================================================================
   §0  配置与默认参数
   ========================================================================== */

/** 粒子池上限：滑块只改 drawRange，不重建几何体（规格要求） */
const MAX_PARTICLES = 90000;

/**
 * 实时参数（面板可调，自动存 localStorage）
 * 每一项都会被映射到一个具体的渲染量，label 下方写着映射关系。
 */
const PARAM_DEFS = [
  {
    key: 'particleCount', label: '粒子数量', min: 1000, max: 90000, step: 1000,
    def: 90000, fmt: (v) => v.toLocaleString('en-US'),
    hint: '90000 粒子池固定分配（上下两朵花），滑块只改 setDrawRange',
    group: '粒子',
  },
  {
    key: 'particleSize', label: '粒子大小', min: 0.5, max: 6, step: 0.1,
    def: 1.8, fmt: (v) => v.toFixed(1),
    hint: 'uniform uSize → 顶点着色器 gl_PointSize',
    group: '粒子',
  },
  {
    key: 'colorFlow', label: '炫光流彩', min: 0, max: 1, step: 0.01,
    def: 0.6, fmt: (v) => v.toFixed(2),
    hint: 'uniform uColorFlow → 片元色相流动 / 色彩差异 / 饱和度',
    group: '视觉',
  },
  {
    key: 'glowIntensity', label: '发光强度', min: 0, max: 3, step: 0.01,
    def: 0.68, fmt: (v) => v.toFixed(2),
    hint: 'uniform uGlow → 乘以粒子颜色',
    group: '视觉',
  },
  {
    key: 'bloomStrength', label: '泛光强度', min: 0, max: 2.5, step: 0.01,
    def: 0.65, fmt: (v) => v.toFixed(2),
    hint: 'UnrealBloomPass.strength',
    group: '后处理',
  },
  {
    key: 'bloomRadius', label: '泛光半径', min: 0, max: 1.5, step: 0.01,
    def: 0.6, fmt: (v) => v.toFixed(2),
    hint: 'UnrealBloomPass.radius',
    group: '后处理',
  },
  {
    key: 'bloomThreshold', label: '泛光阈值', min: 0, max: 1, step: 0.01,
    def: 0.34, fmt: (v) => v.toFixed(2),
    hint: 'UnrealBloomPass.threshold：越小越多粒子发光',
    group: '后处理',
  },
  {
    key: 'brightness', label: '整体亮度', min: 0.2, max: 2, step: 0.01,
    def: 1.0, fmt: (v) => v.toFixed(2),
    hint: 'renderer.toneMappingExposure（ACESFilmicToneMapping）',
    group: '后处理',
  },
];

/**
 * 视觉预设：点一下套用一整组参数（页面上就是右上角那两个按钮）
 *   standard  标准模式 —— 粒子数量拉满，其余全默认（这是打开页面时的初始状态）
 *   dreamy    梦幻模式 —— 粒子数量拉满 + 泛光半径拉到最低（光晕收到极小，颗粒感更清晰）
 * overrides 里没写的参数，一律回到 PARAM_DEFS 的默认值。
 */
const PRESETS = [
  {
    key: 'standard',
    label: '标准模式',
    desc: '粒子拉满 · 光晕柔和',
    overrides: {},
  },
  {
    key: 'dreamy',
    label: '梦幻模式',
    desc: '粒子拉满 · 泛光半径与阈值都拉到最低',
    overrides: {
      particleCount: 90000,   // 粒子数量最大
      bloomRadius: 0,         // 泛光半径最低
      bloomThreshold: 0,      // 泛光阈值最低：所有粒子都参与泛光
    },
  },
];

const DEFAULT_PRESET = 'standard';

/** 某个预设展开成完整参数（默认值 + 覆盖项） */
function presetParams(key) {
  const preset = PRESETS.find((p) => p.key === key) || PRESETS[0];
  return { ...Object.fromEntries(PARAM_DEFS.map((d) => [d.key, d.def])), ...preset.overrides };
}

/** 默认状态（「恢复初始状态」按钮就回到这里，= 标准模式） */
const DEFAULT_STATE = {
  params: presetParams(DEFAULT_PRESET),
  camera: { x: 0, y: 1.28, z: 5.8, targetY: 0.30, rotY: 0, rotX: 0 },
  tension: 0.5,
  mode: 'hand',
  preset: DEFAULT_PRESET,
};

const CONFIG = {
  /* ---------- 张力 → 绽放 ---------- */
  lowTension: 0.32,        // ≤ 此值：粒子聚合、花苞闭合
  highTension: 0.66,       // ≥ 此值：粒子扩散、完全绽放
  openGain: 1.4,           // 张开度归一化放大（把 [0,0.715] 映射到 [0,1]）
  gain: 1.0,               // 灵敏度
  smoothing: 0.18,         // 张力平滑（60fps 下每帧保留比例）
  spreadEase: 0.10,        // 绽放缓动：currentSpread += (target - current) * 0.1
  lostTimeout: 900,        // 丢手多少 ms 后回落

  /* ---------- 花朵几何 ---------- */
  petalCount: 6,           // 花瓣数（极坐标玫瑰曲线的 k）
  petalSharp: 0.78,        // 花瓣锐度（越大瓣越瘦、瓣间凹陷越深）
  petalLayers: 2,          // 内外两层花瓣（第二层旋转 30°、略小）
  centerRatio: 0.008,      // 花心金粉占比（9 万颗时不能多，否则花心烧成白盘）
  moteRatio: 0.028,        // 飘散尘埃占比（多了会糊成一层粉雾）
  bloomScale: 1.0,         // 花朵整体尺寸
  spinTurns: 0.55,         // 绽放时花瓣旋转圈数（打开时"拧"一下）

  /* ---------- 摄像头 ---------- */
  camWidth: 640,
  camHeight: 480,
  cameraTimeout: 9000,     // getUserMedia 最多等多久（权限弹窗没人点时不会报错，只会一直 pending）
  maxHands: 1,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6,

  /* ---------- 其他 ---------- */
  maxPixelRatio: 2,
  videoOpacity: 0.22,
  autoRotate: 0.06,        // 花朵自转（弧度/秒）
  pointerRepel: 0.55,      // 指尖/鼠标附近的排斥强度
  showSkeleton: true,      // 是否绘制 21 点骨架

  /* ---------- 花朵跟手（掌心悬停） ---------- */
  handFollow: 0.78,        // 跟随强度：1 = 完全贴合掌心，0 = 固定居中
  handLift: 0.18,          // 花朵浮在掌心上方的高度（世界单位）
  handFollowEase: 0.09,    // 跟随缓动（越大越跟手，越小越飘）
  handScale: 0.9,          // 花朵随手掌大小的缩放强度（0 = 固定大小）
  palmSpanRef: 0.185,      // 手掌尺度基准（腕→中指根，画面归一化）
  followZ: 0.0,            // 跟随平面（花朵所在的世界 z）

  /* ---------- 爱心形态（两指 V 手势） ---------- */
  heartScale: 0.82,        // 爱心的整体大小
  heartLift: 0.42,         // 爱心中心的高度（立在花心上方）
  heartEase: 0.035,        // 化形/还原的缓动（指数缓动前段最快：0.10 约 0.5 秒收敛，0.035 约 1.5 秒，粒子飞过去看得清）
  heartHold: 0.22,         // 两指保持多久才开始化形（防抖）
  heartRelease: 0.35,      // 松手多久才还原（防止抖动来回跳）
};

const STATE = { BUD: 'bud', MID: 'mid', BLOOM: 'bloom' };

/** 参数对象（面板与渲染共用同一个引用） */
const params = { ...DEFAULT_STATE.params };

/* ==========================================================================
   §1  工具函数
   ========================================================================== */

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** 三次平滑阶跃 smoothstep(e0, e1, x)，输出 0~1 */
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * 帧率无关的指数平滑。
 * 把 alpha 解释成「60fps 下每帧保留的比例」，换算成连续时间的衰减：
 *     keep = (1 - alpha)^(dt * 60)
 * 这样 30 / 60 / 120fps 在同一段时间内衰减总量一致。
 *
 * dt <= 0 或非法时直接返回当前值：requestAnimationFrame 的首帧时间戳
 * 可能早于上一次 performance.now()，负的 dt 会让指数平滑指数级发散。
 */
function damp(current, target, alpha, dt) {
  if (!Number.isFinite(dt) || dt <= 0) return current;
  if (!Number.isFinite(current) || !Number.isFinite(target)) return target;
  const keep = Math.pow(1 - clamp(alpha, 0.0001, 0.9999), dt * 60);
  return current + (target - current) * (1 - clamp(keep, 0, 1));
}

/**
 * 给 Promise 加超时。
 * getUserMedia 在「权限弹窗弹出来但没人点」时会一直 pending —— 既不报错也不 resolve，
 * 页面就永远卡在"正在请求摄像头权限…"，用户看到的就是"手势模式用不了"。
 */
function withTimeout(promise, ms, message) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 张力 → 绽放度 0~1（规格：<0.32 闭合、>0.66 完全绽放、中间平滑）
 * 中段乘一个钟形包络，让花瓣"唰"地打开再稳稳停住。
 */
function tensionToBloom(tension) {
  const { lowTension: lo, highTension: hi } = CONFIG;
  const t = clamp((tension - lo) / (hi - lo || 1e-6));
  const core = t * t * (3 - 2 * t);
  return clamp(core * (1 + 0.10 * Math.sin(Math.PI * t)));
}

/* ==========================================================================
   §2  张力计算 TensionMeter
   --------------------------------------------------------------------------
   设 wrist = 关键点 0：
     D_palm = D(0 → 9)                      腕 → 中指 MCP，尺度基准
     D_tip  = mean( D(0→4), D(0→8), D(0→12), D(0→16), D(0→20) )
     raw    = D_tip / D_palm - 1            握拳≈0，张开≈1（除以手掌尺寸做尺度归一化）
     t_inst = clamp( clamp(raw × openGain, 0, 1) × gain, 0, 1 )
     tension = 平滑(t_inst)
   拇指取指尖 4 而不是关节 3：握拳时关节 3 仍离腕较远，会让"握拳"读数偏高。
   ========================================================================== */
class TensionMeter {
  constructor() {
    this.raw = 0.5;
    this.value = 0.5;
    this.state = STATE.MID;
    this.lastSeen = 0;
    this.hasHand = false;
    this.bloom = 0;
    this.openness = 0;
  }

  update(lm, dt, world) {
    const { smoothing, gain, openGain, lowTension, highTension, lostTimeout } = CONFIG;

    if (lm && lm.length >= 21) {
      this.hasHand = true;
      /* 优先用 worldLandmarks（米制 3D，原点在手几何中心）：
         距离比值天然尺度归一化，且手翻转/侧对摄像头时读数不塌陷。
         没有 world 时回退到画面归一化坐标（z 是伪深度，权重减半）。 */
      const P = (world && world.length >= 21) ? world : lm;
      const zw = P === lm ? 0.5 : 1.0;
      const wrist = P[0];
      const dip = (i) => Math.hypot(P[i].x - wrist.x, P[i].y - wrist.y, (P[i].z - wrist.z) * zw);

      const palmScale = Math.max(dip(9), 1e-4);
      const tips = [4, 8, 12, 16, 20];
      const tipMean = tips.reduce((s, i) => s + dip(i), 0) / tips.length;
      const relative = tipMean / palmScale - 1;

      this.raw = clamp(clamp(relative * openGain, 0, 1) * gain, 0, 1);

      // 辅助指标：四指伸直程度（同样用 3D 距离，抗旋转）
      this.openness = [8, 12, 16, 20].reduce((s, tipIdx, k) => {
        const pipIdx = [6, 10, 14, 18][k];
        const dTip = dip(tipIdx);
        const dPip = dip(pipIdx);
        return s + clamp(dTip / Math.max(dPip, 1e-4) - 1, 0, 1);
      }, 0) / 4;

      this.lastSeen = performance.now();
    } else if (performance.now() - this.lastSeen > lostTimeout) {
      // 长时间没手：缓慢回落到中性值，花朵半开待机而不是卡死
      this.hasHand = false;
      this.raw = damp(this.raw, 0.45, 0.02, dt);
      this.openness = damp(this.openness, 0.45, 0.02, dt);
    }

    this.value = damp(this.value, this.raw, smoothing, dt);
    this.bloom = tensionToBloom(this.value);

    // 带迟滞的状态机（避免阈值附近反复横跳）
    const h = 0.05;
    if (this.value < lowTension - (this.state === STATE.BUD ? 0 : h)) this.state = STATE.BUD;
    else if (this.value > highTension + (this.state === STATE.BLOOM ? 0 : h)) this.state = STATE.BLOOM;
    else if (this.value >= lowTension && this.value <= highTension) this.state = STATE.MID;

    return this.value;
  }
}

/* ==========================================================================
   §2  手势追踪 HandTracker
   --------------------------------------------------------------------------
   · 使用 MediaPipe tasks-vision HandLandmarker（多源动态加载，GPU→CPU 回退）
   · 输入：隐藏的 <video>
   · 输出：onResults(landmarks|null, handedness)
   · 额外职责：在 overlay 画布上绘制 21 点与骨架连线
   ========================================================================== */

/** MediaPipe Hands 官方 21 关键点连接表（用于画骨架） */
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8],          // 食指
  [5, 9], [9, 10], [10, 11], [11, 12],     // 中指
  [9, 13], [13, 14], [14, 15], [15, 16],   // 无名指
  [13, 17], [17, 18], [18, 19], [19, 20],  // 小指
  [0, 17],                                  // 掌根闭合
];

class HandTracker {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {HTMLCanvasElement} opts.overlay 骨架绘制画布
   * @param {(lm:Array|null, info:object)=>void} opts.onResults
   * @param {(msg:string, fatal?:boolean)=>void} opts.onError
   */
  constructor({ video, overlay, onResults, onError, onStatus }) {
    this.video = video;
    this.overlay = overlay;
    this.overlayCtx = overlay.getContext('2d');
    this.onResults = onResults;
    this.onError = onError || (() => {});
    this.onStatus = onStatus || (() => {});

    this.landmarker = null;
    this.source = '';
    this.stream = null;
    this.running = false;

    /** 双手数据：每只手的 { landmarks, handedness, label, pointer }
     *  左手在前、右手在后（按 MediaPipe 的 label 排序，保证索引稳定） */
    this.handsData = [];
    /** 兼容旧接口：主手（右手优先）的 21 点，没有手时为 null */
    this.lastLandmarks = null;
    this.lastWorldLandmarks = null;
    this.lastHandedness = null;

    /** 平滑后的手指位置（用于画面“跟手”），存归一化坐标 */
    this.pointer = new THREE.Vector2(0.5, 0.5);
    this.pointerTarget = new THREE.Vector2(0.5, 0.5);
    this.pointerActive = false;

    /** 双手是否同时出现 */
    this.twoHandActive = false;
  }

  /** tasks-vision 模块在 start() 里按需多源加载，无需预检查 UMD 脚本 */
  static isAvailable() {
    return true;
  }

  /** 请求摄像头 + 初始化 MediaPipe。返回 Promise<void> */
  async start() {
    if (this.running) return;

    // ---- ① 环境检查 ----
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        '浏览器不支持摄像头 API。请使用 Chrome / Edge / Safari 最新版，' +
        '并确认页面通过 http(s) 打开（file:// 协议下浏览器会禁用摄像头）。'
      );
    }
    // ---- ③ 初始化 MediaPipe HandLandmarker（tasks-vision，多源 + 进度） ----
    // 重试摄像头时复用已创建的识别器，不重复下载模型
    if (!this.landmarker) {
      this.onStatus('正在加载手部识别模型…');
      showLoad('正在下载手部识别模型…');
      try {
        this.landmarker = await this._createLandmarker();
      } catch (err) {
        hideLoad();
        throw err;
      }
      setLoad(1, '模型就绪');
      hideLoad();
    }

    // ---- ② 打开摄像头 ----
    this.onStatus('正在请求摄像头权限…');
    try {
      this.stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: 'user',
            width: { ideal: CONFIG.camWidth },
            height: { ideal: CONFIG.camHeight },
          },
        }),
        CONFIG.cameraTimeout,
        '摄像头没有响应：浏览器的权限弹窗可能被别的窗口挡住了，或者一直没有点「允许」。' +
        '点地址栏左侧的摄像头图标允许访问后，按右上角「重试摄像头」。'
      );
    } catch (err) {
      throw new Error(this._describeCameraError(err));
    }

    this.video.srcObject = this.stream;
    // iOS Safari 需要这个属性才允许内联播放
    this.video.setAttribute('playsinline', 'true');
    await this.video.play().catch(() => {
      /* 某些浏览器 play() 会被拒绝，交给下方 videoWidth 检测兜底 */
    });

    // ---- ④ 启动识别循环 ----
    this.running = true;
    this.onStatus('手势识别运行中');
    this._loop();
  }

  /**
   * 创建 HandLandmarker：
   *   模型下载（0→60%，多源回退）→ 加载推理引擎（60→85%）→ 创建实例 GPU→CPU（85→100%）
   * 识别 2 只手：单手模式下多识别的那只不参与运算，但保留它，
   * 用户随时切双手模式无需重启识别。
   */
  async _createLandmarker() {
    // ---- 模型字节（本地优先，带进度） ----
    let modelBytes = null;
    let lastErr = null;
    for (const url of MODEL_SOURCES) {
      try {
        modelBytes = await fetchBytes(url, (p) => setLoad(p * 0.6, '正在下载手部识别模型…'));
        break;
      } catch (e) {
        lastErr = e;
        console.warn('[HandTracker] 模型源失败：', url, e.message);
      }
    }
    if (!modelBytes) throw new Error('手部识别模型下载失败：' + (lastErr?.message || '所有源均不可用'));

    // ---- 推理引擎 + 实例（多源 × GPU/CPU 回退） ----
    for (const src of VISION_SOURCES) {
      let vision;
      setLoad(0.62, `正在加载推理引擎（${src.name}）…`);
      try {
        vision = await import(/* @vite-ignore */ src.mod);
      } catch (e) {
        console.warn('[HandTracker] vision 模块失败：', src.name);
        continue;
      }
      try {
        setLoad(0.72, '正在初始化 WASM…');
        const fileset = await vision.FilesetResolver.forVisionTasks(src.wasm);
        for (const delegate of ['GPU', 'CPU']) {
          try {
            setLoad(0.85, `正在创建识别器（${delegate}）…`);
            const landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetBuffer: modelBytes, delegate },
              runningMode: 'VIDEO',
              numHands: Math.max(2, CONFIG.maxHands),
              minHandDetectionConfidence: CONFIG.minDetectionConfidence,
              minHandPresenceConfidence: 0.5,
              minTrackingConfidence: CONFIG.minTrackingConfidence,
            });
            this.source = `${src.name}/${delegate}`;
            console.info('[HandTracker] 识别器就绪：', this.source);
            setLoad(0.98, '识别器就绪');
            return landmarker;
          } catch (e) {
            console.warn('[HandTracker] delegate 失败：', delegate, e?.message);
          }
        }
      } catch (e) {
        console.warn('[HandTracker] wasm 失败：', src.name, e?.message);
      }
    }
    throw new Error('HandLandmarker 初始化失败：请检查网络后重试');
  }

  /**
   * 内部识别循环：detectForVideo 是同步调用（GPU 读回），
   * 按视频帧去重 + 检测耗时自适应节流，避免重复推理同一帧。
   */
  async _loop() {
    this._lastVideoTime = -1;
    this._lastDetect = 0;
    this._detectCost = 0;
    while (this.running) {
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth > 0 && v.currentTime !== this._lastVideoTime) {
        const now = performance.now();
        // 上一帧推理超过 22ms 时限频到 ~30fps，给渲染让出主线程
        const minGap = this._detectCost > 22 ? 33 : 0;
        if (now - this._lastDetect >= minGap) {
          this._lastVideoTime = v.currentTime;
          this._lastDetect = now;
          const t0 = performance.now();
          try {
            const res = this.landmarker.detectForVideo(v, now);
            this._detectCost = this._detectCost * 0.8 + (performance.now() - t0) * 0.2;
            this._handleResults(res);
          } catch (err) {
            // 单帧失败不致命，记录后继续
            console.warn('[HandTracker] detect 失败：', err);
          }
        }
      }
      // 让出主线程，与渲染循环交替
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  _handleResults(results) {
    /* tasks-vision 输出格式：
         landmarks:      NormalizedLandmark[][]（画面归一化坐标）
         worldLandmarks: Landmark[][]（米制 3D，原点在手几何中心）
         handedness:     Category[][]（[{categoryName, score}]）
       这里整理成与旧版一致的双手数据结构。 */
    const all = results?.landmarks || [];
    const worlds = results?.worldLandmarks || [];
    const handedness = (results?.handedness || []).map((arr) => {
      const c = arr?.[0] || {};
      return { label: c.categoryName || '', score: c.score ?? 0 };
    });

    /* ---------- 整理成双手数据 ----------
       MediaPipe 的 landmarks 数组顺序会随手出现顺序变化，
       如果直接用下标 0/1，两只手会"串位"，导致左右手控制互换。
       这里按 handedness 的 label 排序（Left 在前、Right 在后），
       索引就稳定了；同时用 score 最高的那只作为"主手"。

       注意：tasks-vision 的 handedness 假定输入是镜像画面；
       我们喂的是未镜像的原始摄像头帧，所以报出的 Left/Right
       与用户实际左右相反，这里统一换算成"用户视角"。 */
    this.handsData = all.map((lm, i) => {
      const h = handedness[i] || {};
      // 摄像头视角 → 用户视角：标签互换
      const cameraLabel = h.label || '';
      const userLabel = cameraLabel === 'Left' ? 'Right'
                      : cameraLabel === 'Right' ? 'Left' : '';
      // 掌心锚点（0/5/9/13/17 的均值）比单点稳
      const ids = [0, 5, 9, 13, 17];
      let cx = 0, cy = 0;
      for (const k of ids) { cx += lm[k].x; cy += lm[k].y; }
      cx /= ids.length; cy /= ids.length;
      return {
        landmarks: lm,
        world: worlds[i] || null,
        label: userLabel,
        score: h.score ?? 0,
        // 注意：这里的 pointer 还是【未镜像】的原始视频坐标
        pointer: { x: cx, y: cy },
      };
    });

    // 排序：Left(用户左手) 在前
    this.handsData.sort((a, b) => {
      const rank = (d) => (d.label === 'Left' ? 0 : d.label === 'Right' ? 1 : 2);
      const r = rank(a) - rank(b);
      return r !== 0 ? r : b.score - a.score;
    });

    this.twoHandActive = this.handsData.length >= 2;

    /* ---------- 主手：优先用用户右手（右手控制绽放更符合直觉） ---------- */
    const primary =
      this.handsData.find((h) => h.label === 'Right') ||
      this.handsData[0] ||
      null;

    this.lastLandmarks = primary ? primary.landmarks : null;
    this.lastWorldLandmarks = primary ? primary.world : null;
    this.lastHandedness = primary
      ? { label: primary.label, score: primary.score }
      : null;
    this.pointerActive = !!primary;

    if (primary) {
      this.pointerTarget.set(primary.pointer.x, primary.pointer.y);
    }

    this._drawOverlay(this.handsData);
    this.onResults(this.lastLandmarks, {
      handedness: this.lastHandedness,
      hands: this.handsData,
      twoHand: this.twoHandActive,
      worldLandmarks: this.lastWorldLandmarks,
    });
  }

  /** 手部骨架 + 关键点绘制（镜像后绘制，与视频背景方向一致）
   *  @param {Array} handsData 每只手 { landmarks, label }；空数组表示清空
   */
  _drawOverlay(handsData) {
    const canvas = this.overlay;
    const ctx = this.overlayCtx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // 尺寸自适应（只在变化时重设，避免每帧清空画布）
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const list = Array.isArray(handsData) ? handsData.filter((d) => d && d.landmarks) : [];
    if (list.length === 0 || !CONFIG.showSkeleton) return;

    // 归一化坐标 → 画布像素（镜像：x → 1 - x，和镜像的视频背景对齐）
    const px = (p) => (1 - p.x) * canvas.width;
    const py = (p) => p.y * canvas.height;

    const shown = [
      0,                                   // 腕
      1, 2, 3, 4,                          // 拇指
      5, 6, 7, 8,                          // 食指
      9, 10, 11, 12,                       // 中指
      13, 14, 15, 16,                      // 无名指
      17, 18, 19, 20,                      // 小指
    ];

    // 左右手用不同配色，一眼看出哪只手在控制什么
    //   用户右手 → 青蓝（控制绽放）
    //   用户左手 → 品红（辅助生长）
    //   未知     → 淡白
    const PALETTE = {
      Right: { line: 'rgba(124, 231, 255, 0.62)', glow: 'rgba(124, 231, 255, 0.9)', tip: 'rgba(160, 240, 255, 1)' },
      Left:  { line: 'rgba(255, 150, 210, 0.62)', glow: 'rgba(255, 122, 198, 0.9)', tip: 'rgba(255, 170, 220, 1)' },
      '':    { line: 'rgba(225, 235, 255, 0.55)', glow: 'rgba(220, 232, 255, 0.85)', tip: 'rgba(240, 248, 255, 1)' },
    };

    for (const hand of list) {
      const lm = hand.landmarks;
      const pal = PALETTE[hand.label] || PALETTE[''];

      // ---- 连线 ----
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 2.2 * dpr;
      ctx.shadowColor = pal.glow;
      ctx.shadowBlur = 8 * dpr;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(px(lm[a]), py(lm[a]));
        ctx.lineTo(px(lm[b]), py(lm[b]));
      }
      ctx.stroke();

      // ---- 关键点 ----
      for (const i of shown) {
        const isTip = [4, 8, 12, 16, 20].includes(i);
        ctx.beginPath();
        ctx.arc(px(lm[i]), py(lm[i]), (isTip ? 5 : 3.4) * dpr, 0, Math.PI * 2);
        if (isTip) {
          ctx.fillStyle = pal.tip;
          ctx.shadowColor = pal.glow;
          ctx.shadowBlur = 14 * dpr;
        } else {
          ctx.fillStyle = 'rgba(235, 245, 255, 0.92)';
          ctx.shadowColor = 'rgba(255, 255, 255, 0.9)';
          ctx.shadowBlur = 8 * dpr;
        }
        ctx.fill();
      }
    }

    /* ---- 双手模式：画出两掌之间的连线 + 距离提示 ----
       这条线是"双手交互"的视觉锚点：它随距离伸缩，
       直观告诉使用者"拉得越开，花长得越多"。 */
    if (list.length >= 2) {
      const [a, b] = list;
      const ax = px(a.pointer), ay = py(a.pointer);
      const bx = px(b.pointer), by = py(b.pointer);

      ctx.save();
      ctx.shadowColor = 'rgba(255, 230, 150, 0.9)';
      ctx.shadowBlur = 12 * dpr;
      ctx.strokeStyle = 'rgba(255, 235, 170, 0.75)';
      ctx.lineWidth = 1.6 * dpr;
      ctx.setLineDash([7 * dpr, 7 * dpr]);   // 虚线，区别于骨架实线
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);

      // 两端的掌心小圆
      for (const [x, y] of [[ax, ay], [bx, by]]) {
        ctx.beginPath();
        ctx.arc(x, y, 8 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 240, 190, 0.9)';
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.shadowBlur = 0;
  }

  /** 把 getUserMedia 的报错翻译成人话 */
  _describeCameraError(err) {
    const name = err?.name || '';
    const map = {
      NotAllowedError:
        '摄像头权限被拒绝。请在浏览器地址栏左侧的锁形图标里允许「摄像头」，然后刷新页面重试。',
      PermissionDeniedError:
        '摄像头权限被拒绝。请允许摄像头访问后刷新页面。',
      NotFoundError:
        '没有检测到可用的摄像头设备。请连接摄像头或使用带摄像头的设备重试。',
      DevicesNotFoundError:
        '没有检测到可用的摄像头设备。',
      NotReadableError:
        '摄像头被其他程序占用（如会议软件、相机应用）。请关闭占用的程序后重试。',
      TrackStartError:
        '摄像头无法启动，可能被其他程序占用。',
      OverconstrainedError:
        '摄像头不支持请求的分辨率。已尝试 640×480，请更换设备或降低分辨率要求。',
      SecurityError:
        '安全限制：请通过 https:// 或 http://localhost 打开页面，file:// 协议下无法使用摄像头。',
      AbortError:
        '摄像头启动被中断，请重试。',
    };
    return map[name] || `无法打开摄像头：${err?.message || name || '未知错误'}`;
  }

  /** 停止识别并释放摄像头 */
  stop() {
    this.running = false;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.onStatus('摄像头已关闭');
    this.handsData = [];
    this.twoHandActive = false;
    this.lastLandmarks = null;
    this.lastWorldLandmarks = null;
    this.pointerActive = false;
    this._drawOverlay([]);
    this.onResults(null, { hands: [], twoHand: false, worldLandmarks: null });
  }

  /** 每帧调用：平滑手指指针位置 */
  update(dt) {
    // 镜像：MediaPipe 输出的是原始视频坐标，画面是镜像的
    const targetX = 1 - this.pointerTarget.x;
    const targetY = this.pointerTarget.y;
    this.pointer.x = damp(this.pointer.x, this.pointerActive ? targetX : 0.5, 0.14, dt);
    this.pointer.y = damp(this.pointer.y, this.pointerActive ? targetY : 0.5, 0.14, dt);
  }
}

/* ==========================================================================
   §4  粒子花朵 FlowerField
   --------------------------------------------------------------------------
   5 万粒子池一次性建好，滑块只改 drawRange（不重建几何体）。

   花瓣用极坐标玫瑰曲线：r(θ) = |cos(k·θ/2)|^sharp，k = 花瓣数。
   k 个峰值 → k 个花瓣；sharp < 1 时瓣变瘦、瓣间凹陷更深。
   r 再乘 sqrt(u) 让粒子在**面积**上均匀（否则全挤在圆心）。

   每颗粒子两个位置（花苞 aPosBud / 绽放 aPosBloom）与两个颜色，
   顶点着色器用 uBloom 插值 —— 绽放不改绘制量，只改 uniform。
   ========================================================================== */

const FLOWER_VERT = /* glsl */ `
  precision highp float;

  attribute vec3  aPosBud;
  attribute vec3  aColor;
  attribute vec4  aInfo;      // x 随机种子 / y 尺寸 / z 角色(0瓣1心2尘) / w 层级

  uniform float uBloom;
  uniform float uTime;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uGlow;
  uniform float uFade;      // 彩蛋时把花整体淡出
  uniform float uDensity;   // 密度补偿：粒子越多，单颗越暗（否则加法混合必然过曝）
  uniform float uSpin;
  uniform vec3  uPointer;     // 指尖/鼠标位置（模型空间近似）
  uniform float uPointerActive;
  uniform float uRepel;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vSeed;
  varying float vRole;

  void main() {
    float seed = aInfo.x;
    float role = aInfo.z;
    float b = clamp(uBloom, 0.0, 1.0);

    /* ---------- ① 花苞 ↔ 绽放 → 爱心 ----------
       position 这个属性由 CPU 负责在"花朵坐标"与"爱心坐标"之间插值
       （见 FlowerField.update：化形进度写进顶点缓冲，9 万颗粒子错峰被吸过去），
       所以这里只管花苞 ↔ 当前形态。 */
    vec3 pos = mix(aPosBud, position, b);

    /* 绽放时整朵花"拧"一下：花瓣一边张开一边旋转 */
    float ang = b * uSpin * (0.55 + aInfo.w * 0.9) + seed * 0.15;
    float ca = cos(ang), sa = sin(ang);
    pos.xz = mat2(ca, -sa, sa, ca) * pos.xz;

    /* ---------- ② 呼吸 / 飘动（3 个三角函数，比 3D 噪声便宜一个数量级） ---------- */
    float t = uTime;
    pos.y  += sin(t * 0.9  + seed * 6.283) * 0.026 * (0.35 + b);
    pos.xz *= 1.0 + sin(t * 0.7 + seed * 9.42) * 0.010 * (0.35 + b);

    /* ---------- ③ 指尖 / 鼠标排斥 ----------
       目标点附近把粒子推开并点亮，跟手反馈靠它。
       注意 d 可能为 0，必须给长度一个下限，否则 normalize 除零出 NaN。 */
    float distP = 1e3;
    if (uPointerActive > 0.5) {
      vec3 d = pos - uPointer;
      float len0 = length(d);
      float safeLen = max(len0, 1e-4);
      distP = len0;
      pos += (d / safeLen) * exp(-len0 * len0 * 1.6) * uRepel * (0.6 + b);
    }

    /* ---------- ④ 投影与尺寸 ---------- */
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float depth = -mv.z;
    float persp = clamp(5.6 / max(depth, 0.55), 0.35, 2.4);
    float sizeK = 0.55 + aInfo.y;
    /* 花苞期只让一部分粒子可见（30% → 100%）：苞体的粒子名义上摊在整片
       花瓣上，收拢后挤在同一个小体积里，加法混合必然烧成一根白棒。
       化形成爱心时体量够大，放开到 85% 才够饱满。 */
    float keep = 0.30 + 0.70 * b;
    float vis = step(seed, keep);
    gl_PointSize = clamp(uSize * sizeK * uPixelRatio * persp, 1.0, 48.0) * vis;
    if (depth < 0.6) gl_PointSize = 0.0;

    /* ---------- ⑤ 颜色 ---------- */
    /* 花苞期整体偏玫红、偏暗；绽放后回到花瓣本色；爱心则整体推向玫瑰红 */
    vec3 budCol = mix(aColor, vec3(0.62, 0.13, 0.30), 0.45) * 0.92;
    vec3 col = mix(budCol, aColor, b);

    /* 亮度：花心金粉最亮，花瓣次之
       轴心附近粒子密度极高（所有花瓣都收在 r≈0），不压一压会烧成一个白球，
       颜色就全丢了。这里按离轴距离给一点衰减。 */
    float centerBoost = role > 0.5 && role < 1.5 ? 0.95 : 1.0;
    float radial = length(pos.xz);
    float coreAtten = mix(0.38, 1.0, smoothstep(0.02, 0.85, radial));
    float glow = uGlow * uDensity * centerBoost * coreAtten * (0.72 + 0.55 * seed);

    /* 指尖附近更亮 */
    if (uPointerActive > 0.5) glow += exp(-distP * distP * 1.6) * 0.9;

    /* 花苞期依旧要压亮度：苞体小、粒子密，加法混合容易烧白。 */
    glow *= mix(0.23, 1.0, b);

    vColor = col;
    vAlpha = mix(0.34, 1.0, b) * uFade;
    vSeed = seed;
    vRole = role;
  }
`;

const FLOWER_FRAG = /* glsl */ `
  precision highp float;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vSeed;
  varying float vRole;

  uniform float uColorFlow;
  uniform float uGlow;
  uniform float uTime;

  void main() {
    /* 圆形柔边（用 dot 而不是 length，省一次开方） */
    vec2 q = gl_PointCoord - 0.5;
    float r2 = dot(q, q);
    if (r2 > 0.25) discard;

    float soft = 1.0 - r2 * 4.0;
    float core = soft * soft * soft;

    /* ---------- 炫光流彩：色相沿时间与随机相位缓慢流动 ----------
       低 colorFlow 时几乎看不出，高的时候每颗粒子的色调都在漂移，
       整朵花呈现"流彩"的观感。 */
    float wave = sin(uTime * 0.75 + vSeed * 6.2831853);
    float c = uColorFlow;
    vec3 flow = vColor * vec3(
      1.0 + 0.55 * c * wave,
      1.0 + 0.30 * c * sin(vSeed * 12.0 + uTime * 0.5),
      1.0 - 0.45 * c * wave
    );

    /* 饱和度：往"更艳"的方向推一点 */
    float lum = dot(flow, vec3(0.299, 0.587, 0.114));
    flow = mix(vec3(lum), flow, 1.0 + 0.5 * c);

    /* 亮度：发光强度 × 中心亮核 */
    vec3 col = flow * uGlow * (0.42 + 0.80 * core);

    /* 花心金粉再补一点暖白，做出那个"烛焰"般的核心 */
    if (vRole > 0.5 && vRole < 1.5) {
      col += vec3(1.0, 0.84, 0.48) * core * 0.42;
    }

    gl_FragColor = vec4(col, soft * vAlpha * 0.92);
  }
`;

class FlowerField {
  constructor() {
    this.group = new THREE.Group();
    this.group.rotation.x = 0.42;   // 整组前倾（下面那朵因此能看到花心）
    this.build();
  }

  /** 建 9 万粒子池（两朵花 + 花心 + 尘埃，只建一次，之后只改 drawRange） */
  build() {
    const N = MAX_PARTICLES;
    const posBloom = new Float32Array(N * 3);
    const posBud = new Float32Array(N * 3);
    const posHeart = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const info = new Float32Array(N * 4);

    /* 调色板（两朵花共用同一套） */
    const C_CORE = new THREE.Color().setHSL(0.090, 1.00, 0.56);   // 花心金
    const C_INNER = new THREE.Color().setHSL(0.952, 0.92, 0.60);  // 内层暖粉
    const C_MID = new THREE.Color().setHSL(0.940, 0.90, 0.62);    // 瓣面
    const C_EDGE = new THREE.Color().setHSL(0.930, 0.95, 0.70);   // 瓣缘亮粉
    const C_MOTE = new THREE.Color().setHSL(0.13, 0.55, 0.82);    // 尘埃暖白

/* ---------- 上下两朵花，看起来长在同一根"茎"上 ----------
       下面这朵是主花（大），上面这朵小一号（0.58 倍）并自动抬高，
       两朵的 x/z 都贴着中轴，只差高度和大小 —— 视觉上就是一根茎上的两朵花。
       粒子按 62 : 38 **交错**分配（i % 100），这样即使把粒子数量滑块拉低，
       也总还有两朵花，不会只剩一朵。 */
    /* 只有一朵花。内外两层花瓣靠 layer 区分（见下方 layerScale / layerLift / bowl）。 */
    const FLOWER_LAYOUT = [
      { share: 100, cy: 0.00, scale: 1.00, lean: 0.00, tilt: 0.00 },
    ];

    const k = CONFIG.petalCount;
    const sharp = CONFIG.petalSharp;
    const tmp = new THREE.Color();

    /* ---------- 爱心目标点池（两指 V 时粒子聚成的心） ----------
       用经典参数心形曲线
           x = 16 sin³t
           y = 13cos t − 5cos2t − 2cos3t − cos4t
       它的轮廓"上双瓣、下尖角"最标准，比隐函数 (x²+y²−1)³=x²y³ 那种
       圆屁股的坨子更像一颗心。
       填充方式：先把曲线扫线栅格化成占用网格，再按格子面积均匀取点。
       （不用"从中心放射缩放"那套：心形的矢量和尖角都在中轴线上，
       放射采样会在正中堆出一条又直又亮的脊，看着像被人从中间剖开。）
       34% 的点取贴边格子，心形的边才立得住；z 按离中心的距离收一个透镜厚度。
       预采 6000 点做池，9 万颗粒子各取一个 + 抖动，省掉 9 万次计算。 */
    const HEART_POOL = (() => {
      const raw = (t) => [
        16 * Math.sin(t) ** 3,
        13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
      ];
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
      const STEPS = 192;
      const curve = [];
      for (let i = 0; i < STEPS; i++) {
        const [x, y] = raw((i / STEPS) * Math.PI * 2);
        curve.push([x, y]);
        mnx = Math.min(mnx, x); mxx = Math.max(mxx, x);
        mny = Math.min(mny, y); mxy = Math.max(mxy, y);
      }
      const ccx = (mnx + mxx) / 2;
      const ccy = (mny + mxy) / 2;
      const sx = 2 / (mxx - mnx);        // 归一化到 x ∈ [-1, 1]
      const sy = sx * 1.12;              // 纵向略拉长，心形更精神
      const poly = curve.map(([x, y]) => [(x - ccx) * sx, (y - ccy) * sy]);
      let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      for (const [x, y] of poly) {
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
        by0 = Math.min(by0, y); by1 = Math.max(by1, y);
      }

      /* 扫线填充 → 占用网格 */
      const G = 132;
      const grid = new Uint8Array(G * G);
      const xs = [];
      for (let gy = 0; gy < G; gy++) {
        const y = by0 + (gy + 0.5) / G * (by1 - by0);
        xs.length = 0;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i], [xj, yj] = poly[j];
          if ((yi > y) !== (yj > y)) xs.push((xj - xi) * (y - yi) / (yj - yi) + xi);
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const gx0 = Math.max(0, Math.ceil((xs[k] - bx0) / (bx1 - bx0) * G - 0.5));
          const gx1 = Math.min(G - 1, Math.floor((xs[k + 1] - bx0) / (bx1 - bx0) * G - 0.5));
          for (let gx = gx0; gx <= gx1; gx++) grid[gy * G + gx] = 1;
        }
      }

      /* 内部格子 + 贴边格子 */
      const inner = [];
      const edge = [];
      for (let gy = 0; gy < G; gy++) {
        for (let gx = 0; gx < G; gx++) {
          if (!grid[gy * G + gx]) continue;
          inner.push(gy * G + gx);
          const up = gy + 1 < G ? grid[(gy + 1) * G + gx] : 0;
          const dn = gy - 1 >= 0 ? grid[(gy - 1) * G + gx] : 0;
          const lf = gx - 1 >= 0 ? grid[gy * G + gx - 1] : 0;
          const rt = gx + 1 < G ? grid[gy * G + gx + 1] : 0;
          if (!(up && dn && lf && rt)) edge.push(gy * G + gx);
        }
      }

      const halfY = (by0 + by1) / 2;
      const out = [];
      for (let i = 0; i < 6000; i++) {
        const shell = Math.random() < 0.34;
        const src = shell && edge.length ? edge : inner;
        const cell = src[(Math.random() * src.length) | 0];
        const gx = cell % G;
        const gy = (cell - gx) / G;
        const x = bx0 + (gx + Math.random()) / G * (bx1 - bx0);
        const y = by0 + (gy + Math.random()) / G * (by1 - by0);
        const r = Math.min(1, Math.hypot(x, (y - halfY) * 1.1));
        const zmax = 0.26 * Math.sqrt(Math.max(0.02, 1 - r * r)) * (0.55 + 0.45 * Math.random());
        out.push([x, y, (Math.random() < 0.5 ? -1 : 1) * zmax]);
      }
      return out;
    })();

    /** 玫瑰曲线：|cos(kθ/2)|^sharp（sharp 越小瓣越圆润、越大越尖瘦） */
    const petalR = (theta, s = sharp) => Math.pow(Math.abs(Math.cos((k * theta) / 2)), s);

    for (let i = 0; i < N; i++) {
      const o = i * 3;
      const layer = i % 4 === 0 ? 1 : 0;     // 1 = 内层（旋转 30°、更小更高）
      const seed = Math.random();

      // 这颗粒子属于哪一朵花（交错分配）
      const F = FLOWER_LAYOUT[(i % 100) < FLOWER_LAYOUT[0].share ? 0 : 1];

      // 角色：花心 / 尘埃 / 花瓣
      const roll = Math.random();
      const isCore = roll < CONFIG.centerRatio;
      const isMote = !isCore && roll < CONFIG.centerRatio + CONFIG.moteRatio;

      /* 局部坐标 → 那朵花的坐标：先按 tilt 前倾，再缩放、抬高 */
      const ct = Math.cos(F.tilt);
      const st = Math.sin(F.tilt);
      const toBloom = (lx, ly, lz) => {
        const yy = ly * ct - lz * st;
        const zz = ly * st + lz * ct;
        posBloom[o] = lx * F.scale + F.lean;
        posBloom[o + 1] = yy * F.scale + F.cy;
        posBloom[o + 2] = zz * F.scale;
      };
      const toBud = (lx, ly, lz) => {
        const yy = ly * ct - lz * st;
        const zz = ly * st + lz * ct;
        posBud[o] = lx * F.scale + F.lean;
        posBud[o + 1] = yy * F.scale + F.cy;
        posBud[o + 2] = zz * F.scale;
      };

      /* 爱心目标：从点池里随机取一个，加一点抖动免得整颗心像贴图 */
      const hp = HEART_POOL[(Math.random() * HEART_POOL.length) | 0];
      const jx = (Math.random() - 0.5) * 0.024;
      const jy = (Math.random() - 0.5) * 0.024;
      const jz = (Math.random() - 0.5) * 0.020;
      /** s = 相对心形的缩放（花心收在中间、尘埃散在外圈） */
      const toHeart = (s, dy = 0) => {
        const HS = CONFIG.heartScale * s;
        posHeart[o] = hp[0] * HS + jx;
        posHeart[o + 1] = hp[1] * HS + CONFIG.heartLift + dy + jy;
        posHeart[o + 2] = hp[2] * HS + jz;
      };

      if (!isCore && !isMote) {
        /* ---------- 花瓣粒子 ----------
           θ 用「按 r(θ) 加权」的拒绝采样：让粒子聚到 6 个瓣上、
           瓣与瓣之间的缝留空。均匀取 θ 的话，缝隙处 r≈0 的粒子
           全堆在圆心，花就糊成一个盘，看不出花瓣。 */
        let theta = 0;
        let rMax = 0;
        /* 内层的花瓣用更小的锐度指数 → 花瓣更宽更圆，
           这样它虽小，但看起来和外层是同一个品种的瓣。 */
        const sharpLocal = layer ? sharp * 0.6 : sharp;
        for (let tries = 0; tries < 8; tries++) {
          theta = Math.random() * Math.PI * 2;
          rMax = petalR(theta, sharpLocal);
          if (Math.random() < rMax * rMax) break;     // 留在瓣上
        }
        const u = Math.sqrt(Math.random());            // 面积均匀

        /* 两层花瓣**都从同一个花心长出来**（u→0 时 r→0、y→0），
           区别只在"张开程度"：
             外层：开得透 —— 半径大、几乎平铺，瓣尖微微上翘
             内层：开得含蓄 —— 半径只有 0.52 倍，但随半径快速升高，
                   形成一个立在花心上的小杯（这才是真花的"两层"）
           注意内层不能整体抬高：那样花瓣根部就悬在中心上方了，
           看起来像两朵花叠在一起，而不是一朵花的两层。 */
        const layerScale = layer ? 0.55 : 1.0;
        const layerRot = layer ? Math.PI / CONFIG.petalCount : 0;

        // 抖一下 θ，让瓣缘不是硬边
        const th = theta + layerRot + (Math.random() - 0.5) * 0.05;
        const r = (0.13 + 0.87 * u) * rMax * 1.55 * layerScale * CONFIG.bloomScale;

        const x = Math.cos(th) * r;
        const z = Math.sin(th) * r;
        /* 高度剖面（u 越小越靠花心，两层在 u→0 处都收在同一点）：
             外层 y = 0.07·u + 0.15·u³          基本平铺，只有瓣尖翘起来
             内层 y = 0.40·u^1.12               从花心升上去，开口比外层浅
           摊开度的差别 = 外层 r 大而 y 小、内层 r 小而 y 大。 */
        const y = layer
          ? Math.pow(u, 1.12) * 0.40
          : u * 0.07 + Math.pow(u, 3) * 0.15;
        const yy = y + (Math.random() - 0.5) * 0.03;
        toBloom(x, yy, z);

        /* ---------- 花苞：6 片花瓣各自卷合，收成一个闭合的尖苞 ----------
           每颗粒子保留它在瓣上的角度 th 与径向位置 u：
             u → 苞体的高度（0 = 瓣根在苞底，1 = 瓣尖收在苞顶）
             瓣心半径大、瓣与瓣的接缝处半径小 → 六道竖向瓣沟
           原来那版是半径 0.16 的细柱，收拢起来就是一根白棒；
           现在有瓣、有沟、有尖顶，才看得出"这是花苞"。 */
        const sector = (Math.PI * 2) / CONFIG.petalCount;
        const thP = th - (layer ? Math.PI / CONFIG.petalCount : 0);  // 内层去掉自己的相位
        const pc = Math.round(thP / sector) * sector;                // 所属花瓣的中心角
        const dAng = clamp(Math.abs(thP - pc) / (sector * 0.5));     // 0 = 瓣心，1 = 接缝
        const rib = Math.pow(Math.cos(dAng * Math.PI * 0.5), 0.7);   // 瓣心 1 → 接缝 0

        const v = Math.pow(u, 0.9);                                  // 瓣根 → 瓣尖
        const layerK = layer ? 0.62 : 1.0;                           // 内层收在外层里面
        /* 苞体侧影：底部收窄 0.7、1/3 高处最宽、往上收成尖顶 —— 这是花苞的轮廓；
           旧版「从底到顶一路变细」画出来是个圆锥，不像苞。 */
        const RMAX = 0.46;
        const profile = v < 0.45
          ? 0.70 + 0.30 * Math.pow(v / 0.45, 0.6)
          : Math.pow(Math.max(0, 1 - Math.pow((v - 0.45) / 0.55, 1.8)), 0.8);
        const Rb = (RMAX * profile + 0.02) * layerK;
        /* 瓣尖散开一点：所有瓣尖都收到同一个点会烧出一根白刺 */
        const tipScatter = v > 0.75 ? Math.random() * 0.09 * (v - 0.75) / 0.25 : 0;
        const tipSplay = smoothstep(0.82, 1, v) * 0.06;               // 顶端瓣尖微微外翻
        // rib^0.55：瓣面宽阔、只有接缝处收窄，才看得出"一片片的花瓣"
        const rBud = (Rb + tipScatter + tipSplay) * (0.66 + 0.46 * Math.pow(rib, 0.55));
        const tw = 0.28 * v;                                         // 苞体轻轻拧一下（真花苞的螺旋感）
        const yBud = 0.05 + v * (layer ? 0.90 : 1.20);
        toBud(
          Math.cos(th + tw) * rBud,
          yBud + (Math.random() - 0.5) * 0.02,
          Math.sin(th + tw) * rBud
        );
        toHeart(1.0);                          // 花瓣粒子铺满整颗心

        /* 颜色：瓣缘最亮，往里偏暖，最深处带一点金 */
        const edgeT = clamp(u);
        tmp.copy(C_MID)
          .lerp(C_EDGE, Math.pow(edgeT, 2.2) * 0.85)
          .lerp(C_INNER, (1 - edgeT) * 0.55);
        if (layer) tmp.lerp(C_CORE, 0.22);
        tmp.offsetHSL((Math.random() - 0.5) * 0.012, 0, (Math.random() - 0.5) * 0.06);

        colors[o] = tmp.r; colors[o + 1] = tmp.g; colors[o + 2] = tmp.b;
        info[i * 4] = seed;
        info[i * 4 + 1] = 0.25 + Math.random() * 0.55;   // 尺寸系数
        info[i * 4 + 2] = 0;                              // 角色：花瓣
        info[i * 4 + 3] = layer ? 1 : 0;                  // 层级（影响拧转）

      } else if (isCore) {
        /* ---------- 花心金粉：密集的小球，撑出那个亮核 ---------- */
        const a = Math.random() * Math.PI * 2;
        const rr = Math.pow(Math.random(), 0.55) * 0.30;
        const y = 0.12 + Math.pow(Math.random(), 0.8) * 0.30;
        toBloom(Math.cos(a) * rr, y, Math.sin(a) * rr);
        // 花苞里金粉藏在苞心偏下的位置，只透出一点暖光
        toBud(Math.cos(a) * rr * 0.30, 0.12 + Math.pow(Math.random(), 0.9) * 0.34, Math.sin(a) * rr * 0.30);
        toHeart(0.45);                         // 金粉收在心的中央，撑出暖核

        tmp.copy(C_CORE).offsetHSL((Math.random() - 0.5) * 0.05, 0, (Math.random() - 0.5) * 0.08);
        colors[o] = tmp.r; colors[o + 1] = tmp.g; colors[o + 2] = tmp.b;
        info[i * 4] = seed;
        info[i * 4 + 1] = 0.10 + Math.random() * 0.16;
        info[i * 4 + 2] = 1;                              // 角色：花心
        info[i * 4 + 3] = 1;

      } else {
        /* ---------- 飘散尘埃：花周围的一层薄雾 ---------- */
        const a = Math.random() * Math.PI * 2;
        const rr = 1.5 + Math.random() * 1.8;
        const y = (Math.random() - 0.45) * 1.8;
        toBloom(Math.cos(a) * rr, y, Math.sin(a) * rr);
        // 花苞期尘埃围在苞体外侧，撑出一层很薄的辉光
        toBud(Math.cos(a) * rr * 0.30, 0.10 + Math.random() * 1.30, Math.sin(a) * rr * 0.30);
        toHeart(1.06, (Math.random() - 0.5) * 0.20);   // 尘埃绕着心飘一层薄辉光

        tmp.copy(C_MOTE).offsetHSL(0, 0, (Math.random() - 0.5) * 0.1);
        colors[o] = tmp.r; colors[o + 1] = tmp.g; colors[o + 2] = tmp.b;
        info[i * 4] = seed;
        info[i * 4 + 1] = 0.12 + Math.random() * 0.22;
        info[i * 4 + 2] = 2;                              // 角色：尘埃
        info[i * 4 + 3] = 0;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posBloom, 3));
    geo.setAttribute('aPosBud', new THREE.BufferAttribute(posBud, 3));
    geo.setAttribute('aPosHeart', new THREE.BufferAttribute(posHeart, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    // 只画前 particleCount 颗（滑块只改这个数字）
    geo.setDrawRange(0, Math.min(params.particleCount, N));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 12);

    /* 化形用的两份坐标：绽放位置（原点集）与爱心位置。
       position 属性会被就地改写（花朵 ↔ 爱心插值），所以先把绽放坐标留一份底。 */
    this.bloomPos = posBloom.slice();
    this.heartPos = posHeart;
    this.seedArr = info;          // info[4i] 是随机种子，用来给粒子错峰
    /* 颜色也要留一份底：化形成心时会把 aColor 乘上一个"补光系数"，
       把核心衰减（coreAtten，0.38 起）抵回来；收回时按底稿原样恢复。 */
    this.baseColor = colors.slice();
    this._heartPrev = 0;

    this.uniforms = {
      uBloom: { value: 0.5 },
      uTime: { value: 0 },
      uSize: { value: params.particleSize },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio) },
      uGlow: { value: params.glowIntensity },
      uFade: { value: 1 },
      uDensity: { value: 1 },
      uSpin: { value: CONFIG.spinTurns * Math.PI * 2 },
      uPointer: { value: new THREE.Vector3(0, 0, 2) },
      uPointerActive: { value: 0 },
      uRepel: { value: CONFIG.pointerRepel },
      uColorFlow: { value: params.colorFlow },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: FLOWER_VERT,
      fragmentShader: FLOWER_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.group.add(this.points);
  }

  /** 滑块拖动时只改绘制范围，不重建几何体 */
  setCount(n) {
    const count = Math.max(1, Math.min(n, MAX_PARTICLES));
    this.points.geometry.setDrawRange(0, count);
    /* 密度补偿：加法混合下总亮度 ≈ 粒子数 × 单颗亮度，
       所以粒子翻倍就必须把单颗压暗，否则整朵花会烧成白团。
       以 5 万颗为基准 1.0；9 万颗约 0.55，1 万颗约 3（封顶）。 */
    this.uniforms.uDensity.value = Math.min(3, Math.max(0.3, 50000 / count));
  }

  update(state, dt) {
    const u = this.uniforms;
    const hvNow = state.heart || 0;
    /* 化形成心时 bloom 顶到 1：position 里已经是爱心坐标，
       再让它跟着花苞插值会把心压扁压暗。 */
    u.uBloom.value = state.bloom + (1 - state.bloom) * hvNow;

    /* ---------- 化形成心（花朵 ↔ 爱心） ----------
       把进度直接烘进 position 顶点缓冲：9 万颗一次线性插值，
       每颗粒子按 seed 错峰 0.16，粒子是一波一波被吸过去的。
       只在进度真的变了时才重算/上传（静止时零开销）。

       关键：着色器会对每颗粒子各转一个角度
           ang = bloom·uSpin·(0.55+w·0.9) + seed·0.15
       所以插值必须在"已经转过"的坐标系里做：
       先把花朵坐标正向转 ang，与爱心点插值，再反向转回属性空间，
       着色器那一转就正好把它还原。这样两头都精确，中间是旋转着聚拢的涡流。 */
    const hv = hvNow;
    const spinTot = CONFIG.spinTurns * Math.PI * 2;
    const bCur = u.uBloom.value;
    if (Math.abs(hv - this._heartPrev) > 0.002) {
      this._heartPrev = hv;
      const geo = this.points.geometry;
      const attr = geo.getAttribute('position');
      const A = attr.array, B = this.bloomPos, H = this.heartPos, S = this.seedArr;
      /* 爱心是实心图形，整颗心腹都落在 coreAtten 的衰减区里（0.38 起步），
         所以这里按"心体离中心多近"给 aColor 乘一个补光系数：
         心腹最亮、贴边处不补，形状轮廓靠亮边撑住，心腹不至于糊成一团脏粉色。
         收敛到 0 时按底稿写回，花朵颜色和原来完全一致。 */
      const colAttr = geo.getAttribute('aColor');
      const C = colAttr.array, CB = this.baseColor;
      const n = attr.count;
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        const ang = bCur * spinTot * (0.55 + S[i * 4 + 3] * 0.9) + S[i * 4] * 0.15;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        // 花朵坐标在着色器空间里的样子
        const bx = B[o] * ca + B[o + 2] * sa;
        const bz = -B[o] * sa + B[o + 2] * ca;
        const hi = Math.min(1, Math.max(0, (hv - S[i * 4] * 0.16) / 0.84));
        // 混合后反旋回属性空间
        const mx = bx + (H[o] - bx) * hi;
        const mz = bz + (H[o + 2] - bz) * hi;
        A[o]     = mx * ca - mz * sa;
        A[o + 1] = B[o + 1] + (H[o + 1] - B[o + 1]) * hi;
        A[o + 2] = mx * sa + mz * ca;

        const hr = Math.sqrt(H[o] * H[o] + H[o + 2] * H[o + 2]);
        const att = 1 - Math.min(1, Math.max(0, (hr - 0.02) / (0.85 - 0.02)));
        const smooth = att * att * (3 - 2 * att);
        /* 分通道补光：红提得最多、绿最少，亮度上去了颜色还留在玫瑰红里，
           否则三通道一起拉会把心腹洗成白色一团 */
        const k = hi * smooth;
        C[o]     = CB[o]     * (1 + 0.62 * k);
        C[o + 1] = CB[o + 1] * (1 + 0.26 * k);
        C[o + 2] = CB[o + 2] * (1 + 0.40 * k);
      }
      attr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }
    u.uTime.value += dt;
    u.uPointer.value.copy(state.pointer);
    u.uPointerActive.value = damp(u.uPointerActive.value, state.pointerActive ? 1 : 0, 0.2, dt);
    /* 自转：绽开时慢慢转，化形成心时必须停在正对镜头 ——
       心形一转到侧面，两颗心瓣就压成两团，看不出是心。
       目标角取最近的 2π 整数倍，这样它只"回正"最多半圈，不会绕一大圈。 */
    const hh = state.heart || 0;
    if (hh > 0.002) {
      const target = Math.round(this.group.rotation.y / (Math.PI * 2)) * Math.PI * 2;
      this.group.rotation.y = damp(this.group.rotation.y, target, 0.10 * hh, dt);
    } else {
      this.group.rotation.y += dt * CONFIG.autoRotate;
    }
  }
}

/* ==========================================================================
   §4.5  彩蛋：三指手势 → 粒子消失 → 汇聚成 "Love"
   --------------------------------------------------------------------------
   为什么单独一套粒子、而不是复用花的粒子池：

     文字必须**正对镜头**、立着写。花的粒子都在 `flower.group` 里，而那个
     组是倾斜过的（rotation.x = 0.42），把文字坐标塞进去会被一起拧歪；
     再想反算逆旋转，又会跟「鼠标上下控制俯仰」打架。

     所以文字用独立的 Points（挂在场景根节点），并给每颗粒子存一个
     "从哪来"（aFrom，花的位置附近）和一个"第几个被写出来"（aRank），
     顶点着色器就能做到：笔尖扫到这里 → 这颗粒子从花那边飞过来就位。

   时间轴（秒）：
     vanish 0.45  花淡出（所有粒子消失）
     write  2.40  笔从 x=左 写到 x=右，"Love" 一笔一笔出现
     hold   1.60  停住
     return 0.90  文字淡出、花回来
   ========================================================================== */

/** 彩蛋时间轴（秒）：想整体调快慢就改这里 */
const LOVE_TIMING = {
  vanish: 0.45,   // 花淡出、所有粒子消失
  write: 4.60,    // 一笔一笔写出来（原来 2.4 太快，放慢接近一倍）
  hold: 2.40,     // 写完停住，让人看清
  return: 0.90,   // 文字淡出、花回来
};

const LOVE_VERT = /* glsl */ `
  precision highp float;

  attribute vec3  aFrom;      // 起飞位置（花附近）
  attribute float aRank;      // 0~1：这一颗在"书写顺序"里的位置

  uniform float uReveal;      // 0~1 笔尖进度
  uniform float uAlpha;       // 整体透明度
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uTime;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vTip;

  void main() {
    /* 笔尖扫过 aRank 时，这颗粒子才从 aFrom 飞到位
       （0.10 的窗口 = 一点点拖尾，不会一颗一颗蹦出来） */
    float pen = clamp((uReveal * 1.18 - aRank) / 0.16, 0.0, 1.0);
    float ease = pen * pen * (3.0 - 2.0 * pen);

    vec3 pos = mix(aFrom, position, ease);

    /* 飞行途中轻微上抛，落地感更强 */
    pos.y += sin(ease * 3.14159) * 0.12;

    /* 已经写好的字轻轻呼吸 */
    pos.y += sin(uTime * 1.2 + aRank * 12.0) * 0.008;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float depth = -mv.z;
    float persp = clamp(5.6 / max(depth, 0.55), 0.35, 2.4);
    gl_PointSize = clamp(uSize * uPixelRatio * persp, 1.0, 26.0) * step(0.02, pen);

    /* 笔尖附近更亮更白，写完的字是暖粉色 */
    vTip = exp(-abs(uReveal * 1.18 - aRank) * 26.0);
    vColor = mix(vec3(1.00, 0.42, 0.66), vec3(1.00, 0.94, 0.86), vTip);
    vAlpha = ease * uAlpha;
  }
`;

const LOVE_FRAG = /* glsl */ `
  precision highp float;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vTip;

  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float r2 = dot(q, q);
    if (r2 > 0.25) discard;

    float soft = 1.0 - r2 * 4.0;
    float core = soft * soft * soft;

    vec3 col = vColor * (0.34 + 1.05 * core) * (0.85 + 1.4 * vTip);
    gl_FragColor = vec4(col, soft * vAlpha * 0.82);
  }
`;

class LoveField {
  /**
   * @param {THREE.Scene} scene 挂在场景根节点（不随花倾斜）
   * @param {(t:string)=>void} onPhase 阶段回调（可选）
   */
  constructor(scene) {
    this.scene = scene;
    this.phase = 'idle';
    this.t = 0;
    this.flowerFade = 1;      // 花的不透明度（由本类驱动）
    this.count = 26000;       // 文字用多少颗粒子

    this._build();
  }

  /** 把文字画到离屏 canvas，再把像素点采样成 3D 坐标 */
  _samplePoints() {
    const W = 1000;
    const H = 300;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    // 手写体优先，退到衬线斜体
    ctx.font = 'italic 230px "Segoe Script", "Brush Script MT", "Georgia", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Love', W / 2, H / 2 + 6);

    const data = ctx.getImageData(0, 0, W, H).data;
    const pts = [];
    const step = 2;
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        if (data[(y * W + x) * 4] > 110) pts.push(x, y);
      }
    }
    return { pts, W, H };
  }

  _build() {
    const { pts, W, H } = this._samplePoints();
    const n = Math.max(1, pts.length / 2);
    const N = this.count;

    const pos = new Float32Array(N * 3);
    const from = new Float32Array(N * 3);
    const rank = new Float32Array(N);

    // 文字尺寸（模型空间）：宽 3.6、高 1.08，中心抬到 y = 0.75
    const width = 3.2;
    const height = (H / W) * width;
    const cx = 0;
    const cy = 0.78;
    const cz = 0.9;

    // 起飞位置：围绕花心的一团球壳
    for (let i = 0; i < N; i++) {
      const p = (Math.random() * n) | 0;
      const px = pts[p * 2];
      const py = pts[p * 2 + 1];

      const jx = (Math.random() - 0.5) * 0.012;
      const jy = (Math.random() - 0.5) * 0.012;

      pos[i * 3] = cx + (px / W - 0.5) * width + jx;
      pos[i * 3 + 1] = cy - (py / H - 0.5) * height + jy;
      pos[i * 3 + 2] = cz + (Math.random() - 0.5) * 0.06;

      /* 书写顺序：主要按 x 从左到右，掺一点 y 与随机抖动，
         这样同一列的点不会同时出现，像笔尖扫过去的拖尾 */
      rank[i] = clamp(px / W + (Math.random() - 0.5) * 0.035);

      // 起飞点：花周围的一个扁球
      const a = Math.random() * Math.PI * 2;
      const rr = 0.4 + Math.random() * 1.3;
      from[i * 3] = Math.cos(a) * rr;
      from[i * 3 + 1] = 0.25 + (Math.random() - 0.5) * 1.1;
      from[i * 3 + 2] = Math.sin(a) * rr * 0.6;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aFrom', new THREE.BufferAttribute(from, 3));
    geo.setAttribute('aRank', new THREE.BufferAttribute(rank, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.7, 0.9), 4);

    this.uniforms = {
      uReveal: { value: 0 },
      uAlpha: { value: 0 },
      uSize: { value: 1.9 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio) },
      uTime: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: LOVE_VERT,
      fragmentShader: LOVE_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.scene.add(this.points);
  }

  get playing() {
    return this.phase !== 'idle';
  }

  /** 触发（重复触发会从头开始） */
  play() {
    this.phase = 'vanish';
    this.t = 0;
    this.points.visible = true;
    this.uniforms.uReveal.value = 0;
    this.uniforms.uAlpha.value = 0;
  }

  update(dt) {
    if (this.phase === 'idle') return;
    this.uniforms.uTime.value += dt;
    this.t += dt;

    const u = this.uniforms;
    const T = LOVE_TIMING;

    if (this.phase === 'vanish') {
      // 花淡出
      const k = clamp(this.t / T.vanish);
      this.flowerFade = 1 - k;
      u.uAlpha.value = 0;
      if (k >= 1) { this.phase = 'write'; this.t = 0; this.flowerFade = 0; }

    } else if (this.phase === 'write') {
      // 笔尖从左写到右
      this.flowerFade = 0;
      u.uAlpha.value = 1;
      u.uReveal.value = clamp(this.t / T.write);
      if (this.t >= T.write) { this.phase = 'hold'; this.t = 0; u.uReveal.value = 1; }

    } else if (this.phase === 'hold') {
      this.flowerFade = 0;
      u.uAlpha.value = 1;
      if (this.t >= T.hold) { this.phase = 'return'; this.t = 0; }

    } else if (this.phase === 'return') {
      // 文字淡出、花回来
      const k = clamp(this.t / T.return);
      u.uAlpha.value = 1 - k;
      this.flowerFade = k;
      if (k >= 1) {
        this.phase = 'idle';
        this.t = 0;
        this.flowerFade = 1;
        u.uAlpha.value = 0;
        this.points.visible = false;
      }
    }
  }

  resize(dpr) {
    this.uniforms.uPixelRatio.value = dpr;
  }
}
/* ==========================================================================
   §5  舞台 Stage：渲染器 / 场景 / 泛光后期 / 摄像头背景 / 星尘
   ========================================================================== */

/** 生成一张径向渐变的柔光点贴图（PointsMaterial 不贴图会画成实心方块） */
function makeSoftDotTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class Stage {
  constructor(glCanvas, video, previewEl) {
    this.glCanvas = glCanvas;
    this.video = video;
    /** 左上角摄像头小窗（DOM 元素，视频 + 骨架都画在里面，不进 WebGL） */
    this.previewEl = previewEl;

    this.renderer = new THREE.WebGLRenderer({
      canvas: glCanvas,
      antialias: false,           // 粒子用不到 MSAA
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = params.brightness;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);

    /* 相机轨道状态（鼠标模式会改它，「恢复初始状态」也会改它） */
    this.cam = {
      x: DEFAULT_STATE.camera.x,
      y: DEFAULT_STATE.camera.y,
      z: DEFAULT_STATE.camera.z,
      targetY: DEFAULT_STATE.camera.targetY,
      rotY: 0,
      rotX: 0,
      zoom: 1,
      panX: 0,
      panY: 0,
    };


    /* ---------- 花朵 ---------- */
    this.flower = new FlowerField();
    this.scene.add(this.flower.group);

    /* ---------- 彩蛋：三指手势 → "Love" ---------- */
    this.love = new LoveField(this.scene);

    /* ---------- 星尘（彩色微光，给空间一点体积感） ---------- */
    this._buildStars();

    /* ---------- 后期：RenderPass → Bloom → Output ---------- */
    this.composer = new EffectComposer(this.renderer);
    this.scenePass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.scenePass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      params.bloomStrength,
      params.bloomRadius,
      params.bloomThreshold
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
    this.resize();
  }

  /** 彩色星尘：每颗有自己的颜色与闪烁相位 */
  _buildStars() {
    const N = 900;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const phase = new Float32Array(N);
    const sizes = new Float32Array(N);
    const palette = [
      new THREE.Color(1.0, 0.92, 0.62),   // 暖金
      new THREE.Color(0.62, 1.0, 0.72),   // 青绿
      new THREE.Color(1.0, 0.70, 0.92),   // 淡粉
      new THREE.Color(0.70, 0.86, 1.0),   // 淡蓝
      new THREE.Color(1.0, 1.0, 1.0),     // 白
    ];
    for (let i = 0; i < N; i++) {
      const r = 9 + Math.random() * 16;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.7;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);

      const c = palette[(Math.random() * palette.length) | 0];
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      phase[i] = Math.random() * Math.PI * 2;
      sizes[i] = 0.5 + Math.random() * 1.5;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    this.starUniforms = { uTime: { value: 0 }, uPixelRatio: { value: 1 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.starUniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aPhase;
        attribute float aSize;
        uniform float uTime;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vTwinkle;
        void main() {
          vColor = aColor;
          vTwinkle = 0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * 1.6 + aPhase));
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uPixelRatio * 22.0 / max(-mv.z, 1.0), 1.0, 6.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vTwinkle;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float r2 = dot(q, q);
          if (r2 > 0.25) discard;
          float soft = 1.0 - r2 * 4.0;
          /* 星尘必须压在泛光阈值以下：星星很小很亮，一旦超过阈值，
             它在泛光最低那层 mip（1/16 分辨率）里会被放大成一整块方块。 */
          gl_FragColor = vec4(vColor * soft * vTwinkle, soft * vTwinkle * 0.85);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.stars = new THREE.Points(g, mat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  /**
   * 左上角摄像头小窗的显隐
   * 视频画面由 <video> 元素自己播（CSS 镜像），骨架画在它上面的 canvas 里，
   * 全程不进 WebGL —— 比把视频帧上传成纹理便宜得多。
   */
  setVideoVisible(visible) {
    if (!this.previewEl) return;
    this.previewEl.classList.toggle('hidden', !visible);
  }

  /** 把面板参数同步到渲染管线（滑块实时生效） */
  applyParams() {
    this.flower.uniforms.uSize.value = params.particleSize;
    this.flower.uniforms.uGlow.value = params.glowIntensity;
    this.flower.uniforms.uColorFlow.value = params.colorFlow;
    this.bloomPass.strength = params.bloomStrength;
    this.bloomPass.radius = params.bloomRadius;
    this.bloomPass.threshold = params.bloomThreshold;
    this.renderer.toneMappingExposure = params.brightness;
    this.flower.setCount(params.particleCount);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio);

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);

    this.camera.aspect = w / h;
    this._updateCamera();

    this.flower.uniforms.uPixelRatio.value = dpr;
    this.love.resize(dpr);
    this.starUniforms.uPixelRatio.value = dpr;

  }

  /** 根据轨道状态摆相机（鼠标模式会实时改 cam） */
  _updateCamera() {
    const c = this.cam;
    const dist = c.z / clamp(c.zoom, 0.5, 2.0);
    const aspect = this.camera.aspect;
    const fit = aspect < 1 ? 1 / Math.max(aspect, 0.5) : 1;   // 竖屏拉远
    this.camera.position.set(c.x + c.panX, c.y * fit + c.panY, dist * fit);
    this.camera.lookAt(c.panX, c.targetY, 0);
    this.camera.rotation.y += c.rotY;
    this.camera.rotation.x += c.rotX;
    this.camera.updateProjectionMatrix();
  }

  render(dt, state) {
    this.starUniforms.uTime.value += dt;
    this.flower.update(state, dt);
    /* 彩蛋：写字时把花淡出，写完再淡回来 */
    this.love.update(dt);
    this.flower.uniforms.uFade.value = this.love.flowerFade;
    this.flower.group.visible = this.love.flowerFade > 0.01;
    // 花朵整体俯仰（鼠标 Y 或手势跟随）
    /* 化形成心时把花"摆正"：心是平面图形，前倾 24° 加自转侧看就散成几团了 */
    const hh = state.heart || 0;
    this.flower.group.rotation.x = damp(
      this.flower.group.rotation.x, (0.42 + state.pitch) * (1 - 0.86 * hh), 0.12, dt
    );
    /* 化形成心时收一收泛光、点径与亮度：心形是"面"，
       光晕一大、点一大就糊成团粉云，边和瓣都看不出来。
       形变中途粒子被往里收，密度会临时暴涨，再给一个"中途压暗"，
       否则整段转化就是一团白光闪过去。 */
    const dip = 1 - 0.55 * Math.sin(Math.PI * hh);
    /* 爱心是"实心"的：整个心体都在中轴附近（radial 0.1~0.6），
       如果还按花朵那套收尾压暗（glow -35%、size -24%、bloom -50%），
       心腹就会暗成一块脏粉色。这里收尾只是略微压低一点，保住体积感。 */
    this.flower.uniforms.uGlow.value = params.glowIntensity * (1 - 0.16 * hh) * dip;
    this.flower.uniforms.uSize.value = params.particleSize * (1 - 0.12 * hh);
    this.bloomPass.strength = params.bloomStrength * (1 - 0.30 * hh) * dip;
    this.composer.render();
  }
}

/* ==========================================================================
   §6  鼠标模式 MouseController
   --------------------------------------------------------------------------
   规格：
     · 鼠标横向 X（0~1）→ targetTension（左边缘闭合、右边缘绽放）
     · 鼠标纵向 Y → 花朵轻微俯仰 -0.3~0.3 弧度
     · 滚轮 → 相机距离 / 花朵缩放 0.5~2.0
     · 左键拖拽旋转视角，右键拖拽平移，双击重置视角
     · 鼠标位置画一个跟随光点（CSS 元素，不进 WebGL）
   ========================================================================== */
class MouseController {
  constructor(canvas, stage) {
    this.canvas = canvas;
    this.stage = stage;
    this.active = false;
    this.tension = 0.5;
    this.pitch = 0;
    this.dragging = null;      // 'orbit' | 'pan'
    this.lastX = 0;
    this.lastY = 0;
    this.dot = null;
    this.lastCursorX = window.innerWidth * 0.5;   // 鼠标屏幕坐标（给着色器的指尖点用）
    this.lastCursorY = window.innerHeight * 0.55;
    this.hasCursor = false;

    this._bind();
  }

  enable(on) {
    this.active = on;
    this.canvas.style.cursor = on ? 'crosshair' : 'default';
    if (this.dot) this.dot.style.opacity = on ? '1' : '0';
  }

  _bind() {
    const c = this.canvas;

    c.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      this.lastCursorX = e.clientX;
      this.lastCursorY = e.clientY;
      this.hasCursor = true;
      // ① 横向 → 张力
      this.tension = clamp(e.clientX / window.innerWidth, 0, 1);
      // ② 纵向 → 俯仰（-0.3~0.3 弧度）
      this.pitch = (0.5 - e.clientY / window.innerHeight) * 0.6;

      // 鼠标光点
      if (this.dot) {
        this.dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        this.dot.style.opacity = '1';
      }

      // ③ 拖拽
      if (this.dragging) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        if (this.dragging === 'orbit') {
          this.stage.cam.rotY += dx * 0.005;
          this.stage.cam.rotX += dy * 0.004;
        } else {
          this.stage.cam.panX -= dx * 0.004;
          this.stage.cam.panY += dy * 0.004;
        }
      }
    });

    c.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      this.dragging = e.button === 2 ? 'pan' : 'orbit';
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      e.preventDefault();
    });

    window.addEventListener('mouseup', () => { this.dragging = null; });

    c.addEventListener('contextmenu', (e) => {
      if (this.active) e.preventDefault();
    });

    // ④ 滚轮 → 缩放 0.5~2.0
    c.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      const next = this.stage.cam.zoom * (e.deltaY > 0 ? 0.92 : 1.08);
      this.stage.cam.zoom = clamp(next, 0.5, 2.0);
    }, { passive: false });

    // ⑤ 双击重置视角
    c.addEventListener('dblclick', () => {
      if (!this.active) return;
      this.stage.cam.rotY = 0;
      this.stage.cam.rotX = 0;
      this.stage.cam.panX = 0;
      this.stage.cam.panY = 0;
      this.stage.cam.zoom = 1;
    });
  }
}

/* ==========================================================================
   §7  界面 UI：参数面板 / HUD / 模式切换 / 快捷键 / 恢复初始状态
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'gesture-flower.params.v2';

class UI {
  constructor(app) {
    this.app = app;
    this.params = app.params;
    this.el = {
      panel: $('panel'),
      panelBody: $('panelBody'),
      btnPanel: $('btnPanel'),
      btnHand: $('btnHand'),
      btnMouse: $('btnMouse'),
      btnRetry: $('btnRetry'),
      btnReset: $('btnReset'),
      presetSeg: $('presetSeg'),
      camBadge: $('camBadge'),
      hudMode: $('hudMode'),
      hudTension: $('hudTension'),
      hudBloom: $('hudBloom'),
      hudHand: $('hudHand'),
      hudFps: $('hudFps'),
      barTension: $('barTension'),
      barBloom: $('barBloom'),
      toast: $('toast'),
      cursorDot: $('cursorDot'),
      hdUnavailable: $('hdUnavailable'),
    };
    this._buildPanel();
    this._buildPresets();
    this._bindEvents();
    this.syncModeButtons();
  }

  /** 用 PARAM_DEFS 生成滑块（含分组标题与映射说明） */
  _buildPanel() {
    const body = this.el.panelBody;
    let lastGroup = '';
    for (const def of PARAM_DEFS) {
      if (def.group !== lastGroup) {
        const h = document.createElement('div');
        h.className = 'group-title';
        h.textContent = def.group;
        body.appendChild(h);
        lastGroup = def.group;
      }

      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML = `
        <div class="prow-head"><span>${def.label}</span><output></output></div>
        <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" />
        <div class="prow-hint">${def.hint}</div>
      `;
      const input = row.querySelector('input');
      const out = row.querySelector('output');
      input.value = String(this.params[def.key]);
      out.textContent = def.fmt(this.params[def.key]);

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        this.params[def.key] = v;
        out.textContent = def.fmt(v);
        this.app.onParamChange(def.key, v);
      });

      def._input = input;
      def._out = out;
      body.appendChild(row);
    }

    // 面板底部：恢复初始状态
    const btn = document.createElement('button');
    btn.className = 'panel-reset';
    btn.textContent = '⟲ 恢复初始状态';
    btn.addEventListener('click', () => this.app.resetAll());
    body.appendChild(btn);
  }

  /** 参数变化 → 通知 App（实时生效 + 存 localStorage） */
  onParamChanged(key) {
    const def = PARAM_DEFS.find((d) => d.key === key);
    if (def?._input) {
      def._input.value = String(this.params[key]);
      def._out.textContent = def.fmt(this.params[key]);
    }
    this.saveParams();
  }

  saveParams() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        preset: this.currentPreset,     // 当前高亮的是哪个预设（null = 自定义）
        params: this.params,
      }));
    } catch { /* 隐私模式下可能不可用，忽略 */ }
  }

  loadParams() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      // 兼容旧格式（直接存 params）
      const p = obj && typeof obj.params === 'object' ? obj.params : obj;
      if (!p || typeof p !== 'object') return false;
      for (const def of PARAM_DEFS) {
        if (typeof p[def.key] === 'number' && Number.isFinite(p[def.key])) {
          this.params[def.key] = clamp(p[def.key], def.min, def.max);
        }
      }
      // 只有参数确实等于某个预设时，才高亮那个预设
      this.setPreset(this._matchPreset(), false);
      return true;
    } catch { return false; }
  }

  /** 当前参数正好等于哪个预设？都不是就返回 null（自定义） */
  _matchPreset() {
    for (const preset of PRESETS) {
      const target = presetParams(preset.key);
      const same = PARAM_DEFS.every((d) => Math.abs(this.params[d.key] - target[d.key]) < 1e-6);
      if (same) return preset.key;
    }
    return null;
  }

  /** 高亮某个预设按钮；key 为 null 表示切到"自定义" */
  setPreset(key, remember = true) {
    this.currentPreset = key;
    for (const btn of this.presetButtons || []) {
      btn.classList.toggle('active', btn.dataset.preset === key);
    }
    if (remember) this.saveParams();
  }

  clearParams() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }

  /** 生成「标准模式 / 梦幻模式」按钮（右上角 + 面板顶部各一份，状态同步） */
  _buildPresets() {
    const host = this.el.presetSeg;
    this.presetButtons = [];
    if (!host) return;
    for (const preset of PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'seg-btn preset-btn';
      btn.dataset.preset = preset.key;
      btn.textContent = preset.label;
      btn.title = preset.desc;
      btn.addEventListener('click', () => this.app.applyPreset(preset.key));
      host.appendChild(btn);
      this.presetButtons.push(btn);
    }
    this.setPreset(this.app.presetKey || DEFAULT_PRESET, false);
  }

  /** 把所有滑块刷成 params 的当前值 */
  refreshAll() {
    for (const def of PARAM_DEFS) {
      if (!def._input) continue;
      def._input.value = String(this.params[def.key]);
      def._out.textContent = def.fmt(this.params[def.key]);
    }
  }

  _bindEvents() {
    this.el.btnPanel.addEventListener('click', () => this.togglePanel());
    this.el.btnHand.addEventListener('click', () => this.app.setMode('hand'));
    this.el.btnMouse.addEventListener('click', () => this.app.setMode('mouse'));
    this.el.btnRetry.addEventListener('click', () => this.app.retryCamera());
    this.el.btnReset.addEventListener('click', () => this.app.resetAll());

    // 鼠标光点
    const dot = document.createElement('div');
    dot.id = 'cursorDot';
    dot.className = 'cursor-dot';
    document.body.appendChild(dot);
    this.el.cursorDot = dot;

    // 快捷键：M 切换模式 / H 面板 / R 恢复初始状态
    window.addEventListener('keydown', (e) => {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) {
        if (e.key !== 'Escape') return;
      }
      const k = e.key.toLowerCase();
      if (k === 'm') this.app.setMode(this.app.mode === 'hand' ? 'mouse' : 'hand');
      else if (k === 'h') this.togglePanel();
      else if (k === 'r') this.app.resetAll();
      else if (k === 'l') this.app.playLove();
      else if (k === 'v') this.app.toggleHeart();
      else if (k === 'escape') this.togglePanel(false);
    });
  }

  togglePanel(open) {
    const isOpen = open ?? !this.el.panel.classList.contains('open');
    this.el.panel.classList.toggle('open', isOpen);
    this.el.panelBody.style.display = isOpen ? '' : 'none';
  }

  syncModeButtons() {
    const hand = this.app.mode === 'hand';
    this.el.btnHand.classList.toggle('active', hand);
    this.el.btnMouse.classList.toggle('active', !hand);
    this.el.hudMode.textContent = hand ? '手势模式' : '鼠标模式';
  }

  setCameraBadge(text, warn = false) {
    this.el.camBadge.textContent = text;
    this.el.camBadge.classList.toggle('warn', warn);
    if (this.el.hdUnavailable) this.el.hdUnavailable.hidden = !warn;
  }

  /** 鼠标悬停徽标就能看到完整报错原因 */
  setCameraBadgeDetail(text) {
    if (this.el.camBadge) this.el.camBadge.title = text || '';
  }

  /** 左下角常驻一行"摄像头不可用：<真实原因>"，别再让用户猜 */
  showCameraHint(text) {
    if (!this.el.hdUnavailable) return;
    this.el.hdUnavailable.hidden = false;
    this.el.hdUnavailable.textContent = '摄像头不可用：' + text;
  }

  toast(msg, ms = 3600) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  /** 每帧刷新 HUD（只写变化过的文本，避免布局抖动） */
  updateHud({ tension, bloom, heart = 0, hasHand, fps, mode }) {
    const tp = (tension * 100).toFixed(0);
    this.el.hudTension.textContent = tension.toFixed(3);
    this.el.barTension.style.width = tp + '%';
    this.el.hudBloom.textContent = bloom.toFixed(3);
    this.el.barBloom.style.width = (bloom * 100).toFixed(0) + '%';
    const heartOn = heart > 0.5;
    this.el.hudHand.textContent = mode === 'mouse'
      ? '鼠标接管'
      : (heartOn ? '爱心 ❤' : (hasHand ? '已识别' : '未识别'));
    this.el.hudFps.textContent = fps.toFixed(0) + ' FPS';
  }
}

/* ==========================================================================
   §8  主程序 App
   ========================================================================== */

class App {
  constructor() {
    this.params = params;
    this.presetKey = DEFAULT_PRESET;   // 打开页面 = 标准模式
    this.mode = 'hand';
    this.running = false;
    this.lastTime = performance.now();
    this.fps = 60;
    this.spread = 0.5;          // 当前绽放度（缓动后）
    this.threeHold = 0;         // 三指手势按住时长
    this.loveCooldown = 0;      // 彩蛋冷却
    this.heart = 0;             // 爱心形变度（0=花朵，1=爱心）
    this.heartTarget = 0;
    this.heartHold = 0;         // 保持两指的时长
    this.heartFree = 0;         // 松开两指的时长
    this.manualHeart = false;   // 鼠标模式手动点亮的爱心（按钮 / 键盘 V）
    this._lastCamError = '';    // 上一次摄像头失败的真实原因（回退提示要用）
    this._camStarting = false;
    this.targetTension = 0.5;

    this.tension = new TensionMeter();

    this.stage = new Stage($('gl'), $('video'), $('camPreview'));
    this.stage.flower.setCount(params.particleCount);

    this.mouse = new MouseController($('gl'), this.stage);
    this.mouse.dot = null;

    this.handTracker = new HandTracker({
      video: $('video'),
      overlay: $('overlay'),
      onResults: (lm, info) => {
        this.landmarks = lm;
        this.worldLandmarks = info?.worldLandmarks || null;
        this.handsInfo = info || {};
      },
      onError: (msg) => this.ui.toast(msg),
      onStatus: (s) => { if (s) this.ui.toast(s, 2200); },
    });

    this.ui = new UI(this);
    this.mouse.dot = this.ui.el.cursorDot;

    // 读取上次保存的参数（规格：参数自动保存到 localStorage）
    const restored = this.ui.loadParams();
    this.ui.refreshAll();
    this.stage.applyParams();
    if (restored) this.ui.toast('已载入上次的参数（按 R 可恢复初始状态）', 2600);

    this.landmarks = null;
    this.worldLandmarks = null;
    this.handsInfo = {};

    this._bindVisibility();
    this._maybeStartCamera();
  }

  /* ---------------- 输入模式 ---------------- */

  setMode(mode) {
    const next = mode === 'mouse' ? 'mouse' : 'hand';
    if (next === this.mode && this._modeReady) return;
    this._modeReady = true;

    if (next === 'hand' && !this.handTracker.running) {
      // 手势模式但摄像头还没起来：先切过去试一次，失败自动回退
      this._startCamera().then((ok) => {
        if (!ok) this._fallbackToMouse('摄像头不可用，已切到鼠标模式');
      });
      return;
    }

    this.mode = next;
    const isMouse = next === 'mouse';
    this.mouse.enable(isMouse);
    this.stage.setVideoVisible(!isMouse);
    this.ui.syncModeButtons();
    this.ui.toast(isMouse ? '鼠标模式：左右移动控制绽放，滚轮缩放，拖拽旋转' : '手势模式：举起手，张开/握拳');
  }

  _fallbackToMouse(msg) {
    this.mode = 'mouse';
    this.mouse.enable(true);
    this.stage.setVideoVisible(false);
    this.ui.syncModeButtons();
    this.ui.setCameraBadge('摄像头不可用', true);
    this.ui.toast(msg, 4200);
  }

  /* ---------------- 摄像头 ---------------- */

  async _startCamera() {
    if (this._camStarting) return false;      // 连点「手势模式」不重复请求设备
    this._camStarting = true;
    try {
      this.ui.setCameraBadge('正在连接摄像头…', false);
      await this.handTracker.start();
      this.ui.setCameraBadge('摄像头就绪', false);
      this.mode = 'hand';
      this.mouse.enable(false);
      this.stage.setVideoVisible(true);
      this.ui.syncModeButtons();
      return true;
    } catch (err) {
      console.warn('[camera]', err);
      this._lastCamError = String(err.message || err);
      this.ui.setCameraBadge('摄像头不可用', true);
      this.ui.setCameraBadgeDetail(this._lastCamError);
      this.ui.showCameraHint(this._lastCamError);
      return false;
    } finally {
      this._camStarting = false;
    }
  }

  async _maybeStartCamera() {
    const ok = await this._startCamera();
    if (!ok) {
      /* 回退提示必须带上真实原因，否则用户只看到"摄像头不可用"，
         会以为是不支持/没权限，实际往往是被别的程序占了设备。 */
      this._fallbackToMouse(this._lastCamError
        ? `摄像头不可用，已进入鼠标模式。原因：${this._lastCamError}`
        : '未拿到摄像头权限，已进入鼠标模式（按 M 可重试手势模式）');
    }
  }

  retryCamera() {
    this.ui.toast('正在重试摄像头…', 1800);
    this._maybeStartCamera();
  }

  /**
   * 数一数伸出几根手指（只数食指/中指/无名指/小指）
   * 判据和 TensionMeter 的 openness 一致：指尖离手腕比 PIP 关节远 18% 以上
   */
  _countExtendedFingers(lm) {
    if (!lm || lm.length < 21) return 0;
    const wrist = lm[0];
    const dip = (i) => Math.hypot(lm[i].x - wrist.x, lm[i].y - wrist.y);
    let n = 0;
    for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
      if (dip(tip) > dip(pip) * 1.18) n++;
    }
    return n;
  }

  /**
   * 两根手指（V / 剪刀手）：食指、中指伸直，无名指、小指蜷起
   * 判据与 _countExtendedFingers 一致：指尖离手腕比 PIP 关节远 18% 以上
   */
  _isTwoFingerV(lm) {
    if (!lm || lm.length < 21) return false;
    const wrist = lm[0];
    const dip = (i) => Math.hypot(lm[i].x - wrist.x, lm[i].y - wrist.y);
    const ext = (tip, pip) => dip(tip) > dip(pip) * 1.18;
    return ext(8, 6) && ext(12, 10) && !ext(16, 14) && !ext(20, 18);
  }

  /** 播放彩蛋：粒子消失 → 写出 Love */
  playLove() {
    if (this.stage.love.playing) return;
    this.stage.love.play();
    this.loveCooldown = 7;        // 冷却 7 秒
    this.threeHold = 0;
    this.ui.toast('三根手指 ✨ 花瓣散落，聚成一句话…', 2600);
  }

  /** 手动爱心：鼠标模式点按钮 / 按 V 键，再按一次收回。
      摄像头不可用时这就是唯一入口，所以不依赖任何手势状态。 */
  toggleHeart(force) {
    this.manualHeart = force ?? !this.manualHeart;
    this.heartHold = 0;
    this.heartFree = 0;
    if (this.manualHeart) {
      this.ui.toast('爱心模式 ❤ 9 万颗粒子正在聚成一颗心…（再按 [V] 收回）', 2600);
    } else {
      this.ui.toast('粒子散开，花朵回来了', 1800);
    }
  }

  /* ---------------- 参数 / 重置 ---------------- */

  onParamChange(key, value) {
    this.stage.applyParams();
    // 手动拖过滑块就不再等于任何预设 → 按钮高亮取消（变成自定义）
    const matched = this.ui._matchPreset();
    this.presetKey = matched;
    this.ui.setPreset(matched);
    this.ui.onParamChanged(key);
  }

  /**
   * 套用一个视觉预设（标准 / 梦幻）
   * 只改参数，不重建场景、不重建几何体 —— 滑块只改 drawRange 与 uniform。
   */
  applyPreset(key) {
    const preset = PRESETS.find((p) => p.key === key) || PRESETS[0];
    const next = presetParams(preset.key);
    Object.assign(this.params, next);

    this.presetKey = preset.key;
    this.stage.applyParams();
    this.ui.refreshAll();
    this.ui.setPreset(preset.key);
    this.ui.toast(`已切换到「${preset.label}」— ${preset.desc}`, 2400);
  }

  /** 「恢复初始状态」：参数、相机、张力、模式全复位（不重建场景） */
  resetAll() {
    // ① 参数 → 标准模式
    Object.assign(params, DEFAULT_STATE.params);
    this.presetKey = DEFAULT_PRESET;
    this.stage.applyParams();
    this.ui.refreshAll();
    this.ui.setPreset(DEFAULT_PRESET, false);
    this.ui.clearParams();

    // ② 相机（平滑回到默认）
    const c = this.stage.cam;
    c.rotY = 0; c.rotX = 0; c.panX = 0; c.panY = 0; c.zoom = 1;
    c.x = DEFAULT_STATE.camera.x;
    c.y = DEFAULT_STATE.camera.y;
    c.z = DEFAULT_STATE.camera.z;
    c.targetY = DEFAULT_STATE.camera.targetY;

    // ③ 绽放状态平滑回到 0.5
    this.mouse.tension = DEFAULT_STATE.tension;
    this.mouse.pitch = 0;
    this.targetTension = DEFAULT_STATE.tension;

    // ③.5 化形状态清空（若当时正比着两根手指，或手动点亮过爱心）
    this.manualHeart = false;
    this.heart = 0;
    this.heartTarget = 0;
    this.heartHold = 0;
    this.heartFree = 0;
    this.threeHold = 0;

    // ④ 交互模式
    if (this.handTracker.running) this.setMode('hand');
    else this._fallbackToMouse('已恢复初始状态（摄像头不可用，保持鼠标模式）');

    this.ui.toast('已恢复初始状态');
  }

  /* ---------------- 主循环 ---------------- */

  _bindVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.running = false;
      } else if (!this.running) {
        this.running = true;
        this.lastTime = performance.now();
        requestAnimationFrame(this._frame);
      }
    });
  }

  /** 屏幕归一化坐标（0~1，已镜像）→ 花朵平面（z = CONFIG.followZ）上的世界坐标 */
  _screenToPlane(nx, ny) {
    const cam = this.stage.camera;
    const dir = new THREE.Vector3(nx * 2 - 1, 1 - ny * 2, 0.5)
      .unproject(cam).sub(cam.position).normalize();
    const dz = Math.abs(dir.z) < 1e-4 ? 1e-4 : dir.z;
    const t = (CONFIG.followZ - cam.position.z) / dz;
    return cam.position.clone().addScaledVector(dir, t);
  }

  /** 手掌尺度：腕(0) → 中指根(9) 的画面归一化距离，用来决定花朵的相对大小 */
  _palmSpan(lm) {
    const a = lm[0], b = lm[9];
    return Math.hypot(b.x - a.x, b.y - a.y) || CONFIG.palmSpanRef;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this._frame);
  }

  _frame = (now) => {
    if (!this.running) return;
    requestAnimationFrame(this._frame);

    // dt 截断（切标签页）且不允许为负（rAF 首帧时间戳可能早于上次采样）
    const dt = Math.max(0, Math.min((now - this.lastTime) / 1000, 0.05));
    this.lastTime = now;
    this.fps = damp(this.fps, 1 / Math.max(dt, 1e-4), 0.1, dt);

    const isHand = this.mode === 'hand' && this.handTracker.running;

    /* ---------- ① 输入 → targetTension ---------- */
    let pointerActive = false;
    if (isHand) {
      this.tension.update(this.landmarks, dt, this.worldLandmarks);
      this.targetTension = this.tension.value;
      pointerActive = this.handTracker.pointerActive && !this.useMouseOverride;
    } else {
      // 鼠标模式：横向位置直接当张力
      this.targetTension = this.mouse.tension;
      this.tension.value = this.mouse.tension;
      this.tension.bloom = tensionToBloom(this.mouse.tension);
      this.tension.state = this.tension.bloom < 0.02 ? STATE.BUD
        : this.tension.bloom > 0.98 ? STATE.BLOOM : STATE.MID;
    }

    /* ---------- ② 缓动（规格：currentSpread += (target - current) * 0.1） ---------- */
    const targetBloom = tensionToBloom(this.targetTension);
    this.spread += (targetBloom - this.spread) * CONFIG.spreadEase;
    this.spread = clamp(this.spread, 0, 1);

    /* ---------- ②.5 彩蛋：三根手指 → Love ----------
       要「稳定举起三指」才算数（this.threeHold 累计 0.15s），
       触发后进冷却，避免手一直在那儿抖就反复播放。 */
    if (this.loveCooldown > 0) this.loveCooldown -= dt;
    if (isHand && this.landmarks && !this.stage.love.playing) {
      const n = this._countExtendedFingers(this.landmarks);
      if (n === 3) {
        this.threeHold += dt;
        if (this.threeHold > 0.15 && this.loveCooldown <= 0) {
          this.playLove();
        }
      } else {
        this.threeHold = 0;
      }
    } else {
      this.threeHold = 0;
    }

    /* ---------- ②.8 花朵跟着手掌走 ----------
       把掌心的屏幕坐标反投影到花朵所在的平面，整朵花就这样悬在掌心、
       跟着手一起动；手掌靠近摄像头（画面里更大）时花也略大一点。 */
    const group = this.stage.flower.group;
    let fx = 0, fy = 0, fs = 1;
    if (isHand && this.handTracker.pointerActive && this.landmarks) {
      const palm = this.handTracker.pointer;                 // 已镜像的归一化坐标
      const hit = this._screenToPlane(palm.x, palm.y);
      const span = this._palmSpan(this.landmarks);
      fx = clamp(hit.x, -3.2, 3.2) * CONFIG.handFollow;
      fy = clamp(hit.y, -2.2, 2.2) * CONFIG.handFollow + CONFIG.handLift;
      fs = 1 + clamp(span / CONFIG.palmSpanRef - 1, -0.28, 0.35) * CONFIG.handScale;
    }
    const ease = CONFIG.handFollowEase;
    group.position.x = damp(group.position.x, fx, ease, dt);
    group.position.y = damp(group.position.y, fy, ease, dt);
    group.scale.setScalar(damp(group.scale.x, fs, ease, dt));

    /* ---------- ②.6 两指 V → 粒子聚成爱心 ----------
       要「稳定比出 V」才算数（this.heartHold 累计 0.22s），也是要松开一会儿
       才还原（this.heartFree），否则手指微抖就会在花和心之间来回跳。 */
    if (this.manualHeart) {
      // 手动爱心（右上角按钮 / 键盘 V）：绕过手势判据，直接钉住目标，
      // 摄像头不可用时也能一键看爱心
      this.heartTarget = 1;
      this.heartHold = 0;
      this.heartFree = 0;
    } else if (isHand && this.landmarks && !this.stage.love.playing) {
      if (this._isTwoFingerV(this.landmarks)) {
        this.heartHold += dt;
        this.heartFree = 0;
        if (this.heartHold >= CONFIG.heartHold && this.heartTarget !== 1) {
          this.heartTarget = 1;
          this.ui.toast('两根手指 ❤ 花瓣正在聚成一颗心…', 2200);
        }
      } else {
        this.heartFree += dt;
        this.heartHold = 0;
        if (this.heartFree >= CONFIG.heartRelease) this.heartTarget = 0;
      }
    } else {
      this.heartFree += dt;
      if (this.heartFree >= CONFIG.heartRelease) {
        this.heartTarget = 0;
        this.heartHold = 0;
      }
    }
    this.heart = damp(this.heart, this.heartTarget, CONFIG.heartEase, dt);

    /* ---------- ③ 指尖 / 鼠标的世界坐标 ----------
       排斥与点亮用食指指尖（8 号点）：花已经跟着掌心走了，
       若还用掌心做排斥点，就是往花心正中挖一个洞。 */
    const ptr = this.stage.flower.uniforms.uPointer.value;
    if (pointerActive && this.landmarks) {
      const tip = this.landmarks[8];
      const hit = this._screenToPlane(1 - tip.x, tip.y);      // 镜像回用户视角
      ptr.set(hit.x - group.position.x, hit.y - group.position.y, 0.55);
    } else if (this.mode === 'mouse') {
      // 鼠标：用屏幕坐标反推一个 3D 点（花盘平面上）
      ptr.set(
        (this.mouse.lastCursorX / window.innerWidth - 0.5) * 5.2,
        (0.5 - this.mouse.lastCursorY / window.innerHeight) * 3.4 + 0.5,
        1.2
      );
    }

    /* ---------- ④ 渲染 ---------- */
    this.stage.render(dt, {
      bloom: this.spread,
      heart: this.heart,
      pointer: ptr,
      pointerActive: this.mode === 'mouse' ? this.mouse.hasCursor : pointerActive,
      pitch: this.mode === 'mouse' ? this.mouse.pitch : (this.handTracker.pointer.y - 0.5) * 0.4,
    });

    /* ---------- ⑤ HUD ---------- */
    this.ui.updateHud({
      tension: isHand ? this.tension.value : this.mouse.tension,
      bloom: this.spread,
      heart: this.heart,
      hasHand: this.tension.hasHand,
      fps: this.fps,
      mode: this.mode,
    });
  };
}

/* ==========================================================================
   启动
   ========================================================================== */

function boot() {
  let app;
  try {
    app = new App();
  } catch (err) {
    console.error(err);
    const t = document.getElementById('toast');
    if (t) {
      t.textContent = '初始化失败：' + (err?.message || err) +
        '（浏览器可能不支持 WebGL，请更新浏览器或开启硬件加速）';
      t.classList.add('show');
    }
    return;
  }
  window.__flowerApp = app;
  app.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
