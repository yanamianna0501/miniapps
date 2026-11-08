// @ts-check
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getJson } from './http-client.mjs';

const execFileAsync = promisify(execFile);

const PROXIES = {
  'google-pro-local': {
    name: 'Google Pro 本机网关',
    port: 8317,
    script: 'F:\\Zcode项目\\杂项\\google-pro-gateway\\start-gateway.ps1',
    healthPath: '/v1/models',
    getArgs(action) {
      if (action === 'stop') return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-Stop'];
      return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script];
    },
    async inspect() {
      // 快速探测 8317 端口健康度
      try {
        const res = await getJson(`http://127.0.0.1:${this.port}${this.healthPath}`, {}, AbortSignal.timeout(1500));
        if (res.status === 200 || res.status === 401) {
          return { running: true, port: this.port, pid: null };
        }
      } catch {
        // 端口未响应
      }
      return { running: false, port: this.port, pid: null };
    },
  },
  'workbuddy-local': {
    name: 'WorkBuddy 本机代理',
    port: 18789,
    // v3：普通 Node 启动 + DPAPI 密钥库离线解密，不再依赖 WorkBuddy 客户端进程
    script: 'F:\\Zcode项目\\杂项\\WorkBuddy代理\\manage_v3.ps1',
    healthPath: '/health',
    getArgs(action) {
      return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script, action];
    },
    async inspect() {
      try {
        const res = await getJson(`http://127.0.0.1:${this.port}${this.healthPath}`, {}, AbortSignal.timeout(1500));
        if (res.status === 200) {
          const json = JSON.parse(res.body);
          if (json.status === 'ok' && json.service === 'workbuddy-local') {
            return { running: true, port: this.port, pid: json.pid || null };
          }
        }
      } catch {
        // 端口未响应
      }
      return { running: false, port: this.port, pid: null };
    },
  },
};

export function isProxySupported(providerId) {
  return Object.prototype.hasOwnProperty.call(PROXIES, providerId);
}

export async function getProxyStatus(providerId) {
  const cfg = PROXIES[providerId];
  if (!cfg) return null;
  const status = await cfg.inspect();
  return {
    supported: true,
    name: cfg.name,
    port: cfg.port,
    running: status.running,
  };
}

export async function executeProxyControl(providerId, action) {
  if (!['start', 'stop'].includes(action)) {
    throw new Error('操作类型无效，仅支持启动或停止');
  }
  const cfg = PROXIES[providerId];
  if (!cfg) {
    throw new Error(`服务商 ${providerId} 不是受支持的本地反代`);
  }

  const pwshPath = 'pwsh.exe';
  const args = cfg.getArgs(action);

  try {
    const result = await execFileAsync(pwshPath, args, {
      windowsHide: true,
      timeout: 35000,
    });
    // 操作完成后重新检查
    const current = await cfg.inspect();
    const actionLabel = action === 'start' ? '启动' : '停止';
    const expected = action === 'start';
    if (current.running !== expected) {
      throw new Error(`${cfg.name} 执行了${actionLabel}脚本，但目标状态未达到预期（当前状态: ${current.running ? '运行中' : '已停止'}）`);
    }
    return {
      ok: true,
      action,
      running: current.running,
      message: `${cfg.name} 已${actionLabel}`,
      stdout: result.stdout?.slice(0, 200),
    };
  } catch (error) {
    const msg = error?.stderr?.trim() || error?.message || '执行失败';
    throw new Error(`${cfg.name} ${action === 'start' ? '启动' : '停止'}失败: ${msg.slice(0, 160)}`);
  }
}
