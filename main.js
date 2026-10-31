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
   §0  配置与默认参数
   ========================================================================== */

/** 粒子池上限：滑块只改 drawRange，不重建几何体（规格要求） */
const MAX_PARTICLES = 50000;

/**
 * 实时参数（面板可调，自动存 localStorage）
 * 每一项都会被映射到一个具体的渲染量，label 下方写着映射关系。
 */
const PARAM_DEFS = [
  {
    key: 'particleCount', label: '粒子数量', min: 1000, max: 50000, step: 1000,
    def: 50000, fmt: (v) => v.toLocaleString('en-US'),
    hint: '50000 粒子池固定分配，滑块只改 setDrawRange',
    group: '粒子',
  },
  {
    key: 'particleSize', label: '粒子大小', min: 0.5, max: 6, step: 0.1,
    def: 2.0, fmt: (v) => v.toFixed(1),
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
    def: 1.2, fmt: (v) => v.toFixed(2),
    hint: 'uniform uGlow → 乘以粒子颜色',
    group: '视觉',
  },
  {
    key: 'bloomStrength', label: '泛光强度', min: 0, max: 2.5, step: 0.01,
    def: 0.8, fmt: (v) => v.toFixed(2),
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
    def: 0.18, fmt: (v) => v.toFixed(2),
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
    desc: '粒子拉满 · 光晕收到最小',
    overrides: { bloomRadius: 0 },
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
  camera: { x: 0, y: 1.15, z: 5.4, targetY: 0.18, rotY: 0, rotX: 0 },
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
  centerRatio: 0.07,       // 花心金粉占比
  moteRatio: 0.06,         // 飘散尘埃占比
  bloomScale: 1.0,         // 花朵整体尺寸
  spinTurns: 0.55,         // 绽放时花瓣旋转圈数（打开时"拧"一下）

  /* ---------- 摄像头 ---------- */
  camWidth: 640,
  camHeight: 480,
  maxHands: 1,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6,

  /* ---------- 其他 ---------- */
  maxPixelRatio: 2,
  videoOpacity: 0.22,
  autoRotate: 0.06,        // 花朵自转（弧度/秒）
  pointerRepel: 0.55,      // 指尖/鼠标附近的排斥强度
  showSkeleton: true,      // 是否绘制 21 点骨架
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

  update(lm, dt) {
    const { smoothing, gain, openGain, lowTension, highTension, lostTimeout } = CONFIG;

    if (lm && lm.length >= 21) {
      this.hasHand = true;
      const wrist = lm[0];
      const dip = (i) => Math.hypot(lm[i].x - wrist.x, lm[i].y - wrist.y, (lm[i].z - wrist.z) * 0.5);

      const palmScale = Math.max(dip(9), 1e-4);
      const tips = [4, 8, 12, 16, 20];
      const tipMean = tips.reduce((s, i) => s + dip(i), 0) / tips.length;
      const relative = tipMean / palmScale - 1;

      this.raw = clamp(clamp(relative * openGain, 0, 1) * gain, 0, 1);

      // 辅助指标：四指伸直程度
      this.openness = [8, 12, 16, 20].reduce((s, tipIdx, k) => {
        const pipIdx = [6, 10, 14, 18][k];
        const dTip = Math.hypot(lm[tipIdx].x - wrist.x, lm[tipIdx].y - wrist.y);
        const dPip = Math.hypot(lm[pipIdx].x - wrist.x, lm[pipIdx].y - wrist.y);
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
   · 使用 MediaPipe Hands（CDN UMD，window.Hands）
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

    this.hands = null;
    this.stream = null;
    this.running = false;

    /** 双手数据：每只手的 { landmarks, handedness, label, pointer }
     *  左手在前、右手在后（按 MediaPipe 的 label 排序，保证索引稳定） */
    this.handsData = [];
    /** 兼容旧接口：主手（右手优先）的 21 点，没有手时为 null */
    this.lastLandmarks = null;
    this.lastHandedness = null;

    /** 平滑后的手指位置（用于画面“跟手”），存归一化坐标 */
    this.pointer = new THREE.Vector2(0.5, 0.5);
    this.pointerTarget = new THREE.Vector2(0.5, 0.5);
    this.pointerActive = false;

    /** 双手是否同时出现 */
    this.twoHandActive = false;
  }

  /** 检查 MediaPipe 脚本是否加载成功 */
  static isAvailable() {
    return typeof window !== 'undefined' && typeof window.Hands === 'function';
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
    if (!HandTracker.isAvailable()) {
      throw new Error(
        'MediaPipe Hands 脚本未能加载（window.Hands 未定义）。' +
        '请检查网络是否能访问 cdn.jsdelivr.net，或改用 npm 本地安装后重试。'
      );
    }

    // ---- ② 打开摄像头 ----
    this.onStatus('正在请求摄像头权限…');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: CONFIG.camWidth },
          height: { ideal: CONFIG.camHeight },
        },
      });
    } catch (err) {
      throw new Error(this._describeCameraError(err));
    }

    this.video.srcObject = this.stream;
    // iOS Safari 需要这个属性才允许内联播放
    this.video.setAttribute('playsinline', 'true');
    await this.video.play().catch(() => {
      /* 某些浏览器 play() 会被拒绝，交给下方 videoWidth 检测兜底 */
    });

    // ---- ③ 初始化 MediaPipe Hands ----
    this.onStatus('正在初始化手部识别模型…');
    this.hands = new window.Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
    });

    this.hands.setOptions({
      /* 始终识别 2 只手：单手模式下多识别的那只不会参与运算（见 App._frame），
         但保留它有两个好处：
           1. 用户可以随时切到双手模式而无需重启识别
           2. 单手模式下也能在画面里看到第二只手，提示"切双手就能用上它"
         代价是识别开销略高；若在低端机上有性能问题，
         可以把 maxHands 设成 1（那样双手模式就不可用了）。 */
      maxNumHands: CONFIG.maxHands,
      modelComplexity: 1,             // 0=最快 / 1=平衡；移动端可考虑 0
      selfieMode: false,              // 我们自己处理镜像，避免坐标二次翻转
      minDetectionConfidence: CONFIG.minDetectionConfidence,
      minTrackingConfidence: CONFIG.minTrackingConfidence,
    });

    this.hands.onResults((results) => this._handleResults(results));

    // ---- ④ 启动识别循环 ----
    this.running = true;
    this.onStatus('手势识别运行中');
    this._loop();
  }

  /** 内部识别循环：send 是异步的，必须 await 后再排下一帧，否则会堆积 */
  async _loop() {
    while (this.running) {
      if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
        try {
          await this.hands.send({ image: this.video });
        } catch (err) {
          // 单帧失败不致命，记录后继续
          console.warn('[HandTracker] send 失败：', err);
        }
      } else {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      // MediaPipe 会自己占用一帧时间；这里补一个微延时让出主线程
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  _handleResults(results) {
    const all = results?.multiHandLandmarks || [];
    const handedness = results?.multiHandedness || [];

    /* ---------- 整理成双手数据 ----------
       MediaPipe 的 multiHandLandmarks 顺序会随手出现顺序变化，
       如果直接用下标 0/1，两只手会"串位"，导致左右手控制互换。
       这里按 handedness 的 label 排序（Left 在前、Right 在后），
       索引就稳定了；同时用 score 最高的那只作为"主手"。

       注意：selfieMode=false 时，MediaPipe 报的 Left/Right 是
       摄像头视角的标签（和镜子里的左右相反），这里统一换算成
       "用户视角"的左右，方便使用者理解左手/右手的提示。 */
    this.handsData = all.map((lm, i) => {
      const h = handedness[i] || {};
      // 摄像头视角 → 用户视角：标签互换
      const cameraLabel = h.label || h.classification?.[0]?.label || '';
      const userLabel = cameraLabel === 'Left' ? 'Right'
                      : cameraLabel === 'Right' ? 'Left' : '';
      // 掌心锚点（0/5/9/13/17 的均值）比单点稳
      const ids = [0, 5, 9, 13, 17];
      let cx = 0, cy = 0;
      for (const k of ids) { cx += lm[k].x; cy += lm[k].y; }
      cx /= ids.length; cy /= ids.length;
      return {
        landmarks: lm,
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
    this.pointerActive = false;
    this._drawOverlay([]);
    this.onResults(null, { hands: [], twoHand: false });
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

    /* ---------- ① 花苞 ↔ 绽放 ---------- */
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
    /* 花苞期只让一部分粒子可见（18% → 100%），否则 4 万颗挤在很小的体积里，
       加法混合必然烧成一根白棒。这也让花朵"随张开逐渐浮现"，观感更好。 */
    float keep = 0.18 + 0.82 * b;
    float vis = step(seed, keep);
    gl_PointSize = clamp(uSize * sizeK * uPixelRatio * persp, 1.0, 48.0) * vis;
    if (depth < 0.6) gl_PointSize = 0.0;

    /* ---------- ⑤ 颜色 ---------- */
    /* 花苞期整体偏玫红、偏暗；绽放后回到花瓣本色 */
    vec3 budCol = mix(aColor, vec3(0.62, 0.13, 0.30), 0.45) * 0.92;
    vec3 col = mix(budCol, aColor, b);

    /* 亮度：花心金粉最亮，花瓣次之
       轴心附近粒子密度极高（所有花瓣都收在 r≈0），不压一压会烧成一个白球，
       颜色就全丢了。这里按离轴距离给一点衰减。 */
    float centerBoost = role > 0.5 && role < 1.5 ? 1.15 : 1.0;
    float radial = length(pos.xz);
    float coreAtten = mix(0.38, 1.0, smoothstep(0.02, 0.85, radial));
    float glow = uGlow * centerBoost * coreAtten * (0.72 + 0.55 * seed);

    /* 指尖附近更亮 */
    if (uPointerActive > 0.5) glow += exp(-distP * distP * 1.6) * 0.9;

    /* 花苞期 4 万颗粒子挤在很小的体积里，加法混合会直接烧成一个白棒 ——
       压到 22% 亮度才刚刚好：能看出玫红的苞，又不至于刺眼。 */
    glow *= mix(0.22, 1.0, b);

    vColor = col;
    vAlpha = mix(0.34, 1.0, b);
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
    this.group.rotation.x = 0.42;   // 花冠前倾，能同时看到花瓣层次与花心
    this.build();
  }

  /** 建 5 万粒子池（只建一次，之后只改 drawRange） */
  build() {
    const N = MAX_PARTICLES;
    const posBloom = new Float32Array(N * 3);
    const posBud = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const info = new Float32Array(N * 4);

    const centerCount = Math.floor(N * CONFIG.centerRatio);
    const moteCount = Math.floor(N * CONFIG.moteRatio);
    const petalCount = N - centerCount - moteCount;

    const C_CORE = new THREE.Color().setHSL(0.090, 1.00, 0.56);   // 花心金
    const C_INNER = new THREE.Color().setHSL(0.952, 0.92, 0.60);  // 内层暖粉
    const C_MID = new THREE.Color().setHSL(0.940, 0.90, 0.62);    // 瓣面
    const C_EDGE = new THREE.Color().setHSL(0.930, 0.95, 0.70);   // 瓣缘亮粉
    const C_MOTE = new THREE.Color().setHSL(0.13, 0.55, 0.82);    // 尘埃暖白

    const k = CONFIG.petalCount;
    const sharp = CONFIG.petalSharp;
    const tmp = new THREE.Color();

    /** 玫瑰曲线：|cos(kθ/2)|^sharp */
    const petalR = (theta) => Math.pow(Math.abs(Math.cos((k * theta) / 2)), sharp);

    for (let i = 0; i < N; i++) {
      const o = i * 3;
      const layer = i % 4 === 0 ? 1 : 0;     // 1 = 内层（旋转 30°、更小更高）
      let seed = Math.random();

      if (i < petalCount) {
        /* ---------- 花瓣粒子 ---------- */
        const theta = Math.random() * Math.PI * 2;
        const u = Math.sqrt(Math.random());            // 面积均匀
        const rMax = petalR(theta);

        const layerScale = layer ? 0.62 : 1.0;
        const layerLift = layer ? 0.16 : 0.0;
        const layerRot = layer ? Math.PI / CONFIG.petalCount : 0;

        // 抖一下 θ，让瓣缘不是硬边
        const th = theta + layerRot + (Math.random() - 0.5) * 0.05;
        const r = Math.pow(u, 1.0) * rMax * 1.55 * layerScale * CONFIG.bloomScale;

        const x = Math.cos(th) * r;
        const z = Math.sin(th) * r;
        // 花瓣微微上卷：越靠瓣缘翘得越高
        const y = layerLift + (1 - u) * 0.10 + Math.pow(u, 3) * 0.34 * (layer ? 0.9 : 1.0)
                  + (Math.random() - 0.5) * 0.03;

        posBloom[o] = x;
        posBloom[o + 1] = y;
        posBloom[o + 2] = z;

        // 花苞：同样角度、缩小收拢成一个尖苞
        const budR = 0.16 + Math.random() * 0.12;
        const budH = Math.pow(Math.random(), 0.6) * 0.92;
        const budT = th;
        posBud[o] = Math.cos(budT) * budR * (1 - budH * 0.55);
        posBud[o + 1] = budH * 0.85 + 0.05;
        posBud[o + 2] = Math.sin(budT) * budR * (1 - budH * 0.55);

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

      } else if (i < petalCount + centerCount) {
        /* ---------- 花心金粉：密集的小球，撑出那个亮核 ---------- */
        const a = Math.random() * Math.PI * 2;
        const rr = Math.pow(Math.random(), 0.55) * 0.30;
        const y = 0.12 + Math.pow(Math.random(), 0.8) * 0.30;

        posBloom[o] = Math.cos(a) * rr;
        posBloom[o + 1] = y;
        posBloom[o + 2] = Math.sin(a) * rr;

        posBud[o] = Math.cos(a) * rr * 0.35;
        posBud[o + 1] = 0.55 + y * 0.3;
        posBud[o + 2] = Math.sin(a) * rr * 0.35;

        tmp.copy(C_CORE).offsetHSL((Math.random() - 0.5) * 0.05, 0, (Math.random() - 0.5) * 0.08);
        colors[o] = tmp.r; colors[o + 1] = tmp.g; colors[o + 2] = tmp.b;
        info[i * 4] = seed;
        info[i * 4 + 1] = 0.18 + Math.random() * 0.30;
        info[i * 4 + 2] = 1;                              // 角色：花心
        info[i * 4 + 3] = 1;
      } else {
        /* ---------- 飘散尘埃：花周围的一层薄雾 ---------- */
        const a = Math.random() * Math.PI * 2;
        const rr = 1.5 + Math.random() * 1.8;
        const y = (Math.random() - 0.45) * 1.8;

        posBloom[o] = Math.cos(a) * rr;
        posBloom[o + 1] = y;
        posBloom[o + 2] = Math.sin(a) * rr;

        posBud[o] = Math.cos(a) * rr * 0.3;
        posBud[o + 1] = 0.1 + Math.random() * 0.8;
        posBud[o + 2] = Math.sin(a) * rr * 0.3;

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
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    // 只画前 particleCount 颗（滑块只改这个数字）
    geo.setDrawRange(0, Math.min(params.particleCount, N));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 12);

    this.uniforms = {
      uBloom: { value: 0.5 },
      uTime: { value: 0 },
      uSize: { value: params.particleSize },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio) },
      uGlow: { value: params.glowIntensity },
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
    const geo = this.points.geometry;
    geo.setDrawRange(0, Math.max(1, Math.min(n, MAX_PARTICLES)));
  }

  update(state, dt) {
    const u = this.uniforms;
    u.uBloom.value = state.bloom;
    u.uTime.value += dt;
    u.uPointer.value.copy(state.pointer);
    u.uPointerActive.value = damp(u.uPointerActive.value, state.pointerActive ? 1 : 0, 0.2, dt);
    this.group.rotation.y += dt * CONFIG.autoRotate;
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
  constructor(glCanvas, bgCanvas, video) {
    this.glCanvas = glCanvas;
    this.bgCanvas = bgCanvas;
    this.bgCtx = bgCanvas.getContext('2d', { alpha: false });
    this.video = video;

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

    /* ---------- 摄像头背景：半透明叠加 ---------- */
    this.videoTexture = new THREE.CanvasTexture(bgCanvas);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.bgMaterial = new THREE.MeshBasicMaterial({
      map: this.videoTexture,
      transparent: true,
      opacity: CONFIG.videoOpacity,
      depthWrite: false,
      depthTest: false,
    });
    this.bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMaterial);
    this.bgScene = new THREE.Scene();
    this.bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bgMesh.renderOrder = -1;
    this.bgScene.add(this.bgMesh);

    /* ---------- 花朵 ---------- */
    this.flower = new FlowerField();
    this.scene.add(this.flower.group);

    /* ---------- 星尘（彩色微光，给空间一点体积感） ---------- */
    this._buildStars();

    /* ---------- 后期：RenderPass → Bloom → Output ---------- */
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.bgScene, this.bgCamera));
    this.scenePass = new RenderPass(this.scene, this.camera);
    this.scenePass.clear = false;           // 叠在摄像头背景之上
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

  /** 把当前视频帧画进 bgCanvas（镜像），供纹理使用 */
  drawVideoFrame() {
    const v = this.video;
    const c = this.bgCanvas;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    // 节流：摄像头 30fps，渲染可能 120fps，同一帧不必重复上传
    if (v.currentTime === this._lastVideoTime) return;
    this._lastVideoTime = v.currentTime;

    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
    }
    const ctx = this.bgCtx;
    ctx.save();
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(v, 0, 0, c.width, c.height);
    ctx.restore();
    this.videoTexture.needsUpdate = true;
  }

  setVideoVisible(visible) {
    this.bgMesh.visible = visible;
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
    this.starUniforms.uPixelRatio.value = dpr;

    // 摄像头背景 cover 铺满
    const viewAspect = w / h;
    const videoAspect = (this.video.videoWidth || 4) / (this.video.videoHeight || 3);
    let sx = 1, sy = 1;
    if (viewAspect > videoAspect) {
      sy = viewAspect / videoAspect;
    } else {
      sx = videoAspect / viewAspect;
    }
    this.bgMesh.scale.set(sx, sy, 1);
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
    this.drawVideoFrame();
    this.flower.update(state, dt);
    // 花朵整体俯仰（鼠标 Y 或手势跟随）
    this.flower.group.rotation.x = damp(
      this.flower.group.rotation.x, 0.42 + state.pitch, 0.12, dt
    );
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
const STORAGE_KEY = 'gesture-flower.params.v1';

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

  toast(msg, ms = 3600) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  /** 每帧刷新 HUD（只写变化过的文本，避免布局抖动） */
  updateHud({ tension, bloom, hasHand, fps, mode }) {
    const tp = (tension * 100).toFixed(0);
    this.el.hudTension.textContent = tension.toFixed(3);
    this.el.barTension.style.width = tp + '%';
    this.el.hudBloom.textContent = bloom.toFixed(3);
    this.el.barBloom.style.width = (bloom * 100).toFixed(0) + '%';
    this.el.hudHand.textContent = mode === 'mouse' ? '鼠标接管' : (hasHand ? '已识别' : '未识别');
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
    this.targetTension = 0.5;

    this.tension = new TensionMeter();

    this.stage = new Stage($('gl'), $('bg'), $('video'));
    this.stage.flower.setCount(params.particleCount);

    this.mouse = new MouseController($('gl'), this.stage);
    this.mouse.dot = null;

    this.handTracker = new HandTracker({
      video: $('video'),
      overlay: $('overlay'),
      onResults: (lm, info) => {
        this.landmarks = lm;
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
    this.handTracker.overlay.style.opacity = isMouse ? '0' : '1';
    this.ui.syncModeButtons();
    this.ui.toast(isMouse ? '鼠标模式：左右移动控制绽放，滚轮缩放，拖拽旋转' : '手势模式：举起手，张开/握拳');
  }

  _fallbackToMouse(msg) {
    this.mode = 'mouse';
    this.mouse.enable(true);
    this.stage.setVideoVisible(false);
    this.handTracker.overlay.style.opacity = '0';
    this.ui.syncModeButtons();
    this.ui.setCameraBadge('摄像头不可用', true);
    this.ui.toast(msg, 4200);
  }

  /* ---------------- 摄像头 ---------------- */

  async _startCamera() {
    try {
      this.ui.setCameraBadge('正在连接摄像头…', false);
      await this.handTracker.start();
      this.ui.setCameraBadge('摄像头就绪', false);
      this.mode = 'hand';
      this.mouse.enable(false);
      this.stage.setVideoVisible(true);
      this.handTracker.overlay.style.opacity = '1';
      this.ui.syncModeButtons();
      return true;
    } catch (err) {
      console.warn('[camera]', err);
      this.ui.setCameraBadge('摄像头不可用', true);
      this.ui.toast(String(err.message || err), 6000);
      return false;
    }
  }

  async _maybeStartCamera() {
    const ok = await this._startCamera();
    if (!ok) this._fallbackToMouse('未拿到摄像头权限，已进入鼠标模式（按 M 可重试手势模式）');
  }

  retryCamera() {
    this.ui.toast('正在重试摄像头…', 1800);
    this._maybeStartCamera();
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
      this.tension.update(this.landmarks, dt);
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

    /* ---------- ③ 指尖 / 鼠标的世界坐标（近似） ---------- */
    const ptr = this.stage.flower.uniforms.uPointer.value;
    if (pointerActive) {
      // 把归一化屏幕坐标粗略映射到花朵附近
      ptr.set(
        (this.handTracker.pointer.x - 0.5) * 5.2,
        (0.5 - this.handTracker.pointer.y) * 3.4 + 0.6,
        1.4
      );
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
      pointer: ptr,
      pointerActive: this.mode === 'mouse' ? this.mouse.hasCursor : pointerActive,
      pitch: this.mode === 'mouse' ? this.mouse.pitch : (this.handTracker.pointer.y - 0.5) * 0.4,
    });

    /* ---------- ⑤ HUD ---------- */
    this.ui.updateHud({
      tension: isHand ? this.tension.value : this.mouse.tension,
      bloom: this.spread,
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