/**
 * 档位与条目规则表。
 *
 * 来源：腾盘方案文档与提权快照的目录清单。
 * 每条 status:'verified' 的规则都已在 2026-10-03 提权快照（594,050 行）上逐条核对过，
 * 实测值与方案标注值一致或差异已解释。
 *
 * status 取值：
 *   verified   —— 匹配规则已核对，实测值与方案标注可对照
 *   unresolved —— 方案有标注，但快照中找不到能唯一对应的路径，看板如实标注、不猜测
 */

import { homedir } from 'node:os';

/**
 * 用户家目录前缀。凡是落在用户目录下的规则路径都由此在运行时拼接，
 * 不把本机用户名写死进代码（公开仓库不宜携带个人路径）。
 * 规则里的路径比较一律走小写形式，与快照里 path.toLowerCase() 的口径一致。
 */
const USER_HOME = homedir().replace(/[\\/]+$/, '');

/** 家目录前缀（小写），用于 prefix 规则匹配。 */
export const USER_HOME_PREFIX_LOWER = `${USER_HOME}\\`.toLowerCase();

/** 家目录前缀（原样大小写），用于界面显示的真实路径。 */
export const USER_HOME_PREFIX = `${USER_HOME}\\`;

export const TIERS = [
  {
    id: 'T1',
    label: 'T1 直接删',
    planTotalGB: 9.47,
    risk: '无风险',
    action: '删除',
    reclaimable: true,
    note: '纯缓存、崩溃日志、已安装程序的安装包。删除后系统或软件会自动重建，无功能损失。',
  },
  {
    id: 'T2',
    label: 'T2 缓存重建',
    planTotalGB: 9.83,
    risk: '低',
    action: '删除',
    reclaimable: true,
    note: '包管理缓存。删除后下次安装依赖时重新下载，不影响已有项目与代码。',
  },
  {
    id: 'T3',
    label: 'T3 需确认',
    planTotalGB: 20.93,
    risk: '中',
    action: '确认后处理',
    reclaimable: true,
    note: '含个人数据（聊天记录、下载件）。建议迁移而非删除，需逐项确认。',
  },
  {
    id: 'T4',
    label: 'T4 勿动',
    planTotalGB: 22.2,
    risk: '高',
    action: '不要手动处理',
    reclaimable: false,
    note: '系统核心与组件库。手动删除会损坏系统或丢失权限，只能用 DISM 等官方方式清理。',
  },
  {
    id: 'M1',
    label: 'M1 推荐迁移',
    planTotalGB: 13.48,
    risk: '低',
    action: '迁移',
    reclaimable: true,
    note: '官方支持的迁移方式：移动目录后在原位置建目录联接，对软件完全透明。',
  },
  {
    id: 'M2',
    label: 'M2 可选迁移',
    planTotalGB: 21.7,
    risk: '中',
    action: '迁移',
    reclaimable: true,
    note: '需要在软件设置里改存储位置，部分项目不推荐迁移。',
  },
  {
    id: 'M3',
    label: 'M3 系统调整',
    planTotalGB: 0.0,
    risk: '中',
    action: '系统调整',
    reclaimable: false,
    note: '需管理员权限或重启（休眠文件、页面文件、Office 重装）。方案按「立即可回收」计为 0 GB，下方实测值为这些文件的真实占用。',
  },
];

/** 每个条目可出现在多个档位（例如 npm 缓存既是 T2 删除候选、也是 M1 迁移候选）。 */
export const BUCKETS = [
  // ---------- T1 直接删 ----------
  {
    id: 'recycle',
    name: '回收站',
    tiers: ['T1'],
    action: '清空',
    match: { type: 'prefix', value: 'c:\\$recycle.bin\\' },
    planGB: 0.93,
    planFiles: 7271,
    status: 'verified',
    note: '含已删除的数据库文件等，清空即回收。',
  },
  {
    id: 'temp_user',
    name: '用户临时文件',
    tiers: ['T1'],
    action: '清空',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + 'appdata\\local\\temp\\' },
    planGB: 1.61,
    planFiles: 4235,
    status: 'verified',
    note: '被进程占用中的文件删不掉，跳过即可，不影响清理效果。',
  },
  {
    id: 'win_systemtemp',
    name: 'Windows 系统临时',
    tiers: ['T1'],
    action: '清空',
    match: { type: 'prefix', value: 'c:\\windows\\systemtemp\\' },
    planGB: 0.77,
    planFiles: 1708,
    status: 'verified',
    note: '系统自动重建。',
  },
  {
    id: 'amd_dxcache',
    name: 'AMD 着色器缓存',
    tiers: ['T1'],
    action: '清空',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + 'appdata\\local\\amd\\dxccache\\' },
    planGB: 2.08,
    planFiles: 134,
    status: 'verified',
    note: '首次渲染时重建，之后会自动长回来。',
  },
  {
    id: 'delivery_opt',
    name: '传递优化缓存',
    tiers: ['T1'],
    action: '清空',
    match: {
      type: 'prefix',
      value:
        'c:\\windows\\serviceprofiles\\networkservice\\appdata\\local\\microsoft\\windows\\deliveryoptimization\\cache\\',
    },
    planGB: 2.88,
    planFiles: 22,
    status: 'verified',
    note: 'Windows 更新的 P2P 分发缓存。',
  },
  {
    id: 'wu_download',
    name: '更新下载缓存',
    tiers: ['T1'],
    action: '清空',
    match: { type: 'prefix', value: 'c:\\windows\\softwaredistribution\\download\\' },
    planGB: 0.44,
    planFiles: 7,
    status: 'verified',
    note: '已安装更新的安装包残留。',
  },
  {
    id: 'kernel_dmp',
    name: '内核崩溃日志',
    tiers: ['T1'],
    action: '清空',
    match: { type: 'prefix', value: 'c:\\windows\\livekernelreports\\' },
    planGB: 0.57,
    planFiles: 25,
    status: 'verified',
    note: '25 个 dmp 转储文件。',
  },
  {
    id: 'c_temp',
    name: 'Temp 安装包目录',
    tiers: ['T1'],
    action: '清空',
    match: { type: 'prefix', value: 'c:\\temp\\' },
    planGB: 0.19,
    planFiles: 7,
    status: 'verified',
    note: '含若干已下载的安装程序。',
  },

  // ---------- T2 缓存重建 ----------
  {
    id: 'npm_cache',
    name: 'npm 缓存',
    tiers: ['T2', 'M1'],
    action: '清空 / 或迁移',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + 'appdata\\local\\npm-cache\\' },
    planGB: 2.62,
    planFiles: 29331,
    status: 'verified',
    note: '与 M1 重叠：删除或迁移二选一，别两边都算。',
  },
  {
    id: 'pnpm_store',
    name: 'pnpm 内容寻址库',
    tiers: ['T2'],
    action: '修剪',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + 'appdata\\local\\pnpm\\' },
    planGB: 2.07,
    planFiles: 15311,
    status: 'verified',
    note: '若 pnpm store 已经迁移到其它目录，这里的旧库可整体删。',
  },
  {
    id: 'pnpm_cache_old',
    name: 'pnpm 旧缓存',
    tiers: ['T2'],
    action: '修剪',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + 'appdata\\local\\pnpm-cache\\' },
    planGB: 0.63,
    planFiles: 3302,
    status: 'verified',
    note: '与 pnpm 内容寻址库分开统计，两者是不同目录。',
  },
  {
    id: 'pip_cache',
    name: 'pip 缓存',
    tiers: ['T2', 'M1'],
    action: '清空 / 或迁移',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + 'appdata\\local\\pip\\' },
    planGB: 0.81,
    planFiles: 626,
    status: 'verified',
    note: '与 M1 重叠：删除或迁移二选一。',
  },
  {
    id: 'playwright',
    name: 'playwright 内核',
    tiers: ['T2', 'M1'],
    action: '删除 / 或迁移',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + 'appdata\\local\\ms-playwright\\' },
    planGB: 1.17,
    planFiles: 772,
    status: 'verified',
    note: '与 M1 重叠；删除后需要重新下载约 1.2GB 内核。',
  },
  {
    id: 'puppeteer',
    name: 'puppeteer 内核',
    tiers: ['T2'],
    action: '删除',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + '.cache\\' },
    planGB: 0.67,
    planFiles: 602,
    status: 'verified',
    note: '含 chrome 148 内核。',
  },
  {
    id: 'vsix',
    name: 'VSIX 安装包副本',
    tiers: ['T2'],
    action: '删除',
    match: {
      type: 'prefix',
      value: USER_HOME_PREFIX_LOWER + 'appdata\\roaming\\code\\cachedextensionvsixs\\',
    },
    planGB: 1.86,
    planFiles: 43,
    status: 'verified',
    note: '扩展已经解包，这些 .vsix 副本可删。注意它同时被 M1 的「VSCode 用户数据」包含。',
  },

  // ---------- T3 需确认 ----------
  {
    id: 'edge_dbg',
    name: 'Edge 调试 profile',
    tiers: ['T3'],
    action: '确认后删',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + '.edge-debug-profile\\' },
    planGB: 0.8,
    planFiles: 4370,
    status: 'verified',
    note: '自动化调试残留，删掉后下次运行会重建空 profile。',
  },
  {
    id: 'edge_profile',
    name: 'Edge 自带 profile',
    tiers: ['T3'],
    action: '确认后删',
    match: null,
    planGB: 0.02,
    planFiles: 240,
    status: 'unresolved',
    note: '方案标注 0.02GB / 240 文件，但快照中找不到能唯一对应的路径（已排除 .edge-debug-profile 与 edge_wechat_profile）。看板不猜测，故不计入实测。',
  },
  {
    id: 'wechat',
    name: '微信记录 / 接收文件',
    tiers: ['T3', 'M2'],
    action: '改存储位置 / 迁移',
    match: { type: 'contains', value: '\\xwechat_files\\' },
    planGB: 7.66,
    planFiles: 16755,
    status: 'verified',
    note: '个人数据，建议迁移而非删除：微信「设置 → 文件管理 → 更改存储位置」选一个非系统盘的空目录。',
  },
  {
    id: 'qq',
    name: 'QQ 记录 / 接收文件',
    tiers: ['T3', 'M2'],
    action: '改存储位置 / 迁移',
    match: { type: 'contains', value: '\\tencent files\\' },
    planGB: 11.12,
    planFiles: 37291,
    status: 'verified',
    note: '个人数据，建议迁移而非删除：QQ 设置里把存储位置改到非系统盘的空目录。',
  },
  {
    id: 'downloads',
    name: 'Downloads 安装包',
    tiers: ['T3'],
    action: '挑删',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + 'downloads\\' },
    planGB: 1.14,
    planFiles: 231,
    status: 'verified',
    note: '6 个安装包 + 1 个音频，约 1.0GB，需要逐个挑。',
  },
  {
    id: 'dsh_installer',
    name: 'DSH 安装包',
    tiers: ['T3'],
    action: '确认后删',
    match: null,
    planGB: 0.19,
    planFiles: 4,
    status: 'unresolved',
    note: '方案标注 0.19GB / 4 文件。快照中 C:\\Temp 整体为 0.19GB / 7 文件（已计入 T1「Temp 安装包目录」），其中 C:\\Temp 下的某个安装程序子目录为 0.187GB / 1 文件；Downloads 下另有一个安装包（0.269GB，已含在 Downloads 条目内）。三处重叠，无法唯一对应，故不重复计入实测。',
  },

  // ---------- T4 勿动 ----------
  {
    id: 'winsxs',
    name: 'WinSxS 组件库',
    tiers: ['T4'],
    action: '只走 DISM',
    match: { type: 'prefix', value: 'c:\\windows\\winsxs\\' },
    planGB: 7.86,
    planFiles: 67895,
    status: 'verified',
    note: '只能用 DISM /Online /Cleanup-Image /StartComponentCleanup，手删会损坏系统。',
  },
  {
    id: 'installer',
    name: 'Windows Installer 缓存',
    tiers: ['T4'],
    action: '勿删',
    match: { type: 'prefix', value: 'c:\\windows\\installer\\' },
    planGB: 0.31,
    planFiles: 91,
    status: 'verified',
    note: '卸载或修复程序时要用。',
  },
  {
    id: 'winre',
    name: 'WinRE 恢复镜像',
    tiers: ['T4'],
    action: '勿删',
    match: { type: 'prefix', value: 'c:\\recovery\\' },
    planGB: 0.74,
    planFiles: 5,
    status: 'verified',
    note: '删掉后无法进入系统修复模式。',
  },
  {
    id: 'storeapps',
    name: '商店应用',
    tiers: ['T4'],
    action: '勿动',
    match: { type: 'prefix', value: 'c:\\program files\\windowsapps\\' },
    planGB: 2.81,
    planFiles: 20251,
    status: 'verified',
    note: '手动改动会丢失权限。',
  },
  {
    id: 'syscore',
    name: '系统核心',
    tiers: ['T4'],
    action: '勿动',
    match: { type: 'prefix', value: 'c:\\windows\\system32\\' },
    planGB: 7.78,
    planFiles: 17305,
    status: 'verified',
    note: '系统核心文件。',
  },
  {
    id: 'python312',
    name: 'Python 3.12',
    tiers: ['T4'],
    action: '勿动勿移',
    match: {
      type: 'prefix',
      value: USER_HOME_PREFIX_LOWER + 'appdata\\local\\programs\\python\\python312\\',
    },
    planGB: 2.71,
    planFiles: 68330,
    status: 'verified',
    note: '有本地脚本硬编码了这个路径，移动会导致它失效。',
  },

  // ---------- M1 推荐迁移 ----------
  {
    id: 'vscode_ext',
    name: 'VSCode 扩展',
    tiers: ['M1'],
    action: '迁移',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + '.vscode\\' },
    planGB: 5.37,
    planFiles: 54964,
    status: 'verified',
    note: '关掉 VS Code → 移到非系统盘的扩展目录 → 原位置 mklink /J 建联接。',
  },
  {
    id: 'vscode_user',
    name: 'VSCode 用户数据',
    tiers: ['M1'],
    action: '迁移',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + 'appdata\\roaming\\code\\' },
    planGB: 3.5,
    planFiles: 7273,
    status: 'verified',
    note: '含约 1.5GB 语音模型缓存。它内部还包含 T2 的 VSIX 副本，两处数字会重叠。',
  },

  // ---------- M2 可选迁移 ----------
  {
    id: 'py_userlib',
    name: 'Python 用户库',
    tiers: ['M2'],
    action: '不推荐迁移',
    match: null,
    planGB: 2.57,
    planFiles: null,
    status: 'unresolved',
    note: '方案标注 2.57GB，但快照中不存在 AppData\\Roaming\\Python。T4「Python 3.12」实测 2.71GB 很可能就是它的来源，两者重叠，故不单独计入实测。',
  },
  {
    id: 'gradle',
    name: '梯度缓存',
    tiers: ['M2'],
    action: '可迁移',
    match: { type: 'prefix', value: USER_HOME_PREFIX_LOWER + '.gradle\\' },
    planGB: 0.35,
    planFiles: 6012,
    status: 'verified',
    note: '设 GRADLE_USER_HOME 环境变量即可迁移。',
  },

  // ---------- M3 系统调整 ----------
  {
    id: 'pagefile',
    name: '页面文件',
    tiers: ['M3'],
    action: '调小或移盘',
    match: { type: 'equals', value: 'c:\\pagefile.sys' },
    planGB: 10.0,
    planFiles: 1,
    status: 'verified',
    note: '不建议完全关闭；可改为固定大小（如 4096MB）或移到其它盘（需重启）。',
  },
  {
    id: 'hiberfil',
    name: '休眠文件',
    tiers: ['M3'],
    action: '关闭休眠',
    match: { type: 'equals', value: 'c:\\hiberfil.sys' },
    planGB: 5.48,
    planFiles: 1,
    status: 'verified',
    note: '用不到休眠则管理员执行 powercfg /h off，可整体释放。',
  },
  {
    id: 'office',
    name: 'Office 安装',
    tiers: ['M3'],
    action: '重装到 F:',
    match: { type: 'prefix', value: 'c:\\program files\\microsoft office\\' },
    planGB: 4.3,
    planFiles: 10821,
    status: 'verified',
    note: '重装到其它盘能省出一些空间，但需要重新安装。',
  },
];

/**
 * 条目的真实路径。仅用于界面显示与「重叠扣除」的包含关系判断；
 * 是否命中仍以上面的 match 规则为准。source 标明该路径的来历：
 *   snapshot —— 从快照中直接观察到
 *   plan     —— 取自方案文本
 */
export const BUCKET_PATHS = {
  recycle: ['C:\\$Recycle.Bin', 'plan'],
  temp_user: [USER_HOME_PREFIX + 'AppData\\Local\\Temp', 'snapshot'],
  win_systemtemp: ['C:\\Windows\\SystemTemp', 'snapshot'],
  amd_dxcache: [USER_HOME_PREFIX + 'AppData\\Local\\AMD\\DxcCache', 'snapshot'],
  delivery_opt: [
    'C:\\Windows\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\Cache',
    'snapshot',
  ],
  wu_download: ['C:\\Windows\\SoftwareDistribution\\Download', 'snapshot'],
  kernel_dmp: ['C:\\Windows\\LiveKernelReports', 'snapshot'],
  c_temp: ['C:\\Temp', 'snapshot'],
  npm_cache: [USER_HOME_PREFIX + 'AppData\\Local\\npm-cache', 'snapshot'],
  pnpm_store: [USER_HOME_PREFIX + 'AppData\\Local\\pnpm', 'snapshot'],
  pnpm_cache_old: [USER_HOME_PREFIX + 'AppData\\Local\\pnpm-cache', 'snapshot'],
  pip_cache: [USER_HOME_PREFIX + 'AppData\\Local\\pip', 'snapshot'],
  playwright: [USER_HOME_PREFIX + 'AppData\\Local\\ms-playwright', 'snapshot'],
  puppeteer: [USER_HOME_PREFIX + '.cache', 'snapshot'],
  vsix: [USER_HOME_PREFIX + 'AppData\\Roaming\\Code\\CachedExtensionVSIXs', 'snapshot'],
  edge_dbg: [USER_HOME_PREFIX + '.edge-debug-profile', 'snapshot'],
  wechat: [USER_HOME_PREFIX + 'OneDrive\\文档\\xwechat_files', 'snapshot'],
  qq: [USER_HOME_PREFIX + 'OneDrive\\文档\\Tencent Files', 'snapshot'],
  downloads: [USER_HOME_PREFIX + 'Downloads', 'snapshot'],
  winsxs: ['C:\\Windows\\WinSxS', 'snapshot'],
  installer: ['C:\\Windows\\Installer', 'snapshot'],
  winre: ['C:\\Recovery', 'snapshot'],
  storeapps: ['C:\\Program Files\\WindowsApps', 'snapshot'],
  syscore: ['C:\\Windows\\System32', 'snapshot'],
  python312: [USER_HOME_PREFIX + 'AppData\\Local\\Programs\\Python\\Python312', 'snapshot'],
  vscode_ext: [USER_HOME_PREFIX + '.vscode', 'snapshot'],
  vscode_user: [USER_HOME_PREFIX + 'AppData\\Roaming\\Code', 'snapshot'],
  gradle: [USER_HOME_PREFIX + '.gradle', 'snapshot'],
  pagefile: ['C:\\pagefile.sys', 'snapshot'],
  hiberfil: ['C:\\hiberfil.sys', 'snapshot'],
  office: ['C:\\Program Files\\Microsoft Office', 'snapshot'],
};

for (const bucket of BUCKETS) {
  const entry = BUCKET_PATHS[bucket.id];
  bucket.path = entry ? entry[0] : null;
  bucket.pathSource = entry ? entry[1] : null;
}

/** 按输入顺序做「首个命中」匹配，用于目录标注等只需一个归属的场景。 */
export function firstBucketFor(lowerPath) {
  for (const bucket of BUCKETS) {
    if (matchBucket(bucket, lowerPath)) return bucket;
  }
  return null;
}

export function matchBucket(bucket, lowerPath) {
  const rule = bucket.match;
  if (!rule) return false;
  if (rule.type === 'prefix') return lowerPath.startsWith(rule.value);
  if (rule.type === 'contains') return lowerPath.includes(rule.value);
  if (rule.type === 'equals') return lowerPath === rule.value;
  return false;
}

/** 用于「目录是否整体落在某个档位内」判断。 */
export function bucketForDir(dirPath) {
  const lower = dirPath.toLowerCase().replace(/\\+$/, '');
  for (const bucket of BUCKETS) {
    if (!bucket.match) continue;
    if (bucket.match.type === 'equals') continue;
    if (matchBucket(bucket, lower + '\\')) return bucket;
  }
  return null;
}

export const BUCKET_BY_ID = new Map(BUCKETS.map((bucket) => [bucket.id, bucket]));
